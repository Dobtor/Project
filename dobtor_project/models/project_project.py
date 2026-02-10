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
            ('forward', _('Forward')),
            ('backward', _('Backward')),
            ('manual', _('Manual')),
        ]

    @api.model
    def _get_duration_picker(self):
        return [
            ('day', _('Day')),
            ('second', _('Second')),
            ('day_second', _('Day Second'))
        ]

    use_calendar = fields.Boolean(
        string="Use Calendar",
        help="Set Calendar in Setting Tab",
        default=True
    )

    scheduling_type = fields.Selection(
        selection='_get_scheduling_type',
        string='Scheduling Type',
        required=True,
        default='forward'
    )

    # Note: Using schedule_start/schedule_end to avoid conflict with
    # native project.project.date_start (fields.Date) - Odoo 18 compatibility
    schedule_start = fields.Datetime(
        string='Schedule Starting Date',
        default=fields.Datetime.now,
        help="Datetime Start for Scheduler Auto Mode",
        index=True,
        copy=False
    )

    schedule_end = fields.Datetime(
        string='Schedule Ending Date',
        default=lambda self: fields.Datetime.now() + timedelta(days=1),
        help="Datetime End for Scheduler Auto Mode",
        index=True,
        copy=False
    )

    task_default_duration = fields.Integer(
        string='Task Duration',
        default=86400,
        help="Default Task Duration in seconds"
    )

    task_default_start = fields.Integer(
        string='Task Start (UTC)',
        default=28800,
        help="Default Task Start after midnight, UTC - without Time Zone"
    )

    task_default_start_end = fields.Char(
        string='Task Start (tz)',
        readonly=True,
        compute='_compute_default_start_end',
        help="Default Task Start after midnight, with user Time Zone"
    )

    # humanize duration
    duration_scale = fields.Char(
        string='Duration Scale',
        default='d,h',
        help="You can set: y,mo,w,d,h,m,s,ms"
    )

    duration_picker = fields.Selection(
        selection='_get_duration_picker',
        string='Duration Picker',
        default=None,
        help="Empty it is Hide: day and second"
    )

    duration_work_scale = fields.Char(
        string='Duration Work Scale',
        default='h',
        help="You can set: y,mo,w,d,h,m,s,ms"
    )

    tz = fields.Selection(
        selection=_tz_get,
        string='Timezone',
        default=lambda self: self._context.get('tz'),
        help="Time Zone"
    )

    # Note: In Odoo 18, 'invisible' is a view-layer attribute, not a field parameter.
    # Use invisible="1" in XML views to hide this field.
    tz_offset = fields.Char(
        compute='_compute_tz_offset',
        string='Timezone offset'
    )

    cp_shows = fields.Boolean(
        string="Critical Path",
        help="Critical Path Shows",
        default=True
    )

    cp_detail = fields.Boolean(
        string="Critical Path Detail",
        help="Critical Path Shows Detail on Gantt",
        default=False
    )

    detail_plan = fields.Boolean(
        string="Detail Plan",
        help="Allow Save Detail Plan",
        default=False
    )

    fold = fields.Boolean(
        string="Fold Project",
        help="Fold project in Gantt view",
        default=False
    )

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
                    'message': 'Circular dependency detected',
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
                        'message': 'End date exceeds deadline',
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
                        'message': '%s constraint violated' % ct.upper(),
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
                    'message': 'Auto task with no predecessor or constraint',
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
                        'message': 'Resource "%s" overlaps with %s' % (
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
                date_start = date_start + timedelta(seconds=proj.task_default_start)

                date_end = date_start + timedelta(seconds=proj.task_default_duration)

                date_start_tz = date_start.replace(tzinfo=pytz.utc).astimezone(user_tz)
                date_end_tz = date_end.replace(tzinfo=pytz.utc).astimezone(user_tz)

                date_end_str = 'UTC= {} -> {}, TZ= {} -> {}'.format(
                    fields.Datetime.to_string(date_start),
                    fields.Datetime.to_string(date_end),
                    fields.Datetime.to_string(date_start_tz),
                    fields.Datetime.to_string(date_end_tz)
                )

            proj.task_default_start_end = date_end_str
