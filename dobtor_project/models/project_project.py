# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError
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

    progress_mode = fields.Selection(
        selection=[('manual', '手動'), ('timesheet', '工時單')],
        string='進度模式',
        default='manual',
        help="手動：由使用者拖曳或輸入進度。工時單：依據 allocated_hours 與實際工時自動計算。"
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
        string='預設工時',
        compute='_compute_task_default_duration',
        store=True,
        readonly=False,
        help="新建任務的預設工時（小時）。預設為專案行事曆的一個工作日；"
             "改成別的值後就固定為該值，直到行事曆換掉為止。"
    )

    @api.depends('resource_calendar_id.hours_per_day', 'use_calendar')
    def _compute_task_default_duration(self):
        """One WORKING DAY, taken from the project's calendar.

        It used to be a hard-coded 24.0, which under "the hours you type ARE the
        schedule" means three working days on an 8-hour calendar — every new task
        started three times too long. Following the calendar is what "one day"
        was always meant to mean.

        Computed + stored + readonly=False: a project that sets its own number
        keeps it, and only swapping the calendar recomputes — which is exactly
        when the old number stops meaning a day.
        """
        for project in self:
            calendar = project.resource_calendar_id
            if project.use_calendar and calendar and calendar.hours_per_day:
                project.task_default_duration = calendar.hours_per_day
            elif not project.task_default_duration:
                project.task_default_duration = 8.0

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
    # 8 = 藍色. A colourless bar draws as a white outline, which reads as
    # "unset" rather than as a plan; blue is what a gantt bar is expected to
    # look like. 0 stays valid and the picker offers it last.
    task_default_color_gantt = fields.Integer(
        string='預設長條顏色', default=8,
        help="新建任務時的預設甘特圖顏色索引 (1-11=固定色, 0=無色)"
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
        self.check_access('read')
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
        try:
            dt = fields.Datetime.from_string(date_str)
        except (ValueError, TypeError):
            raise UserError(_('無效的日期格式。'))
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

            if use_cal and t_params is not None:
                task_resource_ids = task.task_resource_ids
                cal_id, task_res, t_params = task_model.make_res_cal_leave(
                    task_resource_ids, t_params, manual_tasks.ids
                )

                # Convert working-hour offset to calendar date via _get_calendar_level
                if offset_hours > 0:
                    offset_task_obj = {
                        "id": 0,
                        "name": "_offset_calc",
                        "project_id": self,
                        "task_resource_ids": task_resource_ids,
                        "task_res": task_res,
                        "fixed_calc_type": "duration",
                        "plan_duration": offset_hours,
                    }
                    offset_level = task_model._get_calendar_level(
                        offset_task_obj, schedule_start, offset_hours, t_params,
                        direction="normal",
                    )
                    if offset_level:
                        date_start = task_model._get_date_from_level(
                            offset_level, "date_to", "max"
                        ) or schedule_start
                    else:
                        date_start = schedule_start + timedelta(hours=offset_hours)
                else:
                    date_start = schedule_start

                # Convert working-hour duration to calendar end date
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
                date_start = schedule_start + timedelta(hours=offset_hours)
                date_end = date_start + timedelta(hours=duration_hours)

            task.write({
                'date_start': date_start,
                'date_end': date_end,
            })

    def action_clear_schedule_dates(self, clear_tasks=False):
        """Leave scheduled mode: the project's plan goes back to being measured
        in hours from T+0.

        Dropping ``schedule_start`` IS the switch into planning mode, where a
        task's position is its ``plan_offset``. Leaving real dates on the tasks
        would put the project on two timelines at once — the tasks that still
        have dates sit on the calendar while every task created afterwards sits
        at T+0 — and the gantt then has to span from one to the other, which is
        how a chart ends up thousands of days wide. So the conversion is
        unconditional: every task's dates become a ``plan_offset`` (relative
        positions preserved by :meth:`_save_plan_offsets_from_dates`) and are
        then cleared, and milestone deadlines — real datetimes that have no
        meaning on the T+0 axis — go with them.

        :param clear_tasks: kept for callers that pass it; it no longer selects
            whether tasks are converted (they always are), only whether the
            caller wanted the full reset. Both paths now leave one timeline.
        """
        self.ensure_one()
        schedule_start = self.schedule_start

        if schedule_start:
            self._save_plan_offsets_from_dates(schedule_start)

        self.write({'schedule_start': False, 'schedule_end': False})

        tasks = self.env['project.task'].search([('project_id', '=', self.id)])
        if tasks:
            tasks.with_context(skip_date_snap=True).write({
                'date_start': False,
                'date_end': False,
            })
        # Milestone deadlines are real datetimes; on the T+0 axis a milestone is
        # positioned by the tasks that feed it.
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

        When the project has a resource calendar enabled, offset and
        duration are stored in **working hours** (using the calendar).
        Otherwise falls back to elapsed (calendar) hours.
        """
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('date_start', '!=', False),
            ('child_ids', '=', False),  # leaf tasks only
        ])

        calendar = self.resource_calendar_id
        use_cal = self.use_calendar and calendar
        tz = pytz.timezone(self.tz or 'UTC') if use_cal else None

        for task in tasks:
            vals = {}

            # Compute plan_offset (working hours from schedule_start)
            if use_cal:
                start_tz = pytz.UTC.localize(schedule_start).astimezone(tz)
                task_start_tz = pytz.UTC.localize(task.date_start).astimezone(tz)
                offset = calendar.get_work_hours_count(start_tz, task_start_tz)
            else:
                offset = (task.date_start - schedule_start).total_seconds() / 3600.0
            if abs(offset - (task.plan_offset or 0)) > 0.01:
                vals['plan_offset'] = offset

            # Compute plan_duration (working hours)
            if task.date_end:
                if use_cal:
                    # Reuse server-computed working_duration field
                    duration = task.working_duration or 0
                else:
                    duration = (task.date_end - task.date_start).total_seconds() / 3600.0
                if abs(duration - (task.plan_duration or 0)) > 0.01:
                    vals['plan_duration'] = duration

            if vals:
                # Skip date_snap via context flag (ancestor update won't trigger
                # since we only write plan_offset/plan_duration, not date_start/date_end)
                task.with_context(skip_date_snap=True).write(vals)

    # -------------------------------------------------------------------------
    # Batch Color Apply
    # -------------------------------------------------------------------------

    def action_apply_color_to_tasks(self):
        """Apply the project's default color to all its tasks."""
        self.ensure_one()
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
        ])
        if tasks:
            tasks.write({'color_gantt': self.task_default_color_gantt})
        return True

    # -------------------------------------------------------------------------
    # Catch Up / Reschedule Actions
    # -------------------------------------------------------------------------

    def action_catch_up(self):
        """Update progress for auto-scheduled tasks based on current date."""
        self.ensure_one()
        now = fields.Datetime.now()
        # Timesheet mode: progress is auto-computed, only re-run scheduler
        if self.progress_mode == 'timesheet':
            if self.scheduling_type != 'manual':
                self.env['project.task'].scheduler_plan(self.id)
            return True
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.id),
            ('schedule_mode', '=', 'auto'),
            ('date_start', '!=', False),
            ('date_end', '!=', False),
        ])
        # Batch: tasks fully past → progress 100
        completed = tasks.filtered(lambda t: t.date_end <= now)
        if completed:
            completed.write({'progress': 100})
        # Partial progress: compute each, then group identical values into one
        # write (avoids a per-task write + cascade in the loop).
        partial = tasks.filtered(lambda t: t.date_start <= now < t.date_end)
        by_progress = {}
        for task in partial:
            total = (task.date_end - task.date_start).total_seconds()
            elapsed = (now - task.date_start).total_seconds()
            if total > 0:
                val = min(round(elapsed / total * 100, 1), 100)
                by_progress.setdefault(val, self.env['project.task'])
                by_progress[val] |= task
        for val, recs in by_progress.items():
            recs.write({'progress': val})
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
        # Same constraint for all overdue tasks → single batched write.
        if tasks:
            tasks.write({
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
        self.check_access('read')
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
                    'message': _('偵測到循環依賴'),
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
                        'message': _('結束日期超過截止日期'),
                        'severity': 'warning',
                    })

            # 3. Constraint conflict
            # Use 60s tolerance for MSO/MFO to account for work-time snapping
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
                elif ct == 'mso' and abs((task.date_start - cd).total_seconds()) > 60:
                    conflict = True
                elif ct == 'mfo' and abs((task.date_end - cd).total_seconds()) > 60:
                    conflict = True
                if conflict:
                    violations.append({
                        'type': 'constraint',
                        'task_id': task.id,
                        'task_name': task.name,
                        'message': _('%(type)s 約束違反', type=ct.upper()),
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
                    'message': _('自動排程任務無前置關聯或約束'),
                    'severity': 'info',
                })

        # 5. Resource overload detection (capacity- and load_factor-aware).
        # A resource is overloaded only when the SUM of load_factors of tasks
        # running at the same instant exceeds its max_capacity — two 0.5-load
        # tasks on the same resource are legal and must not be flagged.
        # Prefetch resource links to avoid N+1 queries in the loop.
        tasks.mapped('task_resource_ids.resource_id')
        resource_tasks = {}
        for task in tasks:
            if not task.date_end:
                continue
            for res_link in task.task_resource_ids:
                resource = res_link.resource_id
                rid = resource.id
                resource_tasks.setdefault(rid, {
                    'name': resource.name,
                    'capacity': resource.max_capacity or 1.0,
                    'intervals': [],
                })
                resource_tasks[rid]['intervals'].append({
                    'task': task,
                    'start': task.date_start,
                    'end': task.date_end,
                    'load': res_link.load_factor or 0.0,
                })
        eps = 1e-6
        for rid, data in resource_tasks.items():
            capacity = data['capacity']
            intervals = data['intervals']
            # Sweep events: end (0) sorted before start (1) at the same instant
            # so back-to-back tasks do not count as overlapping.
            events = []
            for idx, iv in enumerate(intervals):
                events.append((iv['start'], 1, idx))
                events.append((iv['end'], 0, idx))
            events.sort(key=lambda e: (e[0], e[1]))
            running = 0.0
            active = set()
            reported = set()
            for _ts, kind, idx in events:
                if kind == 1:
                    running += intervals[idx]['load']
                    active.add(idx)
                    if running > capacity + eps and idx not in reported:
                        others = [intervals[a]['task'].name
                                  for a in active if a != idx][:3]
                        violations.append({
                            'type': 'resource_overload',
                            'task_id': intervals[idx]['task'].id,
                            'task_name': intervals[idx]['task'].name,
                            'message': _(
                                '資源「%(resource)s」負載 %(load).0f%% 超過容量 '
                                '%(cap).0f%%（與 %(tasks)s 同時段）',
                                resource=data['name'],
                                load=running * 100,
                                cap=capacity * 100,
                                tasks=', '.join(others) or _('其他任務'),
                            ),
                            'severity': 'warning',
                        })
                        reported.add(idx)
                else:
                    running -= intervals[idx]['load']
                    active.discard(idx)

        return violations

    # -------------------------------------------------------------------------
    # Resource Leveling (Phase 3B)
    # -------------------------------------------------------------------------

    @staticmethod
    def _level_earliest_slot(committed, est, duration, load, capacity):
        """Earliest start >= est where committed load + `load` stays within capacity.

        committed: list of {'start','end','load'} already-placed intervals.
        Returns the earliest feasible start datetime for an interval of the
        given duration and load that keeps peak concurrent load <= capacity.
        """
        eps = 1e-6
        if load <= eps:
            return est
        # Candidate starts: the requested time plus every committed end after it
        # (the moments at which capacity frees up).
        candidates = sorted({est} | {c['end'] for c in committed if c['end'] > est})
        for cand in candidates:
            cand_end = cand + duration
            # Peak load can only change at cand or at a committed start inside
            # the window; sample those points.
            sample_points = [cand]
            for c in committed:
                if cand < c['start'] < cand_end:
                    sample_points.append(c['start'])
            feasible = True
            for p in sample_points:
                concurrent = load
                for c in committed:
                    if c['start'] <= p < c['end']:
                        concurrent += c['load']
                if concurrent > capacity + eps:
                    feasible = False
                    break
            if feasible:
                return cand
        # No feasible overlapping slot: place after everything committed.
        if committed:
            return max(c['end'] for c in committed)
        return est

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
        resource_caps = {}
        for task in tasks:
            for res_link in task.task_resource_ids:
                resource = res_link.resource_id
                rid = resource.id
                resource_caps[rid] = resource.max_capacity or 1.0
                resource_tasks.setdefault(rid, []).append({
                    'task': task,
                    'start': task.date_start,
                    'end': task.date_end,
                    'load': res_link.load_factor or 0.0,
                    'critical': task.critical_path,
                })

        # Step 3: capacity- and load_factor-aware leveling. Commit critical
        # tasks at their scheduled time; delay each non-critical task to the
        # earliest slot where the resource has enough free capacity for it.
        changes = {}  # task_id → constrain_date (keep latest if multiple resources)
        for rid, task_list in resource_tasks.items():
            capacity = resource_caps.get(rid, 1.0)
            # Critical first (kept fixed), then earliest start.
            task_list.sort(key=lambda t: (not t['critical'], t['start']))
            committed = []  # [{'start','end','load'}]
            for cur in task_list:
                duration = cur['end'] - cur['start']
                if cur['critical']:
                    committed.append({'start': cur['start'], 'end': cur['end'],
                                      'load': cur['load']})
                    continue
                new_start = self._level_earliest_slot(
                    committed, cur['start'], duration, cur['load'], capacity)
                if new_start > cur['start']:
                    tid = cur['task'].id
                    if tid not in changes or new_start > changes[tid]:
                        changes[tid] = new_start
                committed.append({'start': new_start, 'end': new_start + duration,
                                  'load': cur['load']})

        # Step 4: Apply SNET constraints, grouping tasks that share the same
        # constrain_date into a single write (one write per distinct date).
        if changes:
            Task = self.env['project.task']
            by_date = {}
            for tid, constrain_date in changes.items():
                by_date.setdefault(constrain_date, [])
                by_date[constrain_date].append(tid)
            for constrain_date, tids in by_date.items():
                Task.browse(tids).write({
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
        self.check_access('write')
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
        self.check_access('read')
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
