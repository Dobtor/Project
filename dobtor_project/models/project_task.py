# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from datetime import timedelta
from dateutil.relativedelta import relativedelta
from odoo.exceptions import UserError
from odoo.addons.project.models.project_task import CLOSED_STATES
import pytz
import logging

_logger = logging.getLogger(__name__)

# Fixed namespace (classid) for pg_advisory_xact_lock(classid, objid) used to
# serialize concurrent scheduler runs per project. Arbitrary but stable.
_SCHEDULER_LOCK_NAMESPACE = 19847001


class ProjectTaskNative(models.Model):
    _inherit = 'project.task'

    @api.model
    def _get_schedule_mode(self):
        return [
            ('auto', _('自動')),
            ('manual', _('手動')),
        ]

    @api.model
    def _get_constrain_type(self):
        return [
            ('asap', _('盡早開始')),
            ('alap', _('盡晚開始')),
            ('fnet', _('完成不早於')),
            ('fnlt', _('完成不晚於')),
            ('mso', _('必須開始於')),
            ('mfo', _('必須完成於')),
            ('snet', _('開始不早於')),
            ('snlt', _('開始不晚於')),
        ]

    @api.model
    def default_get(self, fields_list):
        defaults = super().default_get(fields_list)
        project_id = self._context.get('default_project_id')
        if not project_id:
            return defaults

        project = self.env['project.project'].browse(project_id)
        if not project.exists():
            return defaults

        mapping = {
            'schedule_mode': project.task_default_schedule_mode,
            'color_gantt': project.task_default_color_gantt,
            'constrain_type': project.task_default_constrain_type,
            'fixed_calc_type': project.task_default_fixed_calc_type,
            'on_gantt': project.task_default_on_gantt,
            'plan_duration': project.task_default_duration,
        }
        for field_name, value in mapping.items():
            if field_name in fields_list:
                defaults[field_name] = value

        return defaults

    @api.model
    def _default_date_end(self):
        if 'default_project_id' in self._context:
            project_id = self._context['default_project_id']
            project = self.env['project.project'].browse(project_id)
            if not project.schedule_start:
                return False  # Planning mode: no dates

        # Subtask inherits parent's date range
        if 'default_parent_id' in self._context:
            parent = self.env['project.task'].browse(self._context['default_parent_id'])
            if parent.date_end:
                return parent.date_end

        # Odoo 18: fields.Datetime.now() returns datetime object directly
        date_end = fields.Datetime.now()
        date_end = date_end.replace(hour=0, minute=0, second=0, microsecond=0)
        date_end = date_end + timedelta(days=1)

        if 'default_project_id' in self._context:
            project_id = self._context['default_project_id']
            project = self.env['project.project'].browse(project_id)

            if project.task_default_duration != 0 and project.task_default_start != 0:
                date_end = fields.Datetime.now()
                date_end = date_end.replace(hour=0, minute=0, second=0, microsecond=0)
                date_end = date_end + timedelta(hours=project.task_default_start + project.task_default_duration)

        return date_end

    @api.model
    def _default_date_start(self):
        if 'default_project_id' in self._context:
            project_id = self._context['default_project_id']
            project = self.env['project.project'].browse(project_id)
            if not project.schedule_start:
                return False  # Planning mode: no dates

        # Subtask inherits parent's date range
        if 'default_parent_id' in self._context:
            parent = self.env['project.task'].browse(self._context['default_parent_id'])
            if parent.date_start:
                return parent.date_start

        # Odoo 18: fields.Datetime.now() returns datetime object directly
        date_start = fields.Datetime.now()
        date_start = date_start.replace(hour=0, minute=0, second=0, microsecond=0)

        if 'default_project_id' in self._context:
            project_id = self._context['default_project_id']
            project = self.env['project.project'].browse(project_id)

            if project.task_default_start != 0:
                date_start = date_start + timedelta(hours=project.task_default_start)

        return date_start

    @api.model
    def _get_fixed_calc_type(self):
        return [
            ('duration', _('固定工期')),
            ('work', _('固定工時')),
        ]

    fixed_calc_type = fields.Selection(
        selection='_get_fixed_calc_type',
        string='計算方式',
        required=True,
        default='work'
    )

    # Link
    predecessor_ids = fields.One2many(
        'project.task.predecessor',
        'task_id',
        string='前置關聯'
    )
    predecessor_count = fields.Integer(
        compute='_compute_predecessor_count',
        string='前置數量',
        store=True,
        compute_sudo=True
    )
    # Inverse relation: links where this task acts as the predecessor (parent).
    # Provides proper ORM dependency tracking so predecessor_parent recomputes
    # automatically when a link pointing at this task is created/removed —
    # no manual writes, no compute/write race (see _compute_predecessor_parent).
    as_predecessor_ids = fields.One2many(
        'project.task.predecessor',
        'parent_task_id',
        string='被依賴關聯'
    )
    # Number of links in which this task is the predecessor (i.e. how many
    # successors depend on it). The scheduler treats predecessor_parent == 0
    # as a "terminal" task during the backward pass, so this must be an
    # accurate count maintained by a single source of truth (the compute).
    predecessor_parent = fields.Integer(
        compute='_compute_predecessor_parent',
        string='被依賴數量',
        store=True,
        compute_sudo=True
    )

    # Gantt
    on_gantt = fields.Boolean(
        string="長條顯示名稱",
        default=False
    )
    date_finished = fields.Datetime(
        string='完成日期',
        compute='_compute_date_finished',
        store=True,
        compute_sudo=True
    )
    _progress_manual = fields.Float(string="手動進度", default=0)

    progress = fields.Float(
        string="進度",
        compute='_compute_progress',
        inverse='_inverse_progress',
        store=True,
        readonly=False,
    )

    # Info - autoplanning (hours)
    duration = fields.Float(
        string='實際工期',
        compute='_compute_duration',
        readonly=True,
        store=True,
        compute_sudo=True
    )

    working_duration = fields.Float(
        string='工作工期',
        compute='_compute_working_duration',
        store=True,
        compute_sudo=True,
        help="使用專案行事曆計算的工作時數"
    )

    # Rolled-up planned work hours.
    # Leaf task  → its own plan_duration (the hours the user typed).
    # Parent task → sum of its children's total_work_hours, which resolves
    #               recursively down to the LEAF level only, so an intermediate
    #               summary level is never counted twice.
    total_work_hours = fields.Float(
        string='工時合計',
        compute='_compute_total_work_hours',
        recursive=True,
        compute_sudo=True,
        help="上層任務的工時為其最下層子任務工時的總和，不可編輯。"
    )

    # Scheduler
    schedule_mode = fields.Selection(
        selection='_get_schedule_mode',
        string='排程模式',
        required=True,
        default='manual'
    )

    # Constrain
    constrain_type = fields.Selection(
        selection='_get_constrain_type',
        string='約束類型',
        required=True,
        default='asap'
    )
    constrain_date = fields.Datetime(string='約束日期')

    plan_action = fields.Boolean(
        compute='_compute_plan_action',
        string='排程動作',
        store=True,
        compute_sudo=True
    )
    plan_duration = fields.Float(
        string='計劃工期',
        default=24.0
    )
    plan_offset = fields.Float(
        string='計劃偏移（小時）',
        default=0.0,
        help="規劃模式中從 T=0 起算的虛擬時間軸偏移（小時）"
    )

    # Redefine defaults - using date_start/date_end from base project.task
    date_start = fields.Datetime(
        string='開始日期',
        default=_default_date_start,
        index=True,
        copy=False
    )

    date_end = fields.Datetime(
        string='結束日期',
        default=_default_date_end,
        index=True,
        copy=False
    )

    # Color (0=no color, 1-11 = Kanban fixed colors)
    color_gantt = fields.Integer(
        string="長條顏色",
        help="甘特圖長條顏色索引 (0=無自訂顏色, 1-11=固定色)",
        default=0
    )

    # Humanize duration
    duration_scale = fields.Char(
        string='工期顯示格式',
        related="project_id.duration_scale",
        readonly=True
    )
    duration_picker = fields.Selection(
        string='工期輸入格式',
        related="project_id.duration_picker",
        readonly=True
    )
    duration_work_scale = fields.Char(
        string='工時顯示格式',
        related="project_id.duration_work_scale",
        readonly=True
    )

    progress_mode = fields.Selection(
        string='進度模式',
        related="project_id.progress_mode",
        readonly=True
    )

    # Summary dates
    # Note: recursive=True is required because _get_summary_date depends on
    # child_ids.summary_date_start and child_ids.summary_date_end (self-referential)
    summary_date_start = fields.Datetime(
        compute='_get_summary_date',
        string="摘要開始日期",
        store=False,
        recursive=True
    )
    summary_date_end = fields.Datetime(
        compute='_get_summary_date',
        string="摘要結束日期",
        store=False,
        recursive=True
    )

    # Loop detection
    p_loop = fields.Boolean(string="循環偵測")

    # Tree sorting
    fold = fields.Boolean(
        string="收闔任務",
        help="在甘特圖中收闔任務",
        default=False
    )
    sorting_seq = fields.Integer(
        string='排序序號',
        default=0,
        index=True,
    )
    sorting_level = fields.Integer(
        string='排序層級',
        default=0
    )

    # Critical path
    critical_path = fields.Boolean(
        string="關鍵路徑",
        help="是否在關鍵路徑上",
        default=False,
        readonly=True
    )
    cp_shows = fields.Boolean(
        string='顯示關鍵路徑',
        related="project_id.cp_shows",
        readonly=True
    )
    cp_detail = fields.Boolean(
        string='關鍵路徑細節',
        related="project_id.cp_detail",
        readonly=True
    )

    # --- Progress compute / inverse ---

    @api.depends('project_id.progress_mode', '_progress_manual',
                 'effective_hours', 'subtask_effective_hours', 'allocated_hours')
    def _compute_progress(self):
        for task in self:
            if task.project_id.progress_mode == 'timesheet':
                if task.allocated_hours > 0:
                    total = task.effective_hours + task.subtask_effective_hours
                    task.progress = min(round(total / task.allocated_hours * 100, 2), 100)
                else:
                    task.progress = 0.0
            else:
                task.progress = task._progress_manual

    def _inverse_progress(self):
        for task in self:
            task._progress_manual = task.progress

    @api.depends('effective_hours', 'subtask_effective_hours', 'allocated_hours')
    def _compute_progress_hours(self):
        """Override hr_timesheet's method — only compute overtime.
        progress is handled by _compute_progress above."""
        for task in self:
            if task.allocated_hours > 0:
                total = task.effective_hours + task.subtask_effective_hours
                task.overtime = max(total - task.allocated_hours, 0)
            else:
                task.overtime = 0

    def update_date_end(self, stage_id):
        # Disable remove (end date) when stage change
        return {}

    # Note: _onchange_user removed - empty method served no purpose

    @api.depends('child_ids', 'child_ids.date_start', 'child_ids.date_end',
                 'child_ids.summary_date_start', 'child_ids.summary_date_end')
    def _get_summary_date(self):
        """Optimized summary date calculation with prefetch"""
        # Prefetch child data to avoid N+1
        self.mapped('child_ids.child_ids')

        for task in self.sorted(key='sorting_level', reverse=True):
            summary_date_start = False
            summary_date_end = False

            if task.child_ids:
                # Use mapped for efficient batch access
                children_with_children = task.child_ids.filtered(lambda c: c.child_ids)
                children_without_children = task.child_ids - children_with_children

                date_start = []
                date_end = []

                # Children with sub-children: use summary dates
                if children_with_children:
                    summary_starts = children_with_children.mapped('summary_date_start')
                    summary_ends = children_with_children.mapped('summary_date_end')
                    date_start.extend([d for d in summary_starts if d])
                    date_end.extend([d for d in summary_ends if d])

                # Children without sub-children: use direct dates
                if children_without_children:
                    direct_starts = children_without_children.mapped('date_start')
                    direct_ends = children_without_children.mapped('date_end')
                    date_start.extend([d for d in direct_starts if d])
                    date_end.extend([d for d in direct_ends if d])

                if date_start:
                    summary_date_start = min(date_start)
                if date_end:
                    summary_date_end = max(date_end)

            task.summary_date_start = summary_date_start
            task.summary_date_end = summary_date_end

    @api.onchange('project_id')
    def _onchange_project(self):
        if hasattr(super(), '_onchange_project'):
            if self._origin.id:
                if self.env['project.task.predecessor'].search(
                        ['|', ('task_id', '=', self._origin.id), ('parent_task_id', '=', self._origin.id)], limit=1):
                    raise UserError(_(
                        '無法變更任務的專案。\n請先刪除前置關聯。'))

                if self.search([('parent_id', '=', self._origin.id)], limit=1):
                    raise UserError(_(
                        '無法變更任務的專案。\n請先刪除或移除子任務。'))

            super()._onchange_project()

    @api.depends("predecessor_ids")
    def _compute_predecessor_count(self):
        """Count the predecessor links owned by each task (its dependencies)."""
        for task in self:
            task.predecessor_count = len(task.predecessor_ids)

    @api.depends("as_predecessor_ids")
    def _compute_predecessor_parent(self):
        """Count the links in which this task is the predecessor (successors).

        Single source of truth: the value is driven purely by the
        as_predecessor_ids inverse relation, so creating or removing a
        predecessor link that points at this task recomputes it automatically.
        The previous design wrote a hard-coded 1 from
        project.task.predecessor.create/write while the compute wrote the real
        count, letting the stored value drift between "1" and "N" and breaking
        the scheduler's predecessor_parent == 0 terminal-task detection.
        """
        for task in self:
            task.predecessor_parent = len(task.as_predecessor_ids)

    # ------------------------------------------------------------------
    # Unified dependency: predecessor-driven state management
    # Overrides native _compute_state to use predecessor_ids instead of
    # depend_on_ids. The depend_on_ids field is kept in sync via
    # project.task.predecessor's create/write/unlink methods.
    # ------------------------------------------------------------------

    @api.depends(
        'stage_id',
        'predecessor_ids',
        'predecessor_ids.enable_blocking',
        'predecessor_ids.parent_task_id.state',
    )
    def _compute_state(self):
        """Override native state computation to use predecessor-based blocking.

        A task is 'waiting' if any predecessor with enable_blocking=True
        has a parent_task that is not in a closed state.
        """
        for task in self:
            if task.allow_task_dependencies:
                has_open_blocker = any(
                    pred.enable_blocking and pred.parent_task_id.state not in CLOSED_STATES
                    for pred in task.predecessor_ids
                )
                if has_open_blocker:
                    if task.state not in CLOSED_STATES:
                        task.state = '04_waiting_normal'
                    continue
            # No blocking dependencies (or feature disabled): restore to in_progress
            if task.state not in CLOSED_STATES:
                task.state = '01_in_progress'

    def is_blocked_by_dependences(self):
        """Override native method to check predecessor-based blocking."""
        return any(
            pred.enable_blocking and pred.parent_task_id.state not in CLOSED_STATES
            for pred in self.predecessor_ids
        )

    def action_dependent_tasks(self):
        """Override to show tasks blocked by this task via predecessors."""
        self.ensure_one()
        blocked_task_ids = self.env['project.task.predecessor'].search([
            ('parent_task_id', '=', self.id),
            ('enable_blocking', '=', True),
        ]).mapped('task_id').ids
        return {
            'res_model': 'project.task',
            'type': 'ir.actions.act_window',
            'name': _('被阻擋的任務'),
            'view_mode': 'list,form,kanban,calendar,pivot,graph,activity',
            'domain': [('id', 'in', blocked_task_ids)],
            'context': {**self._context, 'show_project_update': False},
        }

    @api.model
    def scheduler_plan(self, project_id):
        """Execute scheduling plan for a project"""
        search_project = self.env['project.project'].browse(project_id).exists()
        if not search_project:
            raise UserError(_('找不到專案。'))
        # Verify caller has write access to the project
        search_project.check_access('write')

        # Advisory lock to prevent concurrent scheduling on same project.
        # Use the two-int form pg_advisory_xact_lock(classid, objid) with a
        # fixed namespace + project_id. Python's hash() is salted per process
        # (PYTHONHASHSEED), so different workers would derive different keys for
        # the same project and the lock would not actually serialize them.
        self.env.cr.execute(
            "SELECT pg_advisory_xact_lock(%s, %s)",
            (_SCHEDULER_LOCK_NAMESPACE, project_id))

        scheduling_type = search_project.scheduling_type

        if scheduling_type == "manual":
            raise UserError(_(
                '手動模式不適用。請在專案中設定為正排或逆排。'))

        # project_task_scheduler.py
        self._scheduler_plan_start_calc(project=search_project)

        # Re-derive every leaf's window from its scheduled hours: start snapped
        # into working time, end from plan_duration through the calendar. This
        # is what stops a task from finishing at 19:00 or on a Saturday (which
        # silently changed its work hours), then relax the dependency graph
        # against the corrected windows.
        leaves = self.env['project.task'].search([
            ('project_id', '=', project_id),
            ('child_ids', '=', False),
        ])
        if leaves:
            leaves._resync_leaf_dates()
            leaves._cascade_fs_push()

        self._summary_work(project_id=project_id)
        self._scheduler_plan_complete(project_id=project_id, scheduling_type=scheduling_type)

        return True

    def _scheduler_plan_complete(self, project_id, scheduling_type):
        """Calculate and update project schedule dates - optimized batch operations.

        Note: Uses schedule_end/schedule_start (Datetime) to avoid conflict
        with native project.project.date_start (Date) in Odoo 18.
        """
        search_tasks = self.env['project.task'].search([('project_id', '=', project_id)])

        if not search_tasks:
            return

        # Batch update all tasks at once
        search_tasks.write({'plan_action': False})

        project = self.env['project.project'].browse(int(project_id))

        if scheduling_type == "forward":
            # Use mapped for efficient date collection
            date_list_end = [d for d in search_tasks.mapped('date_end') if d]
            if date_list_end:
                project.write({'schedule_end': max(date_list_end)})

        elif scheduling_type == "backward":
            # Use mapped for efficient date collection
            date_list_start = [d for d in search_tasks.mapped('date_start') if d]
            if date_list_start:
                project.write({'schedule_start': min(date_list_start)})

    def _summary_work(self, project_id):
        """Align every summary task with its children.

        A summary task's bar is, by definition, "first child start → last child
        end". This runs for EVERY parent regardless of ``schedule_mode``:
        the old ``schedule_mode == 'auto'`` guard silently skipped rollup for
        manually-scheduled outlines, which is what let child bars end up outside
        their parent's bar after scheduling.

        Predecessor constraints are NOT enforced by nudging the parent's own
        start here — doing so moved the summary bar off its children (the bar
        would start after its own first child). A parent that must respect an FS
        boundary pushes its CHILDREN instead, which
        :meth:`_update_ancestor_dates` already does via
        :meth:`_clamp_children_to_fs_boundary`.

        ``plan_duration`` is not written either: a summary task's hours are the
        computed :field:`total_work_hours` roll-up of its leaves.
        """
        search_tasks = self.env['project.task'].search([
            ('project_id', '=', project_id),
            ('child_ids', '!=', False)
        ])
        if not search_tasks:
            return

        # Deepest levels first, so a nested parent is already aligned with its
        # own children before its parent reads its span.
        for task in search_tasks.sorted(key='sorting_level', reverse=True):
            task.invalidate_recordset(['summary_date_start', 'summary_date_end'])
            date_start = task.summary_date_start
            date_end = task.summary_date_end
            if not date_start and not date_end:
                continue

            var_data = {}
            if date_start and date_start != task.date_start:
                var_data["date_start"] = date_start
            if date_end and date_end != task.date_end:
                var_data["date_end"] = date_end
            if var_data:
                task.with_context(skip_date_snap=True).write(var_data)

    @api.depends("schedule_mode")
    def _compute_plan_action(self):
        for task in self:
            task.plan_action = task.schedule_mode != "manual"

    def _is_in_work_interval(self, calendar, dt_tz):
        """Check if a timezone-aware datetime falls within a work interval.

        Uses the calendar's attendance/leave data to determine if dt_tz
        is inside any work period. Boundaries are inclusive.

        :param calendar: resource.calendar record
        :param dt_tz: timezone-aware datetime
        :returns: True if dt_tz is within a work interval
        """
        day_start = dt_tz.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        resource = self.env['resource.resource']
        intervals = calendar._work_intervals_batch(day_start, day_end, resource)[resource.id]
        for start, stop, _meta in intervals:
            if start <= dt_tz <= stop:
                return True
        return False

    # ------------------------------------------------------------------
    # Work-calendar arithmetic
    #
    # Single source of truth for the rule "the hours the user typed ARE the
    # scheduled hours": a leaf task's ``date_end`` is always derived from
    # ``date_start`` + ``plan_duration`` **through the work calendar**, and both
    # endpoints always land inside working time. Nothing may set date_end by
    # adding raw wall-clock hours, otherwise the task drifts into evenings /
    # weekends and its work hours silently change.
    # ------------------------------------------------------------------

    def _work_calendar(self):
        """Return (calendar, tz) for this task, or (None, None) when the
        project does not use a work calendar."""
        self.ensure_one()
        calendar = self.project_id.resource_calendar_id
        if not calendar or not self.project_id.use_calendar:
            return None, None
        return calendar, pytz.timezone(self.project_id.tz or 'UTC')

    # Windows tried, in order, when looking forward for the next instant work
    # can begin. Almost every call lands inside or just before a work interval,
    # so asking the calendar for one day first keeps the common case cheap — a
    # cascade makes hundreds of these calls, and computing 60 days of intervals
    # (attendances ∩ leaves) for each was the bulk of its cost. The last window
    # is the one that has to cover a long shutdown.
    _WORK_SEARCH_WINDOWS = (1, 7, 60)
    _WORK_SEARCH_DAYS = _WORK_SEARCH_WINDOWS[-1]

    def _snap_start_to_work(self, dt):
        """Move a naive-UTC datetime FORWARD to the next instant at which work
        can actually begin.

        Note the strict comparison: an instant sitting exactly on the CLOSE of a
        work interval (17:00) is a valid finish but not a valid start — there is
        no working time left in it — so it snaps to the next interval. Using the
        inclusive :meth:`_is_in_work_interval` test here would leave successors
        starting at 17:00 and finishing days later.
        """
        self.ensure_one()
        if not dt:
            return dt
        calendar, tz = self._work_calendar()
        if not calendar:
            return dt
        dt_tz = pytz.UTC.localize(dt).astimezone(tz)
        resource = self.env['resource.resource']
        for days in self._WORK_SEARCH_WINDOWS:
            horizon = dt_tz + relativedelta(days=days)
            intervals = calendar._work_intervals_batch(
                dt_tz, horizon, resource)[resource.id]
            for start, stop, _meta in intervals:
                if stop <= dt_tz:
                    continue
                begin = start if start > dt_tz else dt_tz
                return begin.astimezone(pytz.UTC).replace(tzinfo=None)
        return dt

    def _end_from_work_hours(self, start, hours):
        """Return the naive-UTC datetime reached after consuming ``hours`` of
        working time from ``start`` (naive UTC)."""
        self.ensure_one()
        if not start or not hours or hours <= 0:
            return start
        calendar, tz = self._work_calendar()
        if not calendar:
            return start + timedelta(hours=hours)
        start_tz = pytz.UTC.localize(start).astimezone(tz)
        end_dt = calendar.plan_hours(hours, start_tz, compute_leaves=True)
        if not end_dt:
            return start + timedelta(hours=hours)
        return end_dt.astimezone(pytz.UTC).replace(tzinfo=None)

    def _start_from_work_hours(self, end, hours):
        """Return the naive-UTC datetime that is ``hours`` of working time
        BEFORE ``end`` (naive UTC). Mirror of :meth:`_end_from_work_hours`."""
        self.ensure_one()
        if not end or not hours or hours <= 0:
            return end
        calendar, tz = self._work_calendar()
        if not calendar:
            return end - timedelta(hours=hours)
        end_tz = pytz.UTC.localize(end).astimezone(tz)
        start_dt = calendar.plan_hours(-hours, end_tz, compute_leaves=True)
        if not start_dt:
            return end - timedelta(hours=hours)
        return start_dt.astimezone(pytz.UTC).replace(tzinfo=None)

    def _plan_dates_from(self, start):
        """Given a desired start, return the (start, end) pair a leaf task must
        actually occupy: start snapped into working time, end derived from
        ``plan_duration`` through the calendar.

        Returns ``(None, None)`` when the task has no usable planned hours, so
        callers can fall back to their previous behaviour.
        """
        self.ensure_one()
        hours = self.plan_duration or 0.0
        if not start or hours <= 0:
            return None, None
        new_start = self._snap_start_to_work(start)
        return new_start, self._end_from_work_hours(new_start, hours)

    def _resync_leaf_dates(self):
        """Re-derive date_end (and snap date_start) from plan_duration for every
        leaf task in ``self``. Used after a move that only translated dates."""
        for task in self:
            if task.child_ids or not task.date_start:
                continue
            new_start, new_end = task._plan_dates_from(task.date_start)
            if not new_start:
                continue
            vals = {}
            if new_start != task.date_start:
                vals['date_start'] = new_start
            if new_end and new_end != task.date_end:
                vals['date_end'] = new_end
            if vals:
                task.with_context(
                    skip_date_snap=True,
                    skip_cascade_push=True,
                ).write(vals)

    def _sync_predecessors_from_depend_on(self, depend_on_commands):
        """Sync predecessor records when depend_on_ids is written directly.

        This handles the reverse direction: when someone edits the native
        "Blocked By" tab, we create/remove predecessor records to match.
        Only FS-type predecessors with enable_blocking=True are managed.
        """
        Predecessor = self.env['project.task.predecessor']
        for task in self:
            # Parse M2M commands to get target parent_task_ids
            current_blocking = Predecessor.search([
                ('task_id', '=', task.id),
                ('enable_blocking', '=', True),
                ('type', '=', 'FS'),
            ])
            current_parent_ids = set(current_blocking.mapped('parent_task_id').ids)

            # Resolve M2M commands to final set of IDs
            new_parent_ids = set(current_parent_ids)  # start from current
            for cmd in depend_on_commands:
                if cmd[0] == 6:  # (6, 0, [ids]) — replace all
                    new_parent_ids = set(cmd[2])
                elif cmd[0] == 4:  # (4, id) — add
                    new_parent_ids.add(cmd[1])
                elif cmd[0] == 3:  # (3, id) — remove
                    new_parent_ids.discard(cmd[1])
                elif cmd[0] == 5:  # (5,) — clear
                    new_parent_ids.clear()

            # Create missing predecessors
            to_add = new_parent_ids - current_parent_ids
            if to_add:
                Predecessor.with_context(skip_depend_on_sync=True).create([{
                    'task_id': task.id,
                    'parent_task_id': pid,
                    'type': 'FS',
                    'enable_blocking': True,
                } for pid in to_add])

            # Remove predecessors no longer in depend_on_ids
            to_remove = current_parent_ids - new_parent_ids
            if to_remove:
                preds_to_remove = current_blocking.filtered(
                    lambda p: p.parent_task_id.id in to_remove
                )
                preds_to_remove.with_context(skip_depend_on_sync=True).unlink()

    def _snap_constrain_date(self, vals):
        """Snap constrain_date to work intervals, same as date_start/date_end.

        SNET/SNLT/MSO (start-type): snap FORWARD to next work time start.
        FNET/FNLT/MFO (end-type): snap BACKWARD to previous work time end.
        """
        if self.env.context.get('skip_date_snap'):
            return
        constrain_date_val = vals.get('constrain_date')
        if not constrain_date_val:
            return
        constrain_type = vals.get('constrain_type')
        if not constrain_type:
            # constrain_type not in vals — read from record
            for task in self:
                constrain_type = task.constrain_type
                break
        if not constrain_type or constrain_type in ('asap', 'alap'):
            return
        for task in self:
            cal = task.project_id.resource_calendar_id
            if not cal or not task.project_id.use_calendar:
                return
            tz = pytz.timezone(task.project_id.tz or 'UTC')
            dt = fields.Datetime.to_datetime(constrain_date_val)
            dt_tz = pytz.UTC.localize(dt).astimezone(tz)
            if self._is_in_work_interval(cal, dt_tz):
                return  # Already in work time
            # Start-type constraints snap forward; end-type snap backward
            if constrain_type in ('snet', 'snlt', 'mso'):
                forward_range = [
                    dt_tz,
                    dt_tz + relativedelta(days=7, hour=0, minute=0, second=0),
                ]
                snapped = cal._get_closest_work_time(dt_tz, search_range=forward_range)
            else:  # fnet, fnlt, mfo
                backward_range = [
                    dt_tz + relativedelta(days=-7, hour=0, minute=0, second=0),
                    dt_tz,
                ]
                snapped = cal._get_closest_work_time(dt_tz, match_end=True, search_range=backward_range)
            if snapped:
                vals['constrain_date'] = snapped.astimezone(pytz.UTC).replace(tzinfo=None)
            break  # Only need first task's calendar

    def _apply_constraint_to_dates(self, vals):
        """When constrain_date is set, push date_start/date_end to respect it.

        Only applies when the task already has dates and the constraint
        would be violated by the current dates.

        SINGLE RECORD ONLY — the computed window goes into the shared ``vals``,
        so it would be written to every record of a multi-record write.
        :meth:`write` splits such a write per record before calling this.
        """
        constrain_type = vals.get('constrain_type')
        constrain_date = vals.get('constrain_date')
        # Resolve from record if not in vals
        for task in self:
            ct = constrain_type or task.constrain_type
            cd = constrain_date
            if cd and isinstance(cd, str):
                cd = fields.Datetime.to_datetime(cd)
            if not cd:
                cd = task.constrain_date if 'constrain_date' not in vals else None
            if not ct or ct in ('asap', 'alap') or not cd:
                continue
            ds = task.date_start
            de = task.date_end
            if not ds or not de:
                continue
            dur = de - ds

            # Moving a task onto its constraint keeps the hours it was scheduled
            # for: the free edge is re-derived through the work calendar instead
            # of translating the old wall-clock window, which would land the task
            # in an evening or a weekend and silently change its work hours.
            # Summary tasks keep the plain translation — their span belongs to
            # their children, not to a plan_duration of their own.
            def _from_start(new_start):
                if not task.child_ids:
                    snapped, derived = task._plan_dates_from(new_start)
                    if snapped:
                        return snapped, derived
                return new_start, new_start + dur

            def _from_end(new_end):
                if not task.child_ids and (task.plan_duration or 0) > 0:
                    return task._start_from_work_hours(
                        new_end, task.plan_duration), new_end
                return new_end - dur, new_end

            # Check if constraint is violated, push dates if needed
            if (ct == 'snet' and ds < cd) or (ct == 'snlt' and ds > cd) \
                    or (ct == 'mso' and ds != cd):
                new_start, new_end = _from_start(cd)
                vals.setdefault('date_start', new_start)
                vals.setdefault('date_end', new_end)
            elif (ct == 'fnet' and de < cd) or (ct == 'fnlt' and de > cd) \
                    or (ct == 'mfo' and de != cd):
                new_start, new_end = _from_end(cd)
                vals.setdefault('date_start', new_start)
                vals.setdefault('date_end', new_end)
            break  # single record — see the docstring

    def write(self, vals):
        """Propagate date changes to ancestors.
        After date changes, ancestor parent tasks auto-extend to span children.
        Subtask dates are NOT clamped to parent's start — parent summary dates
        auto-adjust via _update_ancestor_dates().
        """
        # Intercept depend_on_ids writes: sync back to predecessor records
        if 'depend_on_ids' in vals and not self.env.context.get('skip_predecessor_sync'):
            self._sync_predecessors_from_depend_on(vals.pop('depend_on_ids'))

        constraint_changed = 'constrain_type' in vals or 'constrain_date' in vals
        if (constraint_changed and len(self) > 1
                and not self.env.context.get('skip_date_snap')):
            # A constraint is resolved against EACH task's own calendar and own
            # window, so a multi-record write cannot share one vals dict —
            # _snap_constrain_date and _apply_constraint_to_dates both read the
            # first record and write their answer back into the dict everyone
            # gets. Resource levelling and "reschedule incomplete" stamp the same
            # SNET onto a whole batch, so that first task's recomputed window
            # landed on every task in it. Split the write.
            result = True
            for task in self:
                result = task.write(dict(vals)) and result
            return result

        # Snap constrain_date to work intervals (same treatment as date_start/date_end)
        if 'constrain_date' in vals:
            self._snap_constrain_date(vals)

        # When constraint changes, push task dates to respect it
        if constraint_changed and not self.env.context.get('skip_date_snap'):
            self._apply_constraint_to_dates(vals)

        date_changed = 'date_start' in vals or 'date_end' in vals
        # Date snap: snap to work time when calendar active.
        # Rules:
        #   skip_date_snap context  → skip entirely (FS push/clamp)
        #   both date_start & date_end in vals → skip (drag: preserve duration)
        #   within work interval    → no snap (respect user intent)
        #   outside work hours      → date_start snaps FORWARD, date_end snaps BACKWARD
        both_dates = 'date_start' in vals and 'date_end' in vals
        if date_changed and not self.env.context.get('skip_date_snap') and not both_dates:
            # Group tasks by project calendar to handle cross-project batch writes
            snapped_vals = {}  # project_id → snapped vals copy
            for task in self:
                pid = task.project_id.id
                if pid in snapped_vals:
                    continue  # Already snapped for this project's calendar
                cal = task.project_id.resource_calendar_id
                if not cal or not task.project_id.use_calendar:
                    snapped_vals[pid] = None  # No snap needed
                    continue
                snap_v = {}
                tz = pytz.timezone(task.project_id.tz or 'UTC')
                if 'date_start' in vals and vals['date_start']:
                    dt = fields.Datetime.to_datetime(vals['date_start'])
                    dt_tz = pytz.UTC.localize(dt).astimezone(tz)
                    if not self._is_in_work_interval(cal, dt_tz):
                        forward_range = [
                            dt_tz,
                            dt_tz + relativedelta(days=7, hour=0, minute=0, second=0),
                        ]
                        snapped = cal._get_closest_work_time(dt_tz, search_range=forward_range)
                        if snapped:
                            snap_v['date_start'] = snapped.astimezone(pytz.UTC).replace(tzinfo=None)
                if 'date_end' in vals and vals['date_end']:
                    dt = fields.Datetime.to_datetime(vals['date_end'])
                    dt_tz = pytz.UTC.localize(dt).astimezone(tz)
                    if not self._is_in_work_interval(cal, dt_tz):
                        backward_range = [
                            dt_tz + relativedelta(days=-7, hour=0, minute=0, second=0),
                            dt_tz,
                        ]
                        snapped = cal._get_closest_work_time(dt_tz, match_end=True, search_range=backward_range)
                        if snapped:
                            snap_v['date_end'] = snapped.astimezone(pytz.UTC).replace(tzinfo=None)
                snapped_vals[pid] = snap_v if snap_v else None
            # Apply per-project snapped values; if all share the same project, mutate vals directly
            unique_projects = {pid for pid, sv in snapped_vals.items() if sv}
            if len(unique_projects) <= 1:
                for sv in snapped_vals.values():
                    if sv:
                        vals.update(sv)
            else:
                # Cross-project batch: write each project group separately
                for task in self:
                    sv = snapped_vals.get(task.project_id.id)
                    if sv:
                        merged = {**vals, **sv}
                        task._write_raw(merged)
                    else:
                        task._write_raw(vals)
                # date_changed is necessarily True inside this branch.
                self._update_ancestor_dates()
                if not self.env.context.get('skip_cascade_push'):
                    self._cascade_dependency_push()
                if 'state' in vals and not self.env.context.get('skip_auto_complete'):
                    self._check_parent_auto_complete()
                return True
        result = super().write(vals)
        if result and date_changed:
            self._update_ancestor_dates()
            if not self.env.context.get('skip_cascade_push'):
                self._cascade_dependency_push()
        if result and 'state' in vals and not self.env.context.get('skip_auto_complete'):
            self._check_parent_auto_complete()
        return result

    def _write_raw(self, vals):
        """Write straight through this module's :meth:`write` override.

        Skips the work-time snap, the ancestor roll-up and the dependency
        cascade — for callers that have already decided the exact dates and own
        the propagation themselves (the cascade engine, the compaction pass).

        Exists so those callers do not have to spell ``super(ProjectTaskNative,
        rec).write(...)`` at the call site: that idiom names the class whose
        override is being skipped, so it silently changes meaning as soon as the
        caller is moved into a different class of the same model.
        """
        return super(ProjectTaskNative, self).write(vals)

    def _check_parent_auto_complete(self):
        """Auto-complete parent tasks when all children are in closed states.

        Rules:
        - All child_ids must be in CLOSED_STATES (done or canceled)
        - Parent must not already be in CLOSED_STATES
        - Parent must not be blocked by predecessors (enable_blocking)
        - Recurses upward through ancestor chain
        - Uses skip_auto_complete context to prevent infinite recursion
        """
        parents_to_check = self.mapped('parent_id').filtered(
            lambda p: p.state not in CLOSED_STATES
        )
        for parent in parents_to_check:
            # All children must be closed (done or canceled)
            if not all(c.state in CLOSED_STATES for c in parent.child_ids):
                continue
            # Blocked by predecessor → don't auto-complete
            if parent.is_blocked_by_dependences():
                continue
            parent.with_context(skip_auto_complete=True).write({
                'state': '1_done',
            })
            # Recurse: check if grandparent can also auto-complete
            parent._check_parent_auto_complete()

    def _update_ancestor_dates(self):
        """Propagate date changes upward: each parent task auto-extends to
        span all its children. Recurses through write() for multi-level.

        FS constraint enforcement: if a child's move would pull the parent's
        summary start earlier than the parent's FS predecessor boundary,
        the child is clamped to the FS boundary position instead.
        """
        parents = self.env['project.task']
        for task in self:
            if task.parent_id and task.parent_id.child_ids:
                parents |= task.parent_id

        for parent in parents:
            # Invalidate non-stored summary fields to force recomputation
            # within the same transaction (after super().write() on children).
            parent.child_ids.invalidate_recordset(['summary_date_start', 'summary_date_end'])
            children = parent.child_ids
            starts = []
            ends = []
            for child in children:
                if child.child_ids:
                    # Nested parent: recurse through summary dates
                    if child.summary_date_start:
                        starts.append(child.summary_date_start)
                    if child.summary_date_end:
                        ends.append(child.summary_date_end)
                else:
                    if child.date_start:
                        starts.append(child.date_start)
                    if child.date_end:
                        ends.append(child.date_end)

            new_start = min(starts) if starts else False
            new_end = max(ends) if ends else False
            if not new_start and not new_end:
                continue

            # FS constraint: parent's start cannot be earlier than its FS
            # predecessors' end dates. Walk up the full ancestor chain.
            fs_min = self._get_ancestor_fs_min_start(parent)
            if fs_min and new_start and new_start < fs_min:
                # Clamp: push violating children forward to the FS boundary
                self._clamp_children_to_fs_boundary(parent, fs_min)
                # Recompute after clamping
                parent.child_ids.invalidate_recordset(['summary_date_start', 'summary_date_end'])
                starts = []
                ends = []
                for child in parent.child_ids:
                    if child.child_ids:
                        if child.summary_date_start:
                            starts.append(child.summary_date_start)
                        if child.summary_date_end:
                            ends.append(child.summary_date_end)
                    else:
                        if child.date_start:
                            starts.append(child.date_start)
                        if child.date_end:
                            ends.append(child.date_end)
                new_start = min(starts) if starts else False
                new_end = max(ends) if ends else False
                if not new_start and not new_end:
                    continue

            update_vals = {}
            if new_start and new_start != parent.date_start:
                update_vals['date_start'] = new_start
            if new_end and new_end != parent.date_end:
                update_vals['date_end'] = new_end
            # NOTE: plan_duration is deliberately NOT touched here. A summary
            # task's hours are the sum of its leaves (``total_work_hours``),
            # which is a computed field; its BAR is the children's span. Writing
            # the span's work hours back into plan_duration used to make the
            # parent's number drift every time any child moved.

            if update_vals:
                parent.with_context(skip_date_snap=True).write(update_vals)  # recursive — triggers grandparent


    @api.depends('date_end', 'date_start')
    def _compute_duration(self):
        """Compute task duration in hours - Odoo 18 style"""
        for task in self:
            if task.date_end and task.date_start:
                diff = task.date_end - task.date_start
                task.duration = diff.total_seconds() / 3600.0
            else:
                task.duration = 0

    @api.depends('date_start', 'date_end', 'project_id.resource_calendar_id', 'project_id.use_calendar', 'project_id.tz')
    def _compute_working_duration(self):
        # Group tasks by (calendar, tz) for batch processing
        cal_groups = {}
        for task in self:
            if not task.date_start or not task.date_end:
                task.working_duration = 0
                continue
            calendar = task.project_id.resource_calendar_id
            if not calendar or not task.project_id.use_calendar:
                task.working_duration = task.duration  # fallback to elapsed
                continue
            tz_name = task.project_id.tz or 'UTC'
            key = (calendar.id, tz_name)
            cal_groups.setdefault(key, (calendar, tz_name, []))
            cal_groups[key][2].append(task)

        for (_cal_id, _tz_name), (calendar, tz_name, group_tasks) in cal_groups.items():
            tz = pytz.timezone(tz_name)
            for task in group_tasks:
                start_tz = pytz.UTC.localize(task.date_start).astimezone(tz)
                end_tz = pytz.UTC.localize(task.date_end).astimezone(tz)
                task.working_duration = calendar.get_work_hours_count(start_tz, end_tz)

    @api.depends('plan_duration', 'child_ids', 'child_ids.total_work_hours')
    def _compute_total_work_hours(self):
        """Planned work hours, rolled up to summary tasks.

        A leaf contributes the hours the user typed (``plan_duration``); a
        summary task contributes the sum of its children's rolled-up value.
        Because a parent never adds its own ``plan_duration``, a multi-level
        outline sums the LEAF level exactly once — no double counting.
        """
        for task in self:
            if task.child_ids:
                task.total_work_hours = sum(
                    c.total_work_hours for c in task.child_ids)
            else:
                task.total_work_hours = task.plan_duration or 0.0

    @api.depends('state', 'date_last_stage_update')
    def _compute_date_finished(self):
        """Auto-derive completion date from native Odoo 18 fields.

        When task enters a closed state (done/canceled), date_finished
        is set to date_last_stage_update. When reopened, it clears.
        """
        for task in self:
            if task.is_closed:
                task.date_finished = task.date_last_stage_update or fields.Datetime.now()
            else:
                task.date_finished = False

    def unlink(self):
        if self.search([('parent_id', 'in', self.ids)], limit=1):
            raise UserError(_(
                '無法刪除父任務。\n請先刪除子任務。'))
        return super().unlink()

    # Note: _check_subtask_level removed - empty constraint served no purpose
