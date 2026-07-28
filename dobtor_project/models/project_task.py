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

    _WORK_SEARCH_DAYS = 60

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
        horizon = dt_tz + relativedelta(days=self._WORK_SEARCH_DAYS)
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
            # Check if constraint is violated, push dates if needed
            if ct == 'snet' and ds < cd:
                vals.setdefault('date_start', cd)
                vals.setdefault('date_end', cd + dur)
            elif ct == 'snlt' and ds > cd:
                vals.setdefault('date_start', cd)
                vals.setdefault('date_end', cd + dur)
            elif ct == 'fnet' and de < cd:
                vals.setdefault('date_end', cd)
                vals.setdefault('date_start', cd - dur)
            elif ct == 'fnlt' and de > cd:
                vals.setdefault('date_end', cd)
                vals.setdefault('date_start', cd - dur)
            elif ct == 'mso' and ds != cd:
                vals.setdefault('date_start', cd)
                vals.setdefault('date_end', cd + dur)
            elif ct == 'mfo' and de != cd:
                vals.setdefault('date_end', cd)
                vals.setdefault('date_start', cd - dur)
            break  # Single record per call from inspector

    def write(self, vals):
        """Propagate date changes to ancestors.
        After date changes, ancestor parent tasks auto-extend to span children.
        Subtask dates are NOT clamped to parent's start — parent summary dates
        auto-adjust via _update_ancestor_dates().
        """
        # Intercept depend_on_ids writes: sync back to predecessor records
        if 'depend_on_ids' in vals and not self.env.context.get('skip_predecessor_sync'):
            self._sync_predecessors_from_depend_on(vals.pop('depend_on_ids'))

        # Snap constrain_date to work intervals (same treatment as date_start/date_end)
        if 'constrain_date' in vals:
            self._snap_constrain_date(vals)

        # When constraint changes, push task dates to respect it
        constraint_changed = 'constrain_type' in vals or 'constrain_date' in vals
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
                        super(ProjectTaskNative, task).write(merged)
                    else:
                        super(ProjectTaskNative, task).write(vals)
                if date_changed:
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

                dur = (child.date_end - child.date_start) if child.date_end and child.date_start else timedelta(0)
                child.with_context(skip_date_snap=True).write({
                    'date_start': effective_min,
                    'date_end': effective_min + dur,
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
        Preserves relative positions. Uses super().write() to avoid
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
                super(ProjectTaskNative, task).write(vals)
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
            super(ProjectTaskNative, self).write(self_vals)
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
        snapshot = {}
        for t in project_tasks:
            snapshot[t.id] = {
                'date_start': t.date_start,
                'date_end': t.date_end,
                'plan_offset': t.plan_offset or 0,
                'plan_duration': t.plan_duration or 0,
                'constrain_type': t.constrain_type,
                'constrain_date': t.constrain_date,
            }

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
        project_tasks.invalidate_recordset()
        task_diff = {}
        for t in project_tasks:
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

        affected_ids = list(task_diff.keys())
        pred_diff = self._cascade_recalc_lags(affected_ids) if affected_ids else {}
        self._add_ancestor_hours_to_diff(task_diff)

        return {'tasks': task_diff, 'predecessors': pred_diff}

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
        snapshot = {}
        for t in project_tasks:
            snapshot[t.id] = {
                'date_start': t.date_start,
                'date_end': t.date_end,
                'plan_offset': t.plan_offset or 0,
                'plan_duration': t.plan_duration or 0,
                'constrain_type': t.constrain_type,
                'constrain_date': t.constrain_date,
            }

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
        project_tasks.invalidate_recordset()
        task_diff = {}
        for t in project_tasks:
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

        affected_ids = list(task_diff.keys())
        pred_diff = self._cascade_recalc_lags(affected_ids) if affected_ids else {}
        self._add_ancestor_hours_to_diff(task_diff)

        return {'tasks': task_diff, 'predecessors': pred_diff}

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
            is_plan = not src.date_start and src.plan_duration > 0

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
            super(ProjectTaskNative, task).write(vals)

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
                super(ProjectTaskNative, node).write({
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
                if abs(current_start - max_pred_end) > 0.01:
                    shift = current_start - max_pred_end
                    if task.child_ids:
                        task.action_move_with_descendants(-shift)
                    else:
                        super(ProjectTaskNative, task).write({
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
                # Early Start means the successor sits AT its latest
                # predecessor's end — pull it left when there is a gap, push it
                # right when it overlaps. The old guard only ever pulled left,
                # so a chain that was already overlapping stayed overlapping and
                # compacting could not repair it. That is reachable in one
                # click: step 3b re-snaps moved leaves into working time, and
                # several leaves sitting in the SAME non-working gap (Friday
                # evening, the weekend) all snap forward onto the same Monday
                # morning instant, collapsing the chain onto one point.
                current_start = task.summary_date_start if task.child_ids else task.date_start
                if not current_start:
                    continue
                shift_hours = (current_start - target_start).total_seconds() / 3600.0
                if abs(shift_hours) > 0.01:
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
                        super(ProjectTaskNative, task).write({
                            'date_start': new_start,
                            'date_end': new_end,
                        })
                        if task.parent_id:
                            task._update_ancestor_dates()

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
                    super(ProjectTaskNative, task).write({
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
                    super(ProjectTaskNative, t).write(vals)

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
