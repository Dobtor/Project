# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from datetime import timedelta
from dateutil.relativedelta import relativedelta
from odoo.exceptions import UserError
import pytz


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
        store=True
    )
    # Design note: predecessor_parent is a hybrid field — computed via
    # _compute_predecessor_count for initial/batch population, but also
    # manually written by project.task.predecessor's create/write/unlink
    # to maintain accuracy without side effects in compute methods.
    # This avoids Odoo 18's restriction on write() inside compute.
    predecessor_parent = fields.Integer(
        compute='_compute_predecessor_count',
        string='被依賴數量',
        store=True
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
    )
    progress = fields.Float(string="進度", default=0)

    # Info - autoplanning (hours)
    duration = fields.Float(
        string='實際工期',
        compute='_compute_duration',
        readonly=True,
        store=True
    )

    working_duration = fields.Float(
        string='工作工期',
        compute='_compute_working_duration',
        store=True,
        help="使用專案行事曆計算的工作時數"
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
        store=True
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
        default=0
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
        string='關鍵路徑',
        related="project_id.cp_shows",
        readonly=True
    )
    cp_detail = fields.Boolean(
        string='關鍵路徑細節',
        related="project_id.cp_detail",
        readonly=True
    )

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
        """Compute predecessor count - Odoo 18 best practice: no write() in compute.

        Note: predecessor_parent is now maintained by project.task.predecessor
        model's create/write/unlink methods to avoid side effects in compute.
        """
        if not self:
            return

        # Raw SQL for performance: single GROUP BY query instead of
        # per-record ORM search_count on the predecessor table.
        task_ids = self.ids
        parent_counts = {}
        if task_ids:
            self.env.cr.execute("""
                SELECT parent_task_id, COUNT(*)
                FROM project_task_predecessor
                WHERE parent_task_id IN %s
                GROUP BY parent_task_id
            """, (tuple(task_ids),))
            parent_counts = dict(self.env.cr.fetchall())

        # Update current tasks - only set computed values, no write() to other records
        for task in self:
            task.predecessor_count = len(task.predecessor_ids)
            task.predecessor_parent = parent_counts.get(task.id, 0)

    @api.model
    def scheduler_plan(self, project_id):
        """Execute scheduling plan for a project"""
        # Use browse instead of search for known ID - more efficient
        search_project = self.env['project.project'].browse(project_id).exists()
        if not search_project:
            raise UserError(_('找不到專案。'))

        scheduling_type = search_project.scheduling_type

        if scheduling_type == "manual":
            raise UserError(_(
                '手動模式不適用。請在專案中設定為正排或逆排。'))

        # project_task_scheduler.py
        self._scheduler_plan_start_calc(project=search_project)
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
        """Update summary task dates - optimized without unnecessary sudo()"""
        search_tasks = self.env['project.task'].search([
            ('project_id', '=', project_id),
            ('child_ids', '!=', False)
        ])

        for task in search_tasks:
            if task.schedule_mode == "auto":
                date_start = task.summary_date_start
                date_end = task.summary_date_end

                # Enforce FS predecessor constraints: parent start cannot be
                # earlier than the latest end date of its FS predecessors.
                for pred in task.predecessor_ids:
                    if pred.type == 'FS' and pred.parent_task_id.date_end:
                        if date_start and date_start < pred.parent_task_id.date_end:
                            date_start = pred.parent_task_id.date_end

                var_data = {
                    "date_start": date_start,
                    "date_end": date_end,
                }

                # Odoo 18: datetime fields are already datetime objects
                if date_end and date_start:
                    diff = date_end - date_start
                    var_data["plan_duration"] = diff.total_seconds() / 3600.0

                task.with_context(skip_date_snap=True).write(var_data)

    @api.depends("predecessor_ids.task_id", "predecessor_ids.type", "constrain_type", "constrain_date", "plan_duration",
                 "duration", "project_id.scheduling_type")
    def _compute_plan_action(self):
        for task in self:
            if task.schedule_mode != "manual":
                task.plan_action = True
            else:
                task.plan_action = False

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

    def write(self, vals):
        """Propagate date changes to ancestors.
        After date changes, ancestor parent tasks auto-extend to span children.
        Subtask dates are NOT clamped to parent's start — parent summary dates
        auto-adjust via _update_ancestor_dates().
        """
        date_changed = 'date_start' in vals or 'date_end' in vals
        # Date snap: snap to work time when calendar active.
        # Rules:
        #   skip_date_snap context  → skip entirely (FS push/clamp)
        #   both date_start & date_end in vals → skip (drag: preserve duration)
        #   within work interval    → no snap (respect user intent)
        #   outside work hours      → date_start snaps FORWARD, date_end snaps BACKWARD
        both_dates = 'date_start' in vals and 'date_end' in vals
        if date_changed and not self.env.context.get('skip_date_snap') and not both_dates:
            for task in self:
                cal = task.project_id.resource_calendar_id
                if not cal or not task.project_id.use_calendar:
                    continue
                tz = pytz.timezone(task.project_id.tz or 'UTC')
                if 'date_start' in vals and vals['date_start']:
                    dt = fields.Datetime.to_datetime(vals['date_start'])
                    dt_tz = pytz.UTC.localize(dt).astimezone(tz)
                    if not self._is_in_work_interval(cal, dt_tz):
                        # Snap forward: only search future work starts
                        forward_range = [
                            dt_tz,
                            dt_tz + relativedelta(days=7, hour=0, minute=0, second=0),
                        ]
                        snapped = cal._get_closest_work_time(dt_tz, search_range=forward_range)
                        if snapped:
                            vals['date_start'] = snapped.astimezone(pytz.UTC).replace(tzinfo=None)
                if 'date_end' in vals and vals['date_end']:
                    dt = fields.Datetime.to_datetime(vals['date_end'])
                    dt_tz = pytz.UTC.localize(dt).astimezone(tz)
                    if not self._is_in_work_interval(cal, dt_tz):
                        # Snap backward: only search past work ends
                        backward_range = [
                            dt_tz + relativedelta(days=-7, hour=0, minute=0, second=0),
                            dt_tz,
                        ]
                        snapped = cal._get_closest_work_time(dt_tz, match_end=True, search_range=backward_range)
                        if snapped:
                            vals['date_end'] = snapped.astimezone(pytz.UTC).replace(tzinfo=None)
                break  # All tasks in batch share project
        result = super().write(vals)
        if result and date_changed:
            self._update_ancestor_dates()
        return result

    def _update_ancestor_dates(self):
        """Propagate date changes upward: each parent task auto-extends to
        span all its children. Recurses through write() for multi-level."""
        parents = self.env['project.task']
        for task in self:
            if task.parent_id and task.parent_id.child_ids:
                parents |= task.parent_id

        for parent in parents:
            # Compute directly from children to bypass ORM cache issues
            # with non-stored compute fields within the same transaction.
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

            update_vals = {}
            if new_start and new_start != parent.date_start:
                update_vals['date_start'] = new_start
            if new_end and new_end != parent.date_end:
                update_vals['date_end'] = new_end
            # Recompute plan_duration to match new span
            effective_start = new_start or parent.date_start
            effective_end = new_end or parent.date_end
            if effective_start and effective_end:
                calendar = parent.project_id.resource_calendar_id
                if calendar and parent.project_id.use_calendar:
                    tz = pytz.timezone(parent.project_id.tz or 'UTC')
                    start_tz = pytz.UTC.localize(effective_start).astimezone(tz)
                    end_tz = pytz.UTC.localize(effective_end).astimezone(tz)
                    new_plan_dur = calendar.get_work_hours_count(start_tz, end_tz)
                else:
                    new_plan_dur = (effective_end - effective_start).total_seconds() / 3600.0
                if abs(new_plan_dur - (parent.plan_duration or 0)) > 0.01:
                    update_vals['plan_duration'] = new_plan_dur

            if update_vals:
                parent.with_context(skip_date_snap=True).write(update_vals)  # recursive — triggers grandparent

    def action_move_with_descendants(self, shift_hours):
        """Move this task and all descendants by shift_hours (float).
        Preserves relative positions. Uses super().write() to avoid
        recursive ancestor updates until the end."""
        self.ensure_one()
        delta = timedelta(hours=shift_hours)
        # Collect all descendants
        all_tasks = self.env['project.task']
        stack = list(self.child_ids)
        while stack:
            task = stack.pop()
            all_tasks |= task
            stack.extend(task.child_ids)
        # Move descendants first (skip ancestor update via super)
        for task in all_tasks:
            vals = {}
            if task.date_start:
                vals['date_start'] = task.date_start + delta
            if task.date_end:
                vals['date_end'] = task.date_end + delta
            if task.plan_duration:
                pass  # duration unchanged (same span, just shifted)
            if vals:
                super(ProjectTaskNative, task).write(vals)
        # Move self
        self_vals = {}
        if self.date_start:
            self_vals['date_start'] = self.date_start + delta
        if self.date_end:
            self_vals['date_end'] = self.date_end + delta
        if self_vals:
            super(ProjectTaskNative, self).write(self_vals)
        # Propagate to ancestors above self
        if self.parent_id:
            self._update_ancestor_dates()

    @api.depends('date_end', 'date_start')
    def _compute_duration(self):
        """Compute task duration in hours - Odoo 18 style"""
        for task in self:
            if task.date_end and task.date_start:
                diff = task.date_end - task.date_start
                task.duration = diff.total_seconds() / 3600.0
            else:
                task.duration = 0

    @api.depends('date_start', 'date_end', 'project_id.resource_calendar_id', 'project_id.use_calendar')
    def _compute_working_duration(self):
        for task in self:
            if not task.date_start or not task.date_end:
                task.working_duration = 0
                continue
            calendar = task.project_id.resource_calendar_id
            if not calendar or not task.project_id.use_calendar:
                task.working_duration = task.duration  # fallback to elapsed
                continue
            tz = pytz.timezone(task.project_id.tz or 'UTC')
            start_tz = pytz.UTC.localize(task.date_start).astimezone(tz)
            end_tz = pytz.UTC.localize(task.date_end).astimezone(tz)
            task.working_duration = calendar.get_work_hours_count(start_tz, end_tz)

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
