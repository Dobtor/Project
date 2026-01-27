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

    tz_offset = fields.Char(
        compute='_compute_tz_offset',
        string='Timezone offset',
        invisible=True
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
