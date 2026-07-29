# -*- coding: utf-8 -*-
"""Moving tasks around: the dependency cascade, the gantt gesture API and the
compaction pass.

Split out of ``project_task.py`` — same model, one concern per file, the way
``project_task_scheduler`` / ``project_task_calendar`` already are. Nothing here
may write dates by translating a wall-clock window: a task's end is derived from
its scheduled hours through the work calendar (see ``_plan_dates_from`` and
friends in ``project_task.py``), and raw writes go through ``_write_raw``.
"""
from odoo import models, fields, api, _
from datetime import timedelta
from odoo.exceptions import UserError
import pytz
import logging

_logger = logging.getLogger(__name__)


class ProjectTaskNativeCascade(models.Model):
    _inherit = 'project.task'

    def _build_outbound_pred_map(self):
        """Prefetch outbound predecessor links keyed by parent_task_id.

        A date cascade never changes the dependency topology (only task dates),
        so the link graph can be loaded once and reused across the whole
        traversal instead of issuing one Pred.search() per visited task (N+1).
        """
        project_ids = self.mapped('project_id').ids
        if not project_ids:
            return {}
        Pred = self.env['project.task.predecessor']
        preds = Pred.search([('parent_task_id.project_id', 'in', project_ids)])
        ids_by_parent = {}
        for pred in preds:
            ids_by_parent.setdefault(pred.parent_task_id.id, []).append(pred.id)
        return {pid: Pred.browse(ids) for pid, ids in ids_by_parent.items()}

    def _cascade_dependency_push(self, visited=None, pred_map=None):
        """Push dependent tasks when date changes create overlap.
        Called from write() for non-gantt operations (e.g. list view edits).

        Thin wrapper over the single canonical cascade engine
        ``_cascade_fs_push`` (relaxation BFS, all four link types, duration
        preserved, converges in a single pass). Previously this was a second,
        near-duplicate recursive implementation; the two were merged so
        write()-triggered cascades (list-view edits) and gantt-triggered cascades
        share ONE engine and ONE traversal — no duplicate or nested passes.

        ``pred_map`` is forwarded so a caller that already prefetched the link
        graph avoids rebuilding it.
        """
        return self._cascade_fs_push(visited, pred_map=pred_map)

    def _get_ancestor_fs_min_start(self, task):
        """Get the strictest predecessor boundary for a task's start date,
        walking up the full ancestor chain. Considers both FS and SS types:
        - FS: target.start >= source.end
        - SS: target.start >= source.start
        Returns the latest boundary date, or False if unconstrained.
        """
        fs_min = False
        current = task
        visited = set()
        while current and current.id not in visited:
            visited.add(current.id)
            for pred in current.predecessor_ids:
                if not pred.parent_task_id:
                    continue
                src = pred.parent_task_id
                boundary = False
                if pred.type == 'FS':
                    boundary = src.summary_date_end if src.child_ids else src.date_end
                elif pred.type == 'SS':
                    boundary = src.summary_date_start if src.child_ids else src.date_start
                if boundary and (not fs_min or boundary > fs_min):
                    fs_min = boundary
            current = current.parent_id
        return fs_min

    _CLAMP_MAX_DEPTH = 50

    def _clamp_children_to_fs_boundary(self, parent, fs_min, _depth=0):
        """Push any children whose start is before fs_min forward to fs_min,
        preserving each child's duration.

        For sub-parent tasks: recursively clamp their children instead of
        blindly shifting the entire subtree, so that leaf tasks with their
        own FS/SS predecessor constraints are respected.
        """
        if _depth >= self._CLAMP_MAX_DEPTH:
            _logger.warning(
                "Max recursion depth (%d) reached in _clamp_children_to_fs_boundary "
                "for parent task %s (id=%s). Stopping recursion.",
                self._CLAMP_MAX_DEPTH, parent.display_name, parent.id)
            return
        for child in parent.child_ids:
            if child.child_ids:
                # Sub-parent: check its summary start
                child_start = child.summary_date_start
            else:
                child_start = child.date_start
            if not child_start or child_start >= fs_min:
                continue
            # This child violates the boundary — clamp it
            if child.child_ids:
                # Recursively clamp sub-parent's children so that each
                # leaf's own predecessor constraints are checked.
                self._clamp_children_to_fs_boundary(child, fs_min, _depth=_depth + 1)
                # After recursive clamp, let _update_ancestor_dates
                # recalculate the sub-parent's span from its children.
                child._update_ancestor_dates()
            else:
                # Leaf task: check if it has its own predecessor constraints
                leaf_min = self._get_ancestor_fs_min_start(child)
                effective_min = fs_min
                if leaf_min and leaf_min > fs_min:
                    # Leaf's own constraint is stricter — use that instead
                    effective_min = leaf_min
                elif leaf_min and leaf_min > child_start:
                    # Leaf's constraint pulls it forward but not as far as fs_min
                    # Still use fs_min as the boundary (parent constraint wins)
                    effective_min = fs_min

                # Land on the calendar like every other move: the clamp relocates
                # the task, it does not re-plan it, so the task keeps the hours it
                # was scheduled for and its end is re-derived through the work
                # calendar. ``effective_min`` is a predecessor's END — typically
                # 17:00 — so translating the old wall-clock window from it puts
                # the child in the evening and silently changes its work hours.
                new_start, new_end = child._plan_dates_from(effective_min)
                if not new_start:
                    dur = (child.date_end - child.date_start) if child.date_end and child.date_start else timedelta(0)
                    new_start, new_end = effective_min, effective_min + dur
                child.with_context(skip_date_snap=True).write({
                    'date_start': new_start,
                    'date_end': new_end,
                })

    def _collect_descendants(self):
        """Return all descendant tasks (children, recursively), excluding self.
        Cycle-guarded via a visited set."""
        self.ensure_one()
        descendants = self.env['project.task']
        visited = {self.id}
        stack = list(self.child_ids)
        while stack:
            task = stack.pop()
            if task.id in visited:
                continue
            visited.add(task.id)
            descendants |= task
            stack.extend(task.child_ids)
        return descendants

    def action_move_with_descendants(self, shift_hours):
        """Move this task and all descendants by shift_hours (float).
        Preserves relative positions. Writes raw (``_write_raw``) to avoid
        recursive ancestor updates until the end."""
        self.ensure_one()
        self.check_access('write')
        delta = timedelta(hours=shift_hours)
        all_tasks = self._collect_descendants()
        # Move descendants first (skip ancestor update via super)
        for task in all_tasks:
            vals = {}
            if task.date_start:
                vals['date_start'] = task.date_start + delta
            if task.date_end:
                vals['date_end'] = task.date_end + delta
            # Planning mode: shift plan_offset for leaf tasks without real dates
            if not task.date_start and task.plan_duration:
                vals['plan_offset'] = (task.plan_offset or 0) + shift_hours
            if vals:
                task._write_raw(vals)
        # Move self
        self_vals = {}
        if self.date_start:
            self_vals['date_start'] = self.date_start + delta
        if self.date_end:
            self_vals['date_end'] = self.date_end + delta
        # Planning mode: shift plan_offset for self if no real dates
        if not self.date_start and self.plan_duration:
            self_vals['plan_offset'] = (self.plan_offset or 0) + shift_hours
        if self_vals:
            self._write_raw(self_vals)
        # A rigid translation can drop a leaf onto an evening or a weekend.
        # Re-snap every moved leaf into working time and re-derive its end from
        # plan_duration, then roll the summary levels back up from those leaves
        # so a parent bar still spans exactly first-child-start → last-child-end.
        moved = self | all_tasks
        moved._resync_leaf_dates()
        leaves = moved.filtered(lambda t: not t.child_ids)
        if leaves:
            leaves._update_ancestor_dates()
        elif self.parent_id:
            self._update_ancestor_dates()

    # ------------------------------------------------------------------
    # Server-Side Cascade & Batch Resequence
    # ------------------------------------------------------------------

    @staticmethod
    def _gesture_snapshot(tasks):
        """Record the pre-gesture value of every diffable field."""
        return {
            t.id: {
                'date_start': t.date_start,
                'date_end': t.date_end,
                'plan_offset': t.plan_offset or 0,
                'plan_duration': t.plan_duration or 0,
                'constrain_type': t.constrain_type,
                'constrain_date': t.constrain_date,
            }
            for t in tasks
        }

    def _gesture_diff(self, tasks, snapshot):
        """Diff ``tasks`` against a :meth:`_gesture_snapshot`, in the wire format
        the gantt view applies locally: ``{task_id: {field: value}}``.

        Rows are emitted only for tasks that actually moved; each such row also
        carries the derived hour readouts so the duration column stays in step
        without a second read.
        """
        tasks.invalidate_recordset()
        task_diff = {}
        for t in tasks:
            old = snapshot.get(t.id, {})
            changed = {}
            if t.date_start != old.get('date_start'):
                changed['date_start'] = fields.Datetime.to_string(t.date_start) if t.date_start else False
            if t.date_end != old.get('date_end'):
                changed['date_end'] = fields.Datetime.to_string(t.date_end) if t.date_end else False
            if abs((t.plan_offset or 0) - old.get('plan_offset', 0)) > 0.01:
                changed['plan_offset'] = t.plan_offset or 0
            if abs((t.plan_duration or 0) - old.get('plan_duration', 0)) > 0.01:
                changed['plan_duration'] = t.plan_duration or 0
            if t.constrain_type != old.get('constrain_type'):
                changed['constrain_type'] = t.constrain_type or 'asap'
            if t.constrain_date != old.get('constrain_date'):
                changed['constrain_date'] = fields.Datetime.to_string(t.constrain_date) if t.constrain_date else False
            if changed:
                changed['working_duration'] = t.working_duration or 0
                changed['total_work_hours'] = t.total_work_hours or 0
                task_diff[t.id] = changed
        return task_diff

    def _gesture_result(self, tasks, snapshot):
        """Full gantt gesture payload: moved tasks, their ancestors' rolled-up
        hours, and every lag the move invalidated."""
        task_diff = self._gesture_diff(tasks, snapshot)
        affected_ids = list(task_diff.keys())
        pred_diff = self._cascade_recalc_lags(affected_ids) if affected_ids else {}
        self._add_ancestor_hours_to_diff(task_diff)
        return {'tasks': task_diff, 'predecessors': pred_diff}

    def action_move_and_cascade(self, vals=None, shift_hours=None):
        """Single-RPC: write → FS cascade → recalc lags → return diff.

        :param vals: {field: value} to write (leaf drag/resize)
        :param shift_hours: float hours to shift self + descendants (parent drag)
        :returns: {'tasks': {id: {field: val}}, 'predecessors': {id: {lag_hours}}}
        """
        self.ensure_one()
        self.check_access('write')
        # Whitelist: only allow fields that the frontend gantt chart needs
        ALLOWED_FIELDS = {
            'date_start', 'date_end', 'plan_offset', 'plan_duration',
            'constrain_type', 'constrain_date',
        }
        if vals:
            invalid = set(vals.keys()) - ALLOWED_FIELDS
            if invalid:
                raise UserError(_('不允許的欄位：%s') % ', '.join(invalid))
        project_tasks = self.env['project.task'].search([
            ('project_id', '=', self.project_id.id)])

        # Snapshot before mutation
        snapshot = self._gesture_snapshot(project_tasks)

        # Step 1: Apply initial change. Suppress write()'s own cascade — Step 2
        # runs the single canonical cascade explicitly, so letting write()
        # cascade here would walk the whole successor graph twice per gesture.
        if shift_hours is not None:
            self.action_move_with_descendants(shift_hours)
        elif vals:
            vals = self._normalize_gesture_vals(vals)
            self.with_context(skip_cascade_push=True).write(vals)

        # Prefetch the link graph once and share it across every cascade below.
        pred_map = self._build_outbound_pred_map()

        # Step 2: cascade from every MOVED task. For a parent move (shift_hours)
        # the descendants moved too, so seed them as well — otherwise a
        # descendant's external FS successor would not be pushed. Spurious pushes
        # are impossible (the engine only pushes on real overlap).
        seed = self
        if shift_hours is not None:
            seed = self | self._collect_descendants()
        seed._cascade_fs_push(pred_map=pred_map)

        # Step 3: Walk ancestor chain → push parent's FS successors
        current = self
        ancestor_visited = set()
        while current.parent_id:
            parent = current.parent_id
            if parent.id in ancestor_visited:
                break
            ancestor_visited.add(parent.id)
            parent._cascade_fs_push(pred_map=pred_map)
            current = parent

        # Step 4: Compute diff + recalc lags
        return self._gesture_result(project_tasks, snapshot)

    @api.model
    def action_align_dependencies(self, project_id):
        """Repair every dependency the project currently violates, in one call.

        A task that starts before its predecessors allow is pushed forward by
        the same canonical relaxation every gesture uses, so the repair lands on
        the work calendar and keeps each task's scheduled hours — which the
        client-side alignment loop this replaces did not: it wrote each task
        with ``skip_date_snap`` and a wall-clock duration, then re-pushed the
        successors from the browser's copy of the dates.

        :returns: the same {'tasks': …, 'predecessors': …} diff shape as
                  :meth:`action_move_and_cascade`.
        """
        project = self.env['project.project'].browse(project_id).exists()
        if not project:
            raise UserError(_('找不到專案。'))

        tasks = self.search([('project_id', '=', project_id)])
        if not tasks:
            return {'tasks': {}, 'predecessors': {}}
        # Checked on the TASKS, not on the project: this repairs task dates, the
        # same thing a drag does, and project.project is read-only for
        # group_project_user in stock Odoo — requiring write there would put
        # "align dependencies" behind the manager group while dragging the very
        # same task stayed open to everyone. The search above already applied
        # record rules, so only tasks the user may see are in scope.
        tasks.check_access('write')

        snapshot = self._gesture_snapshot(tasks)
        # Seed from the leaves: a summary task's dates are a readout of its
        # children, so pushing a parent directly would fight _update_ancestor_dates.
        leaves = tasks.filtered(lambda t: not t.child_ids)
        if leaves:
            leaves._cascade_fs_push()
        return self._gesture_result(tasks, snapshot)

    def _add_ancestor_hours_to_diff(self, task_diff):
        """Add every ancestor's rolled-up hours to a gantt diff.

        A summary task's total changes whenever ANY descendant's hours change —
        even when no ancestor date moved (e.g. a middle child shortens without
        touching the outline's first start / last end). Called AFTER the lag
        recalc so these rows never widen the set of tasks treated as moved.
        """
        for tid in list(task_diff.keys()):
            node = self.env['project.task'].browse(tid).parent_id
            while node:
                task_diff.setdefault(node.id, {})['total_work_hours'] = \
                    node.total_work_hours or 0
                node = node.parent_id
        return task_diff

    def _normalize_gesture_vals(self, vals):
        """Make a gantt gesture obey the work calendar before it is written.

        A leaf task's window is never free-form: it is always
        ``date_start`` (inside working time) + ``plan_duration`` working hours.

        * move (both dates sent) → keep the planned hours, snap the new start
          and re-derive the end.
        * resize (a single edge sent) → the gesture IS the hours input: read the
          resized window's working hours back into ``plan_duration``, then
          re-derive the window from it so both edges land on work boundaries.
        """
        self.ensure_one()
        if self.child_ids:
            return vals
        has_start = 'date_start' in vals
        has_end = 'date_end' in vals
        if not has_start and not has_end:
            return vals
        calendar, tz = self._work_calendar()
        if not calendar:
            return vals

        vals = dict(vals)
        new_start = fields.Datetime.to_datetime(vals.get('date_start')) or self.date_start
        new_end = fields.Datetime.to_datetime(vals.get('date_end')) or self.date_end
        if not new_start:
            return vals

        if has_start and has_end:
            # An explicit plan_duration in the same write wins over the stored
            # one (that is how a duration edit reaches this method).
            hours = vals.get('plan_duration')
            if hours is None:
                hours = self.plan_duration or 0.0
        else:
            # Resize: the new window defines the hours.
            if not new_end or new_end <= new_start:
                return vals
            start_tz = pytz.UTC.localize(new_start).astimezone(tz)
            end_tz = pytz.UTC.localize(new_end).astimezone(tz)
            hours = calendar.get_work_hours_count(start_tz, end_tz)
            if hours > 0:
                vals['plan_duration'] = hours

        if hours <= 0:
            return vals
        snapped = self._snap_start_to_work(new_start)
        vals['date_start'] = snapped
        vals['date_end'] = self._end_from_work_hours(snapped, hours)
        return vals

    def action_move_multiple_and_cascade(self, shift_hours=None):
        """Batch move multiple tasks by shift_hours, cascade FS dependencies,
        and return a unified diff.

        Unlike calling action_move_and_cascade per task, this method:
        1. Moves all tasks first (preserving relative positions)
        2. Then cascades dependencies from all moved tasks together
        3. Returns a single diff covering all changes

        :param shift_hours: float - hours to shift all tasks
        :returns: dict with 'tasks' and 'predecessors' diffs
        """
        self.check_access('write')
        if not shift_hours or abs(shift_hours) < 0.01:
            return {'tasks': {}, 'predecessors': {}}

        delta = timedelta(hours=shift_hours)

        # Snapshot: all tasks in the same project(s) as the moved tasks
        project_ids = self.mapped('project_id').ids
        project_tasks = self.env['project.task'].search([
            ('project_id', 'in', project_ids)])
        snapshot = self._gesture_snapshot(project_tasks)

        # Step 1: Move each task (with descendants if parent)
        for task in self:
            if task.child_ids:
                task.action_move_with_descendants(shift_hours)
            else:
                vals = {}
                if task.date_start:
                    vals['date_start'] = task.date_start + delta
                if task.date_end:
                    vals['date_end'] = task.date_end + delta
                if not task.date_start and task.plan_duration:
                    vals['plan_offset'] = (task.plan_offset or 0) + shift_hours
                if vals:
                    task.with_context(
                        skip_date_snap=True,
                        skip_cascade_push=True,
                    ).write(vals)

        # Prefetch the link graph once and share it across every cascade below.
        pred_map = self._build_outbound_pred_map()

        # Step 2: One combined relaxation seeded with ALL moved tasks (the engine
        # seeds its queue from each record of ``self``), so cross-task overlaps
        # converge together instead of via N independent passes.
        self._cascade_fs_push(pred_map=pred_map)

        # Step 3: Walk ancestor chains → push parent's FS successors
        ancestor_visited = set()
        for task in self:
            current = task
            while current.parent_id:
                parent = current.parent_id
                if parent.id in ancestor_visited:
                    break
                ancestor_visited.add(parent.id)
                parent._cascade_fs_push(pred_map=pred_map)
                current = parent

        # Step 4: Compute diff + recalc lags
        return self._gesture_result(project_tasks, snapshot)

    def _cascade_fs_push(self, visited=None, pred_map=None):
        """Push successors forward on overlap for all dependency types
        (FS/SS/FF/SF), preserving each target's duration. Relaxation BFS.

        Dependency push rules (scheduled mode):
        - FS: source.end > target.start → push target.start to source.end
        - SS: source.start > target.start → push target.start to source.start
        - FF: source.end > target.end → push target.end to source.end (start follows)
        - SF: source.start > target.end → push target.end to source.start (start follows)

        Relaxation: a target is re-enqueued *whenever it actually moves*, so the
        traversal converges fully in a single pass even for multi-predecessor /
        cross-level graphs (a node pushed again after it was first processed
        re-propagates to its successors). This is what lets the pushes write with
        ``skip_cascade_push=True`` — propagation is owned entirely by this queue,
        with no nested re-entry through ``write()``.

        Termination: pushes are monotonic-forward and the link graph is acyclic
        (enforced by ``project.task.predecessor._check_circular_dependency``), so
        the relaxation settles; a generous iteration cap is a backstop against a
        data anomaly (e.g. a cycle that slipped through) rather than spinning.

        :param visited: accepted for backward-compat; not used to skip relaxation
        :param pred_map: prefetched outbound link graph (shared across a batch);
                         built once here when not supplied.
        """
        from collections import deque
        # Seed with each record individually so a multi-record ``self`` (batch
        # move) runs as one combined relaxation.
        queue = deque(self)
        if pred_map is None:
            pred_map = self._build_outbound_pred_map()
        empty_preds = self.env['project.task.predecessor']
        # Backstop: monotonic-forward relaxation on a DAG pushes each node at most
        # O(V) times, so total relaxations are bounded by V·E. Derive both from
        # the dependency graph itself — V = distinct tasks that appear as a link
        # source or target (the only tasks that can ever be relaxed), E = edges —
        # giving the tight theoretical bound: it never aborts a legitimate cascade
        # and can only be reached by a cycle (excluded by
        # project.task.predecessor._check_circular_dependency). A small constant
        # margin keeps trivial graphs sane.
        total_edges = sum(len(p) for p in pred_map.values())
        node_ids = set(pred_map)
        for preds in pred_map.values():
            node_ids.update(preds.task_id.ids)
        num_nodes = len(node_ids)
        relax_count = 0
        max_relax = num_nodes * total_edges + num_nodes + total_edges + 1000

        while queue:
            current = queue.popleft()

            # All dependency types where current is the source (prefetched)
            all_preds = pred_map.get(current.id, empty_preds)
            if not all_preds:
                continue

            is_planning = self._is_planning_mode(current)

            for pred in all_preds:
                target = pred.task_id
                if not target:
                    continue
                dep_type = pred.type
                moved = False

                if is_planning:
                    push_amount = self._calc_planning_push(
                        current, target, dep_type)
                    if push_amount is None or push_amount <= 0:
                        continue
                    # FS/SS push start, FF/SF push end — both shift the leaf's
                    # plan_offset forward by push_amount (duration preserved).
                    if target.child_ids:
                        target.action_move_with_descendants(push_amount)
                    else:
                        new_offset = (target.plan_offset or 0) + push_amount
                        target.with_context(
                            skip_date_snap=True,
                            skip_cascade_push=True,
                        ).write({'plan_offset': new_offset})
                    moved = True
                else:
                    push_result = self._calc_scheduled_push(
                        current, target, dep_type)
                    if push_result is None:
                        continue
                    new_start, new_end = push_result
                    if target.child_ids:
                        tgt_start = target.summary_date_start or target.date_start
                        if tgt_start and new_start:
                            shift = (new_start - tgt_start).total_seconds() / 3600.0
                            if shift > 0:
                                target.action_move_with_descendants(shift)
                                moved = True
                    else:
                        target.with_context(
                            skip_date_snap=True,
                            skip_cascade_push=True,
                        ).write({
                            'date_start': new_start,
                            'date_end': new_end,
                        })
                        moved = True

                if not moved:
                    continue

                # Propagate ancestors, then re-enqueue the moved target so its
                # own successors relax against its new dates.
                if target.parent_id:
                    target._update_ancestor_dates()
                queue.append(target)

                relax_count += 1
                if relax_count > max_relax:
                    _logger.warning(
                        "Dependency cascade exceeded relaxation cap (%s) for "
                        "project task(s) %s — possible dependency cycle; "
                        "aborting cascade.", max_relax, self.ids)
                    return

    @staticmethod
    def _is_planning_mode(task):
        """Determine if a task is in planning mode (no real dates, has plan data).

        Centralizes the is_planning check used by _cascade_dependency_push
        and _cascade_fs_push to ensure consistent logic.
        """
        return not task.date_start and (
            task.plan_duration > 0 or
            (bool(task.child_ids) and any(
                c.plan_duration > 0 or c.plan_offset
                for c in task.child_ids
            ))
        )

    def _calc_planning_push(self, source, target, dep_type):
        """Calculate push amount (hours) for planning mode.
        Returns positive hours to push, or None if no push needed.
        """
        src_start = source._plan_effective_start() if source.child_ids else (source.plan_offset or 0)
        src_end = source._plan_effective_end() if source.child_ids else ((source.plan_offset or 0) + (source.plan_duration or 0))
        tgt_start = target._plan_effective_start() if target.child_ids else (target.plan_offset or 0)
        tgt_end = target._plan_effective_end() if target.child_ids else ((target.plan_offset or 0) + (target.plan_duration or 0))

        if dep_type == 'FS':
            # source.end > target.start → push start to source.end
            if tgt_start >= src_end:
                return None
            return src_end - tgt_start
        elif dep_type == 'SS':
            # source.start > target.start → push start to source.start
            if tgt_start >= src_start:
                return None
            return src_start - tgt_start
        elif dep_type == 'FF':
            # source.end > target.end → push end to source.end (preserve duration)
            if tgt_end >= src_end:
                return None
            return src_end - tgt_end
        elif dep_type == 'SF':
            # source.start > target.end → push end to source.start (preserve duration)
            if tgt_end >= src_start:
                return None
            return src_start - tgt_end
        return None

    def _calc_scheduled_push(self, source, target, dep_type):
        """Calculate push result for scheduled mode.
        Returns (new_start, new_end) tuple, or None if no push needed.

        For a LEAF target the new end is re-derived from ``plan_duration``
        through the work calendar (start snapped into working time), so the
        scheduled hours stay exactly what the user typed no matter how far the
        task is pushed. Only when the target has no planned hours does the push
        fall back to translating the old wall-clock window.
        """
        src_start = source.summary_date_start if source.child_ids else source.date_start
        src_end = source.summary_date_end if source.child_ids else source.date_end
        tgt_start = target.summary_date_start if target.child_ids else target.date_start
        tgt_end = target.summary_date_end if target.child_ids else target.date_end

        if not tgt_start or not tgt_end:
            return None
        dur = tgt_end - tgt_start

        def _from_start(new_start):
            """Start-driven push (FS/SS): calendar-derive the end for leaves."""
            if not target.child_ids:
                snapped, derived = target._plan_dates_from(new_start)
                if snapped:
                    return (snapped, derived)
            return (new_start, new_start + dur)

        def _from_end(new_end):
            """End-driven push (FF/SF): calendar-derive the start for leaves."""
            if not target.child_ids and (target.plan_duration or 0) > 0:
                return (target._start_from_work_hours(
                    new_end, target.plan_duration), new_end)
            return (new_end - dur, new_end)

        if dep_type == 'FS':
            if not src_end or tgt_start >= src_end:
                return None
            return _from_start(src_end)
        elif dep_type == 'SS':
            if not src_start or tgt_start >= src_start:
                return None
            return _from_start(src_start)
        elif dep_type == 'FF':
            if not src_end or tgt_end >= src_end:
                return None
            return _from_end(src_end)
        elif dep_type == 'SF':
            if not src_start or tgt_end >= src_start:
                return None
            return _from_end(src_start)
        return None

    def _cascade_recalc_lags(self, affected_ids):
        """Recalculate lag_hours for all dependency types connected to affected tasks."""
        Pred = self.env['project.task.predecessor']
        preds = Pred.search([
            '|', ('task_id', 'in', affected_ids),
            ('parent_task_id', 'in', affected_ids)])

        pred_diff = {}
        for pred in preds:
            src = pred.parent_task_id
            tgt = pred.task_id
            dep_type = pred.type
            # Same planning-mode test the cascade uses, so a SUMMARY task with
            # no dates of its own (its children carry the plan) is recognised
            # here too; the narrower "not date_start and plan_duration > 0" test
            # sent it down the scheduled branch, which then bailed out on the
            # missing dates and left the lag stale.
            is_plan = self._is_planning_mode(src)

            if is_plan:
                src_start_h = src._plan_effective_start() if src.child_ids else (src.plan_offset or 0)
                src_end_h = src._plan_effective_end() if src.child_ids else ((src.plan_offset or 0) + (src.plan_duration or 0))
                tgt_start_h = tgt._plan_effective_start() if tgt.child_ids else (tgt.plan_offset or 0)
                tgt_end_h = tgt._plan_effective_end() if tgt.child_ids else ((tgt.plan_offset or 0) + (tgt.plan_duration or 0))
                if dep_type == 'FS':
                    new_lag = tgt_start_h - src_end_h
                elif dep_type == 'SS':
                    new_lag = tgt_start_h - src_start_h
                elif dep_type == 'FF':
                    new_lag = tgt_end_h - src_end_h
                elif dep_type == 'SF':
                    new_lag = tgt_end_h - src_start_h
                else:
                    continue
            else:
                s_start = src.summary_date_start if src.child_ids else src.date_start
                s_end = src.summary_date_end if src.child_ids else src.date_end
                t_start = tgt.summary_date_start if tgt.child_ids else tgt.date_start
                t_end = tgt.summary_date_end if tgt.child_ids else tgt.date_end
                if dep_type == 'FS':
                    if not s_end or not t_start:
                        continue
                    new_lag = (t_start - s_end).total_seconds() / 3600.0
                elif dep_type == 'SS':
                    if not s_start or not t_start:
                        continue
                    new_lag = (t_start - s_start).total_seconds() / 3600.0
                elif dep_type == 'FF':
                    if not s_end or not t_end:
                        continue
                    new_lag = (t_end - s_end).total_seconds() / 3600.0
                elif dep_type == 'SF':
                    if not s_start or not t_end:
                        continue
                    new_lag = (t_end - s_start).total_seconds() / 3600.0
                else:
                    continue

            if abs(new_lag - (pred.lag_hours or 0)) > 0.001:
                pred.lag_hours = new_lag
                pred_diff[pred.id] = {'lag_hours': new_lag}

        return pred_diff

    @api.model
    def action_batch_resequence(self, task_updates, milestone_updates=None, project_id=None):
        """Single-RPC batch sorting_seq + parent_id update.

        :param task_updates: list of dicts {'id': int, 'sorting_seq': int, 'parent_id': int|False}
        :param milestone_updates: list of dicts {'id': int, 'sorting_seq': int}
        :param project_id: project ID for cross-project validation (required)
        :returns: True
        """
        if not project_id:
            raise UserError(_('必須指定專案。'))
        project = self.env['project.project'].browse(project_id).exists()
        if not project:
            raise UserError(_('找不到專案。'))
        project.check_access('write')

        task_ids = [u['id'] for u in task_updates]
        tasks_by_id = {t.id: t for t in self.browse(task_ids).exists()}
        for u in task_updates:
            task = tasks_by_id.get(u['id'])
            if not task:
                continue
            if project_id and task.project_id.id != project_id:
                continue
            vals = {'sorting_seq': u['sorting_seq']}
            if 'parent_id' in u:
                vals['parent_id'] = u['parent_id']
            task._write_raw(vals)

        if milestone_updates:
            Ms = self.env['project.milestone']
            for u in milestone_updates:
                ms = Ms.browse(u['id']).exists()
                if not ms:
                    continue
                if project_id and ms.project_id.id != project_id:
                    continue
                ms.write({'sorting_seq': u['sorting_seq']})
        return True

    def action_update_plan_duration(self, hours):
        """Set a leaf task's scheduled work hours.

        The typed hours ARE the schedule: the task keeps its start (snapped into
        working time) and its end is re-derived through the work calendar, so it
        can never finish outside office hours. The dependency cascade and the
        resulting diff are produced by the single canonical engine
        (:meth:`action_move_and_cascade`) — the caller must NOT run a second
        client-side push on top of it.

        :param float hours: planned working hours
        :returns: {'tasks': {id: {...}}, 'predecessors': {id: {...}}}
        """
        self.ensure_one()
        self.check_access('write')
        if self.child_ids:
            raise UserError(_(
                '上層任務的工時為下層任務工時的總和，不可直接編輯。'))
        vals = {'plan_duration': hours}
        if self.date_start:
            snapped = self._snap_start_to_work(self.date_start)
            vals['date_start'] = snapped
            vals['date_end'] = self._end_from_work_hours(snapped, hours)
        return self.action_move_and_cascade(vals=vals)

    def _plan_effective_start(self):
        """Effective plan start: for leaf = plan_offset; for parent = min of leaf descendants."""
        self.ensure_one()
        if not self.child_ids:
            return self.plan_offset or 0
        min_off = float('inf')
        visited = {self.id}
        stack = list(self.child_ids)
        while stack:
            child = stack.pop()
            if child.id in visited:
                continue
            visited.add(child.id)
            if child.child_ids:
                stack.extend(child.child_ids)
            else:
                off = child.plan_offset or 0
                if off < min_off:
                    min_off = off
        return min_off if min_off != float('inf') else 0

    def _plan_effective_end(self):
        """Effective plan end: for leaf = plan_offset + plan_duration; for parent = max of leaf descendants."""
        self.ensure_one()
        if not self.child_ids:
            return (self.plan_offset or 0) + (self.plan_duration or 0)
        max_end = 0
        visited = {self.id}
        stack = list(self.child_ids)
        while stack:
            child = stack.pop()
            if child.id in visited:
                continue
            visited.add(child.id)
            if child.child_ids:
                stack.extend(child.child_ids)
            else:
                end = (child.plan_offset or 0) + (child.plan_duration or 0)
                if end > max_end:
                    max_end = end
        return max_end

    def _shift_plan_leaves(self, root, shift_hours):
        """Shift plan_offset of leaf descendants only (skip parent tasks).

        Unlike action_move_with_descendants, this avoids setting negative
        plan_offset on parent tasks which would extend the frontend timeline.
        """
        stack = [root]
        while stack:
            node = stack.pop()
            if node.child_ids:
                stack.extend(node.child_ids)
            else:
                new_off = (node.plan_offset or 0) + shift_hours
                node._write_raw({
                    'plan_offset': new_off,
                })

    @api.model
    def action_compact_left(self, project_id):
        """Zero all predecessor lags and compact tasks left (CPM Early Start).
        Requires write access to the project.

        Algorithm:
        1.  Build FS dependency graph → topological sort (Kahn's) to detect cycles
        2.  (After cycle check passes) Zero ALL predecessor lag_hours (FS/SS/FF/SF)
        3b. Move root groups with no external inbound FS to T+0
            (uniform shift preserving internal relative positions)
        4.  Compact FS chains in topo order (now from shifted anchors)
        5.  Compact milestones to rightmost linked task (or T+0)
        """
        # Verify caller has write access to the project
        project = self.env['project.project'].browse(project_id).exists()
        if not project:
            raise UserError(_('找不到專案。'))
        project.check_access('write')

        tasks = self.search([('project_id', '=', project_id)])
        if not tasks:
            return True

        Pred = self.env['project.task.predecessor']
        all_preds = Pred.search([
            '|', ('task_id', 'in', tasks.ids),
            ('parent_task_id', 'in', tasks.ids)])

        # 1. Build FS dependency graph and check for cycles BEFORE any writes
        fs_preds = all_preds.filtered(lambda p: p.type == 'FS')
        preds_of = {}   # task_id -> [parent_task_id, ...]
        succs_of = {}   # parent_task_id -> [task_id, ...]
        for p in fs_preds:
            preds_of.setdefault(p.task_id.id, []).append(p.parent_task_id.id)
            succs_of.setdefault(p.parent_task_id.id, []).append(p.task_id.id)

        # 2. Topological sort (Kahn's algorithm) — detect cycles before modifying data
        from collections import deque
        involved = set(preds_of.keys()) | set(succs_of.keys())
        in_deg = {tid: len(preds_of.get(tid, [])) for tid in involved}
        queue = deque(tid for tid in involved if in_deg.get(tid, 0) == 0)
        topo = []
        while queue:
            tid = queue.popleft()
            topo.append(tid)
            for sid in succs_of.get(tid, []):
                in_deg[sid] -= 1
                if in_deg[sid] == 0:
                    queue.append(sid)

        if len(topo) < len(involved):
            _logger.warning("Circular FS dependency detected in project %s — %d tasks in cycle",
                            project_id, len(involved) - len(topo))
            raise UserError(
                _("偵測到循環 FS 依賴關係（%(count)s 個任務），請先修正後再執行壓縮。",
                  count=len(involved) - len(topo))
            )

        # 3. Zero ALL lag_hours (safe — no cycles detected)
        preds_to_zero = all_preds.filtered(lambda p: abs(p.lag_hours or 0) > 0.001)
        if preds_to_zero:
            preds_to_zero.write({'lag_hours': 0})

        # Detect mode (shared by steps 3b, 4, 5)
        any_scheduled = any(t.date_start for t in tasks if not t.child_ids)

        # Scheduled mode T+0: earliest task start
        t_zero = None
        if any_scheduled:
            all_starts = [
                t.summary_date_start if t.child_ids else t.date_start
                for t in tasks
                if (t.summary_date_start if t.child_ids else t.date_start)]
            t_zero = min(all_starts) if all_starts else fields.Datetime.now()

        task_map = {t.id: t for t in tasks}

        # 3b. Move root groups with no external inbound FS to T+0.
        #     "External inbound" = an FS predecessor whose source is
        #     outside the subtree pointing into a descendant.
        #     Groups with only internal FS (or outbound FS) are safe to
        #     shift as a unit; the subsequent FS compact (step 4) resolves
        #     internal chains from the new anchor position.
        for t in tasks:
            if t.parent_id:
                continue  # only process root tasks
            # Collect subtree IDs
            subtree_ids = {t.id}
            stack = list(t.child_ids)
            while stack:
                child = stack.pop()
                subtree_ids.add(child.id)
                stack.extend(child.child_ids)
            # Check for external inbound FS
            has_external_inbound = False
            for p in fs_preds:
                if (p.task_id.id in subtree_ids
                        and p.parent_task_id.id not in subtree_ids):
                    has_external_inbound = True
                    break
            if has_external_inbound:
                continue

            if not any_scheduled:
                # Planning mode: shift only leaf descendants' plan_offset.
                # Parent tasks' plan_offset is NOT shifted — their visual
                # position is derived from children by the frontend.
                # Using action_move_with_descendants would make parent
                # plan_offset negative, extending the timeline far left.
                current_start = t._plan_effective_start()
                if current_start > 0.01:
                    self._shift_plan_leaves(t, -current_start)
            else:
                # Scheduled mode: move to t_zero, but respect start constraints
                if not t_zero:
                    continue
                target = t_zero
                # Collect strictest constraint from ALL descendants (recursive)
                all_in_subtree = self.browse(list(subtree_ids))
                for ct in all_in_subtree:
                    if not ct.constrain_type or not ct.constrain_date:
                        continue
                    ct_start = ct.date_start
                    ct_end = ct.date_end
                    if not ct_start:
                        continue
                    # How far is this task from root's current start?
                    root_start = t.summary_date_start if t.child_ids else t.date_start
                    if not root_start:
                        continue
                    offset = (ct_start - root_start).total_seconds() / 3600.0
                    # Compute the minimum root start that respects this descendant's constraint
                    if ct.constrain_type in ('snet', 'mso'):
                        # descendant.start >= constrain_date
                        # → root.start >= constrain_date - offset
                        min_root = ct.constrain_date - timedelta(hours=offset)
                        if min_root > target:
                            target = min_root
                    elif ct.constrain_type in ('fnet', 'mfo') and ct_end:
                        dur = ct_end - ct_start
                        # descendant.end >= constrain_date
                        # → descendant.start >= constrain_date - dur
                        # → root.start >= constrain_date - dur - offset
                        min_root = ct.constrain_date - dur - timedelta(hours=offset)
                        if min_root > target:
                            target = min_root
                current_start = (
                    t.summary_date_start if t.child_ids else t.date_start)
                if not current_start or current_start <= target:
                    continue
                shift_hours = (
                    current_start - target).total_seconds() / 3600.0
                if shift_hours > 0.01:
                    t.action_move_with_descendants(-shift_hours)

        # 4. Compact FS chains (topo order, operates on shifted positions)
        for tid in topo:
            task = task_map.get(tid)
            if not task:
                continue
            pred_ids = preds_of.get(tid, [])
            if not pred_ids:
                continue  # no FS predecessors → stay put

            # Detect planning mode
            is_plan = not task.date_start and (
                task.plan_duration > 0 or (
                    task.child_ids and not task.summary_date_start))

            if is_plan:
                # Planning mode: use effective start/end (walks descendants)
                max_pred_end = 0
                for pid in pred_ids:
                    pt = task_map.get(pid)
                    if pt:
                        pt_end = pt._plan_effective_end()
                        if pt_end > max_pred_end:
                            max_pred_end = pt_end
                current_start = task._plan_effective_start()
                if current_start > max_pred_end + 0.01:
                    shift = current_start - max_pred_end
                    if task.child_ids:
                        task.action_move_with_descendants(-shift)
                    else:
                        task._write_raw({
                            'plan_offset': max_pred_end,
                        })
                        if task.parent_id:
                            task._update_ancestor_dates()
            else:
                # Scheduled mode: compare datetime via summary dates
                max_end_dt = None
                for pid in pred_ids:
                    pt = task_map.get(pid)
                    if not pt:
                        continue
                    pt_end = pt.summary_date_end if pt.child_ids else pt.date_end
                    if pt_end and (max_end_dt is None or pt_end > max_end_dt):
                        max_end_dt = pt_end
                if not max_end_dt:
                    continue
                # Respect constraints: don't compact earlier than constrain_date
                target_start = max_end_dt
                if task.constrain_type and task.constrain_date:
                    cd = task.constrain_date
                    if task.constrain_type in ('snet', 'mso'):
                        # Start can't be earlier than constraint
                        if cd > target_start:
                            target_start = cd
                    elif task.constrain_type in ('fnet', 'mfo'):
                        # End can't be earlier than constraint → derive min start
                        dur = (task.date_end - task.date_start) if task.date_end and task.date_start else timedelta(0)
                        min_start = cd - dur
                        if min_start > target_start:
                            target_start = min_start
                # Compaction only ever pulls LEFT. Letting it also push right
                # (to make it a true two-sided Early Start) does not converge:
                # a pushed task is re-snapped into working time, which moves its
                # parent's span, which moves a task that was already placed —
                # measured on this project it never settles, and a single pass
                # left FS links violated by hours. Overlaps are repaired instead
                # by the monotonic forward relaxation right after this loop,
                # which provably terminates.
                current_start = task.summary_date_start if task.child_ids else task.date_start
                if not current_start or current_start <= target_start:
                    continue
                shift_hours = (current_start - target_start).total_seconds() / 3600.0
                if shift_hours > 0.01:
                    if task.child_ids:
                        task.action_move_with_descendants(-shift_hours)
                    else:
                        # Compacting is a move, not a re-plan: the task keeps the
                        # hours it was scheduled for. Derive the window through
                        # the calendar (target_start may be 17:00 — the close of
                        # a predecessor's last working interval), otherwise
                        # compacting drops the task into the evening and its
                        # work hours silently change again.
                        new_start, new_end = task._plan_dates_from(target_start)
                        if not new_start:
                            dur = (task.date_end - task.date_start) if task.date_end and task.date_start else timedelta(0)
                            new_start, new_end = target_start, target_start + dur
                        task._write_raw({
                            'date_start': new_start,
                            'date_end': new_end,
                        })
                        if task.parent_id:
                            task._update_ancestor_dates()

        # 4a. Repair whatever step 4 could not: it only pulls left, so any FS
        #     link left OVERLAPPING (a chain that had been collapsed onto one
        #     instant, or a successor re-snapped forward into working time past
        #     its predecessor) is still violated here. Hand it to the canonical
        #     forward relaxation — pushes are monotonic, so unlike a two-sided
        #     compaction pass this settles. Measured on a real project: 4 rounds,
        #     0 links left violated, every summary task exactly spanning its
        #     first child's start → last child's end.
        leaves = tasks.filtered(lambda t: not t.child_ids)
        if leaves:
            leaves._cascade_fs_push()

        # 4b. Enforce constraints on ALL tasks after compaction.
        #     Steps 3b and 4 may have moved tasks past their constraint boundaries
        #     (e.g. action_move_with_descendants shifts entire subtrees uniformly).
        #     This pass pushes violated tasks back to their constraint date.
        if any_scheduled:
            for task in tasks:
                if task.child_ids:
                    continue  # Only fix leaf tasks; parents derive from children
                if not task.constrain_type or task.constrain_type in ('asap', 'alap'):
                    continue
                if not task.constrain_date or not task.date_start or not task.date_end:
                    continue
                task.invalidate_recordset(['date_start', 'date_end'])
                ds = task.date_start
                de = task.date_end
                cd = task.constrain_date
                dur = de - ds
                new_start = None
                if task.constrain_type in ('snet', 'mso') and ds < cd:
                    new_start = cd
                elif task.constrain_type == 'snlt' and ds > cd:
                    new_start = cd
                elif task.constrain_type in ('fnet', 'mfo') and de < cd:
                    new_start = cd - dur
                elif task.constrain_type == 'fnlt' and de > cd:
                    new_start = cd - dur
                if new_start and new_start != ds:
                    # Land on the calendar like every other move. A "no later
                    # than" constraint that falls on a non-working instant is
                    # met as closely as the calendar allows (next work start).
                    snapped, derived = task._plan_dates_from(new_start)
                    if not snapped:
                        snapped, derived = new_start, new_start + dur
                    task._write_raw({
                        'date_start': snapped,
                        'date_end': derived,
                    })
                    if task.parent_id:
                        task._update_ancestor_dates()

        # 4c. Normalize parent tasks' plan_offset/plan_duration (planning mode).
        #     Steps 3b/4 may leave parent plan_offset at wrong values
        #     (e.g. negative from action_move_with_descendants).
        #     Reset to match leaf descendants so the frontend timeline
        #     is not extended by stale parent virtual dates.
        if not any_scheduled:
            for t in tasks:
                if not t.child_ids:
                    continue
                eff_start = t._plan_effective_start()
                eff_end = t._plan_effective_end()
                eff_dur = eff_end - eff_start
                vals = {}
                if abs((t.plan_offset or 0) - eff_start) > 0.01:
                    vals['plan_offset'] = eff_start
                if abs((t.plan_duration or 0) - eff_dur) > 0.01:
                    vals['plan_duration'] = eff_dur
                if vals:
                    t._write_raw(vals)

        # 5. Compact milestones
        Milestone = self.env['project.milestone']
        milestones = Milestone.search([('project_id', '=', project_id)])
        if milestones:
            if any_scheduled:
                # Scheduled mode: set deadline_datetime from linked tasks
                for ms in milestones:
                    linked = tasks.filtered(
                        lambda t: t.milestone_id.id == ms.id)
                    if linked:
                        ends = []
                        for lt in linked:
                            e = (lt.summary_date_end if lt.child_ids
                                 else lt.date_end)
                            if e:
                                ends.append(e)
                        target_dt = max(ends) if ends else t_zero
                    else:
                        target_dt = t_zero
                    if ms.deadline_datetime != target_dt:
                        ms.write({'deadline_datetime': target_dt})
            else:
                # Planning mode: clear deadline so frontend auto-computes
                # (linked → from task virtual dates, unlinked → T+0)
                ms_with_deadline = milestones.filtered(
                    lambda m: m.deadline_datetime or m.deadline)
                if ms_with_deadline:
                    ms_with_deadline.write({
                        'deadline_datetime': False,
                        'deadline': False,
                    })

        return True
