# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from datetime import datetime, timedelta
import pytz


class Project(models.Model):
    _inherit = "project.project"

    @api.model
    def _tz_get(self):
        return [(tz, tz) for tz in sorted(pytz.all_timezones, key=lambda tz: tz if not tz.startswith('Etc/') else '_')]

    @api.model
    def _get_scheduling_type(self):
        return [
            ('forward', _('正排')),
            ('backward', _('逆排')),
            ('manual', _('手動')),
        ]

    @api.model
    def _get_duration_picker(self):
        return [
            ('day', _('天')),
            ('second', _('秒')),
            ('day_second', _('天秒'))
        ]

    use_calendar = fields.Boolean(
        string="使用行事曆",
        help="在設定頁籤中設定行事曆",
        default=True
    )

    # Override native computed-only field to stored + editable
    resource_calendar_id = fields.Many2one(
        'resource.calendar',
        string='工作行事曆',
        compute='_compute_resource_calendar_id',
        store=True,
        readonly=False,
    )

    @api.depends('company_id')
    def _compute_resource_calendar_id(self):
        """Set default from company; user can override."""
        for project in self:
            if not project.resource_calendar_id:
                project.resource_calendar_id = (
                    project.company_id.resource_calendar_id
                    or self.env.company.resource_calendar_id
                )

    scheduling_type = fields.Selection(
        selection='_get_scheduling_type',
        string='排程類型',
        required=True,
        default='forward'
    )

    # Note: Using schedule_start/schedule_end to avoid conflict with
    # native project.project.date_start (fields.Date) - Odoo 18 compatibility
    schedule_start = fields.Datetime(
        string='排程開始日期',
        default=False,
        help="自動排程的起始日期。空值 = 規劃模式。",
        index=True,
        copy=False
    )

    schedule_end = fields.Datetime(
        string='排程結束日期',
        default=False,
        help="自動排程的結束日期",
        index=True,
        copy=False
    )

    task_default_duration = fields.Float(
        string='預設工期',
        default=24.0,
        help="新建任務時的預設計劃工期（小時）"
    )

    task_default_start = fields.Float(
        string='預設開始時間',
        default=8.0,
        help="新建任務時的預設開始時間（UTC 午夜後小時數）"
    )

    @api.model
    def _get_schedule_mode(self):
        return [('auto', _('自動')), ('manual', _('手動'))]

    @api.model
    def _get_constrain_type(self):
        return [
            ('asap', _('盡早開始')), ('alap', _('盡晚開始')),
            ('snet', _('開始不早於')), ('snlt', _('開始不晚於')),
            ('fnet', _('完成不早於')), ('fnlt', _('完成不晚於')),
            ('mso', _('必須開始於')), ('mfo', _('必須完成於')),
        ]

    @api.model
    def _get_fixed_calc_type(self):
        return [('duration', _('固定工期')), ('work', _('固定工時'))]

    task_default_schedule_mode = fields.Selection(
        selection='_get_schedule_mode', string='預設排程模式',
        default='manual', help="新建任務時的預設排程模式"
    )
    task_default_color_gantt = fields.Integer(
        string='預設長條顏色', default=0,
        help="新建任務時的預設甘特圖顏色索引 (0=無, 1-11=固定色)"
    )
    task_default_constrain_type = fields.Selection(
        selection='_get_constrain_type', string='預設約束類型',
        default='asap', help="新建任務時的預設約束類型"
    )
    task_default_fixed_calc_type = fields.Selection(
        selection='_get_fixed_calc_type', string='預設計算方式',
        default='work', help="新建任務時的預設計算方式"
    )
    task_default_on_gantt = fields.Boolean(
        string='預設顯示名稱', default=False,
        help="新建任務時是否在甘特圖長條上顯示任務名稱"
    )

    task_default_start_end = fields.Char(
        string='預設開始時間 (時區)',
        readonly=True,
        compute='_compute_default_start_end',
        help="預設任務開始時間（含使用者時區）"
    )

    # humanize duration
    duration_scale = fields.Char(
        string='工期顯示格式',
        default='d,h',
        help="可設定：y,mo,w,d,h,m,s,ms"
    )

    duration_picker = fields.Selection(
        selection='_get_duration_picker',
        string='工期輸入格式',
        default=None,
        help="空值則隱藏工期輸入器"
    )

    duration_work_scale = fields.Char(
        string='工時顯示格式',
        default='h',
        help="可設定：y,mo,w,d,h,m,s,ms"
    )

    tz = fields.Selection(
        selection=_tz_get,
        string='時區',
        default=lambda self: self._context.get('tz'),
        help="時區"
    )

    tz_offset = fields.Char(
        compute='_compute_tz_offset',
        string='時區偏移'
    )

    cp_shows = fields.Boolean(
        string="關鍵路徑",
        help="顯示關鍵路徑",
        default=True
    )

    cp_detail = fields.Boolean(
        string="關鍵路徑細節",
        help="在甘特圖上顯示關鍵路徑細節",
        default=False
    )

    detail_plan = fields.Boolean(
        string="細節計劃",
        help="允許儲存排程細節計劃",
        default=False
    )

    fold = fields.Boolean(
        string="收闔專案",
        help="在甘特圖中收闔專案",
        default=False
    )

    # -------------------------------------------------------------------------
    # Calendar Info for Frontend Gantt
    # -------------------------------------------------------------------------

    def get_calendar_info(self, date_from=None, date_to=None):
        """Return calendar data for frontend gantt view."""
        self.ensure_one()
        calendar = self.resource_calendar_id
        if not calendar or not self.use_calendar:
            return {'active': False}

        # Attendance patterns (exclude lunch and resource-specific)
        attendances = []
        for att in calendar.attendance_ids:
            if att.day_period == 'lunch':
                continue
            if att.display_type or att.resource_id:
                continue
            attendances.append({
                'dayofweek': att.dayofweek,  # '0'=Mon .. '6'=Sun
                'hour_from': att.hour_from,
                'hour_to': att.hour_to,
            })

        # Global leaves within visible range
        leaves = []
        if date_from and date_to:
            tz = pytz.timezone(self.tz or 'UTC')
            dt_from = tz.localize(fields.Datetime.from_string(date_from).replace(hour=0))
            dt_to = tz.localize(fields.Datetime.from_string(date_to).replace(hour=23, minute=59))
            for leave in calendar.global_leave_ids:
                leave_start = leave.date_from
                leave_end = leave.date_to
                if leave_end >= dt_from.astimezone(pytz.UTC).replace(tzinfo=None) and \
                   leave_start <= dt_to.astimezone(pytz.UTC).replace(tzinfo=None):
                    leaves.append({
                        'date_from': fields.Datetime.to_string(leave_start),
                        'date_to': fields.Datetime.to_string(leave_end),
                        'name': leave.name,
                    })

        return {
            'active': True,
            'hours_per_day': calendar.hours_per_day or 8.0,
            'tz': self.tz or 'UTC',
            'attendances': attendances,
            'leaves': leaves,
        }

    # -------------------------------------------------------------------------
    # Planning Mode: Schedule Start / Clear
    # -------------------------------------------------------------------------

    def action_set_schedule_start(self, date_str):
        """Set schedule_start and trigger forward scheduler.

        Before scheduling, manual tasks get real dates computed from
        plan_offset (scheduler skips manual tasks).
        """
        self.ensure_one()
        dt = fields.Datetime.from_string(date_str)
        self.write({'schedule_start': dt, 'schedule_end': False})

        # Pre-compute dates for manual tasks (scheduler skips them)
        self._precompute_manual_task_dates(dt)

        self.env['project.task'].scheduler_plan(self.id)
        return True

    def _precompute_manual_task_dates(self, schedule_start):
        """Assign real dates to manual tasks from plan_offset + plan_duration.

        Manual tasks (schedule_mode='manual') are not processed by the
        scheduler. This method computes dates before scheduling so that
        manual tasks appear at their planned positions.

        When the project has a resource calendar enabled, duration is
        distributed across working hours (skipping weekends / leaves).
        Otherwise falls back to naive timedelta arithmetic.
        """
        manual_tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('schedule_mode', '=', 'manual'),
            ('child_ids', '=', False),  # leaf tasks only
        ])
        if not manual_tasks:
            return

        # No manual TZ conversion here — _get_calendar_level already
        # converts date_in via to_tz(date_in, project.tz) internally,
        # matching the scheduler's behavior for auto tasks.

        use_cal = self.use_calendar and self.resource_calendar_id
        task_model = self.env['project.task']

        # Calendar params shared across tasks (attendance/leave accumulate)
        t_params = None
        if use_cal:
            t_params = {
                'leave_ids': [],
                'attendance_ids': [],
                'project': self,
            }

        for task in manual_tasks:
            if task.date_start and task.date_end:
                continue  # Already has dates, skip

            offset_hours = task.plan_offset or 0
            duration_hours = task.plan_duration or 24.0
            date_start = schedule_start + timedelta(hours=offset_hours)

            if use_cal and t_params is not None:
                task_resource_ids = task.task_resource_ids
                cal_id, task_res, t_params = task_model.make_res_cal_leave(
                    task_resource_ids, t_params, manual_tasks.ids
                )
                task_obj = {
                    "id": task.id,
                    "name": task.name,
                    "project_id": self,
                    "task_resource_ids": task_resource_ids,
                    "task_res": task_res,
                    "fixed_calc_type": task.fixed_calc_type,
                    "plan_duration": duration_hours,
                }

                calendar_level = task_model._get_calendar_level(
                    task_obj, date_start, duration_hours, t_params,
                    direction="normal",
                )

                if calendar_level:
                    cal_start = task_model._get_date_from_level(
                        calendar_level, "date_from", "min"
                    )
                    cal_end = task_model._get_date_from_level(
                        calendar_level, "date_to", "max"
                    )
                    if cal_start and cal_end:
                        date_start = cal_start
                        date_end = cal_end
                    else:
                        date_end = date_start + timedelta(hours=duration_hours)
                else:
                    date_end = date_start + timedelta(hours=duration_hours)
            else:
                date_end = date_start + timedelta(hours=duration_hours)

            task.write({
                'date_start': date_start,
                'date_end': date_end,
            })

    def action_clear_schedule_dates(self, clear_tasks=False):
        """Clear schedule dates, optionally clear all task dates.

        When clear_tasks=True, computes plan_offset from real dates BEFORE
        clearing, ensuring reversible transition back to planning mode.
        """
        self.ensure_one()
        schedule_start = self.schedule_start

        if clear_tasks and schedule_start:
            self._save_plan_offsets_from_dates(schedule_start)

        self.write({'schedule_start': False, 'schedule_end': False})

        if clear_tasks:
            tasks = self.env['project.task'].search([('project_id', '=', self.id)])
            tasks.with_context(skip_date_snap=True).write({
                'date_start': False,
                'date_end': False,
            })
            # Also clear milestone dates
            milestones = self.env['project.milestone'].search([
                ('project_id', '=', self.id),
            ])
            if milestones:
                milestones.write({
                    'deadline_datetime': False,
                    'deadline': False,
                })
        return True

    def _save_plan_offsets_from_dates(self, schedule_start):
        """Compute plan_offset and plan_duration from real dates.

        Called before clearing task dates so that planning mode
        preserves the relative task positions from scheduling.
        """
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('date_start', '!=', False),
            ('child_ids', '=', False),  # leaf tasks only
        ])

        for task in tasks:
            vals = {}

            # Compute plan_offset (hours from schedule_start)
            offset = (task.date_start - schedule_start).total_seconds() / 3600.0
            if abs(offset - (task.plan_offset or 0)) > 0.01:
                vals['plan_offset'] = offset

            # Compute plan_duration (hours)
            if task.date_end:
                duration = (task.date_end - task.date_start).total_seconds() / 3600.0
                if abs(duration - (task.plan_duration or 0)) > 0.01:
                    vals['plan_duration'] = duration

            if vals:
                # Direct super write to avoid date_snap and ancestor propagation
                super(type(task), task).write(vals)

    # -------------------------------------------------------------------------
    # Catch Up / Reschedule Actions
    # -------------------------------------------------------------------------

    def action_catch_up(self):
        """Update progress for auto-scheduled tasks based on current date."""
        self.ensure_one()
        now = fields.Datetime.now()
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('schedule_mode', '=', 'auto'),
            ('date_start', '!=', False),
            ('date_end', '!=', False),
        ])
        for task in tasks:
            if task.date_end <= now:
                task.progress = 100
            elif task.date_start <= now:
                total = (task.date_end - task.date_start).total_seconds()
                elapsed = (now - task.date_start).total_seconds()
                if total > 0:
                    task.progress = min(round(elapsed / total * 100, 1), 100)
        # Re-run scheduler
        if self.scheduling_type != 'manual':
            self.env['project.task'].scheduler_plan(self.id)
        return True

    def action_reschedule_incomplete(self):
        """Move remaining work of overdue incomplete tasks to today."""
        self.ensure_one()
        now = fields.Datetime.now()
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('schedule_mode', '=', 'auto'),
            ('date_end', '<', now),
            ('progress', '<', 100),
            ('date_start', '!=', False),
            ('date_end', '!=', False),
        ])
        for task in tasks:
            task.write({
                'constrain_type': 'snet',
                'constrain_date': now,
            })
        # Re-run scheduler
        if self.scheduling_type != 'manual':
            self.env['project.task'].scheduler_plan(self.id)
        return True

    # -------------------------------------------------------------------------
    # Violation Detection
    # -------------------------------------------------------------------------

    def check_violations(self):
        """Return list of project violations for the gantt view."""
        self.ensure_one()
        violations = []
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('date_start', '!=', False),
        ])

        for task in tasks:
            # 1. Loop detection
            if task.p_loop:
                violations.append({
                    'type': 'loop',
                    'task_id': task.id,
                    'task_name': task.name,
                    'message': '偵測到循環依賴',
                    'severity': 'error',
                })

            # 2. Deadline exceeded
            if task.date_end and task.date_deadline:
                dl = task.date_deadline
                if hasattr(dl, 'hour'):
                    deadline_dt = dl
                else:
                    # date_deadline is a Date field — convert to datetime at end of day
                    deadline_dt = datetime.combine(dl, datetime.max.time())
                if deadline_dt and task.date_end > deadline_dt:
                    violations.append({
                        'type': 'overdue',
                        'task_id': task.id,
                        'task_name': task.name,
                        'message': '結束日期超過截止日期',
                        'severity': 'warning',
                    })

            # 3. Constraint conflict
            if task.constrain_type and task.constrain_date and task.date_start and task.date_end:
                ct = task.constrain_type
                cd = task.constrain_date
                conflict = False
                if ct == 'snet' and task.date_start < cd:
                    conflict = True
                elif ct == 'snlt' and task.date_start > cd:
                    conflict = True
                elif ct == 'fnet' and task.date_end < cd:
                    conflict = True
                elif ct == 'fnlt' and task.date_end > cd:
                    conflict = True
                elif ct == 'mso' and task.date_start != cd:
                    conflict = True
                elif ct == 'mfo' and task.date_end != cd:
                    conflict = True
                if conflict:
                    violations.append({
                        'type': 'constraint',
                        'task_id': task.id,
                        'task_name': task.name,
                        'message': '%s 約束違反' % ct.upper(),
                        'severity': 'warning',
                    })

            # 4. Unlinked auto task
            if (task.schedule_mode == 'auto'
                    and task.constrain_type in ('asap', False)
                    and not task.predecessor_ids):
                violations.append({
                    'type': 'unlinked',
                    'task_id': task.id,
                    'task_name': task.name,
                    'message': '自動排程任務無前置關聯或約束',
                    'severity': 'info',
                })

        # 5. Resource overload detection
        resource_tasks = {}
        for task in tasks:
            if not task.date_end:
                continue
            for res_link in task.task_resource_ids:
                rid = res_link.resource_id.id
                rname = res_link.resource_id.name
                resource_tasks.setdefault(rid, {'name': rname, 'intervals': []})
                resource_tasks[rid]['intervals'].append({
                    'task': task, 'start': task.date_start, 'end': task.date_end,
                })
        for rid, data in resource_tasks.items():
            intervals = sorted(data['intervals'], key=lambda x: x['start'])
            for i in range(1, len(intervals)):
                if intervals[i]['start'] < intervals[i-1]['end']:
                    violations.append({
                        'type': 'resource_overload',
                        'task_id': intervals[i]['task'].id,
                        'task_name': intervals[i]['task'].name,
                        'message': '資源「%s」與 %s 重疊' % (
                            data['name'], intervals[i-1]['task'].name),
                        'severity': 'warning',
                    })

        return violations

    # -------------------------------------------------------------------------
    # Resource Leveling (Phase 3B)
    # -------------------------------------------------------------------------

    def action_level_resources(self):
        """Level resources: delay non-critical tasks to resolve overloads."""
        self.ensure_one()
        # Step 1: Run normal scheduling first
        if self.scheduling_type != 'manual':
            self.env['project.task'].scheduler_plan(self.id)

        # Step 2: Detect resource overlaps
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('schedule_mode', '=', 'auto'),
            ('date_start', '!=', False),
            ('date_end', '!=', False),
        ])
        resource_tasks = {}
        for task in tasks:
            for res_link in task.task_resource_ids:
                rid = res_link.resource_id.id
                resource_tasks.setdefault(rid, []).append({
                    'task': task,
                    'start': task.date_start,
                    'end': task.date_end,
                    'critical': task.critical_path,
                })

        # Step 3: Sort per resource, delay non-critical overlapping tasks
        changes = []
        for rid, task_list in resource_tasks.items():
            task_list.sort(key=lambda t: (not t['critical'], t['start']))
            for i in range(1, len(task_list)):
                cur, prev = task_list[i], task_list[i - 1]
                if cur['start'] < prev['end'] and not cur['critical']:
                    changes.append((cur['task'].id, prev['end']))
                    cur['start'] = prev['end']  # cascade

        # Step 4: Apply SNET constraints
        for task_id, constrain_date in changes:
            self.env['project.task'].browse(task_id).write({
                'constrain_type': 'snet',
                'constrain_date': constrain_date,
            })

        # Step 5: Re-run scheduler
        if self.scheduling_type != 'manual':
            self.env['project.task'].scheduler_plan(self.id)

        return len(changes)

    # -------------------------------------------------------------------------
    # Baseline Management (Phase 3D)
    # -------------------------------------------------------------------------

    def action_save_baseline(self, name=None):
        self.ensure_one()
        if not name:
            name = "Baseline %s" % fields.Datetime.now().strftime('%Y-%m-%d %H:%M')
        baseline = self.env['project.baseline'].create({
            'name': name, 'project_id': self.id,
        })
        baseline.action_save_snapshot()
        return {'id': baseline.id, 'name': baseline.name,
                'create_date': str(baseline.create_date)}

    def get_baselines(self):
        self.ensure_one()
        return [{'id': b.id, 'name': b.name, 'create_date': str(b.create_date),
                 'line_count': len(b.line_ids)}
                for b in self.env['project.baseline'].search(
                    [('project_id', '=', self.id)], order='create_date desc', limit=20)]

    @api.depends('tz')
    def _compute_tz_offset(self):
        for project in self:
            project.tz_offset = datetime.now(pytz.timezone(project.tz or 'GMT')).strftime('%z')

    @api.depends("task_default_start", "task_default_duration")
    def _compute_default_start_end(self):
        for proj in self:
            tz_name = self.env.context.get('tz') or self.env.user.tz
            date_end_str = ''

            if tz_name:
                user_tz = pytz.timezone(tz_name)

                # Odoo 18: fields.Datetime.now() returns datetime object directly
                date_start = fields.Datetime.now()
                date_start = date_start.replace(hour=0, minute=0, second=0)
                date_start = date_start + timedelta(hours=proj.task_default_start)

                date_end = date_start + timedelta(hours=proj.task_default_duration)

                date_start_tz = date_start.replace(tzinfo=pytz.utc).astimezone(user_tz)
                date_end_tz = date_end.replace(tzinfo=pytz.utc).astimezone(user_tz)

                date_end_str = 'UTC= {} -> {}, TZ= {} -> {}'.format(
                    fields.Datetime.to_string(date_start),
                    fields.Datetime.to_string(date_end),
                    fields.Datetime.to_string(date_start_tz),
                    fields.Datetime.to_string(date_end_tz)
                )

            proj.task_default_start_end = date_end_str
