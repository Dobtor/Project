# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from datetime import timedelta
from odoo.exceptions import UserError


class ProjectTaskNative(models.Model):
    _inherit = 'project.task'

    @api.model
    def _get_schedule_mode(self):
        return [
            ('auto', _('Auto')),
            ('manual', _('Manual')),
        ]

    @api.model
    def _get_constrain_type(self):
        return [
            ('asap', _('As Soon As Possible')),
            ('alap', _('As Late As Possible')),
            ('fnet', _('Finish No Earlier Than')),
            ('fnlt', _('Finish No Later Than')),
            ('mso', _('Must Start On')),
            ('mfo', _('Must Finish On')),
            ('snet', _('Start No Earlier Than')),
            ('snlt', _('Start No Later Than')),
        ]

    @api.model
    def _default_date_end(self):
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
                date_end = date_end + timedelta(seconds=project.task_default_start + project.task_default_duration)

        return date_end

    @api.model
    def _default_date_start(self):
        # Odoo 18: fields.Datetime.now() returns datetime object directly
        date_start = fields.Datetime.now()
        date_start = date_start.replace(hour=0, minute=0, second=0, microsecond=0)

        if 'default_project_id' in self._context:
            project_id = self._context['default_project_id']
            project = self.env['project.project'].browse(project_id)

            if project.task_default_start != 0:
                date_start = date_start + timedelta(seconds=project.task_default_start)

        return date_start

    @api.model
    def _get_fixed_calc_type(self):
        return [
            ('duration', _('Duration')),
            ('work', _('Work')),
        ]

    fixed_calc_type = fields.Selection(
        selection='_get_fixed_calc_type',
        string='Calc Type',
        required=True,
        default='work'
    )

    # Link
    predecessor_ids = fields.One2many(
        'project.task.predecessor',
        'task_id',
        string='Links'
    )
    predecessor_count = fields.Integer(
        compute='_compute_predecessor_count',
        string='Predecessor Count',
        store=True
    )
    predecessor_parent = fields.Integer(
        compute='_compute_predecessor_count',
        string='Predecessor parent',
        store=True
    )

    # Gantt
    is_milestone = fields.Boolean(
        string="Mark as Milestone",
        default=False
    )
    on_gantt = fields.Boolean(
        string="Task name on gantt",
        default=False
    )
    date_finished = fields.Datetime(string='Done Date')

    # Info - autoplanning
    duration = fields.Integer(
        string='Duration',
        compute='_compute_duration',
        readonly=True,
        store=True
    )

    # Scheduler
    schedule_mode = fields.Selection(
        selection='_get_schedule_mode',
        string='Schedule Mode',
        required=True,
        default='manual'
    )

    # Constrain
    constrain_type = fields.Selection(
        selection='_get_constrain_type',
        string='Constraint Type',
        required=True,
        default='asap'
    )
    constrain_date = fields.Datetime(string='Constraint Date')

    plan_action = fields.Integer(
        compute='_compute_plan_action',
        string='Plan Action',
        store=True
    )
    plan_duration = fields.Integer(
        string='Plan Value',
        default=86400
    )

    # Redefine default - using date_start from base project.task
    date_start = fields.Datetime(
        string='Starting Date',
        default=_default_date_start,
        index=True,
        copy=False
    )

    # Note: date_end exists in Odoo 18 project.task

    # Color
    color_gantt_set = fields.Boolean(
        string="Set Color Task",
        default=False
    )
    color_gantt = fields.Char(
        string="Color Task Bar",
        help="Choose your color for Task Bar",
        default="rgba(170,170,13,0.53)"
    )

    # Humanize duration
    duration_scale = fields.Char(
        string='Duration Scale',
        related="project_id.duration_scale",
        readonly=True
    )
    duration_picker = fields.Selection(
        string='Duration Picker',
        related="project_id.duration_picker",
        readonly=True
    )
    duration_work_scale = fields.Char(
        string='Duration Work Scale',
        related="project_id.duration_work_scale",
        readonly=True
    )

    # Summary dates
    summary_date_start = fields.Datetime(
        compute='_get_summary_date',
        string="Summary Date Start",
        store=False
    )
    summary_date_end = fields.Datetime(
        compute='_get_summary_date',
        string="Summary Date End",
        store=False
    )

    # Loop detection
    p_loop = fields.Boolean(string="Loop Detected")

    # Tree sorting
    fold = fields.Boolean(
        string="Fold Task",
        help="Fold task in Gantt view",
        default=False
    )
    sorting_seq = fields.Integer(
        string='Sorting Seq.',
        default=0
    )
    sorting_level = fields.Integer(
        string='Sorting Level',
        default=0
    )

    # Critical path
    critical_path = fields.Boolean(
        string="is Critical Path",
        help="is Critical Path",
        default=False,
        readonly=True
    )
    cp_shows = fields.Boolean(
        string='Critical Path',
        related="project_id.cp_shows",
        readonly=True
    )
    cp_detail = fields.Boolean(
        string='Critical Path Detail',
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
        if hasattr(super(ProjectTaskNative, self), '_onchange_project'):
            if self._origin.id:
                if self.env['project.task.predecessor'].search(
                        ['|', ('task_id', '=', self._origin.id), ('parent_task_id', '=', self._origin.id)], limit=1):
                    raise UserError(_(
                        'You can not change a Project for task.\nPlease Delete - Predecessor: for parent or child.'))

                if self.search([('parent_id', '=', self._origin.id)], limit=1):
                    raise UserError(_(
                        'You can not change a Project for Task.\nPlease Delete or Remove - sub tasks first.'))

            super(ProjectTaskNative, self)._onchange_project()

    @api.depends("predecessor_ids")
    def _compute_predecessor_count(self):
        """Compute predecessor count - Odoo 18 best practice: no write() in compute.

        Note: predecessor_parent is now maintained by project.task.predecessor
        model's create/write/unlink methods to avoid side effects in compute.
        """
        if not self:
            return

        # Batch query: get all parent task counts in one query
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
            raise UserError(_('Project not found.'))

        scheduling_type = search_project.scheduling_type

        if scheduling_type == "manual":
            raise UserError(_(
                'Not work in manual mode. Please set in project: Backward or Forward'))

        # project_task_scheduler.py
        self._scheduler_plan_start_calc(project=search_project)
        self._summary_work(project_id=project_id)
        self._scheduler_plan_complite(project_id=project_id, scheduling_type=scheduling_type)

        return True

    def _scheduler_plan_complite(self, project_id, scheduling_type):
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
                var_data = {
                    "date_start": task.summary_date_start,
                    "date_end": task.summary_date_end,
                }

                # Odoo 18: datetime fields are already datetime objects
                if task.summary_date_end and task.summary_date_start:
                    diff = task.summary_date_end - task.summary_date_start
                    var_data["plan_duration"] = diff.total_seconds()

                task.write(var_data)

    @api.depends("predecessor_ids.task_id", "predecessor_ids.type", "constrain_type", "constrain_date", "plan_duration",
                 "duration", "project_id.scheduling_type", "task_resource_ids.name")
    def _compute_plan_action(self):
        for task in self:
            if task.schedule_mode != "manual":
                task.plan_action = True
            else:
                task.plan_action = False

    @api.depends('date_end', 'date_start')
    def _compute_duration(self):
        """Compute task duration in seconds - Odoo 18 style"""
        for task in self:
            if task.date_end and task.date_start:
                # Odoo 18: datetime fields are already datetime objects
                diff = task.date_end - task.date_start
                task.duration = int(diff.total_seconds())
            else:
                task.duration = 0

    def unlink(self):
        if self.search([('parent_id', 'in', self.ids)], limit=1):
            raise UserError(_(
                'You can not delete a Parent Task.\nPlease Delete - sub tasks first.'))
        return super(ProjectTaskNative, self).unlink()

    def conv_sec_tofloat(self, sec, type="sec"):
        if type == "sec":
            tde = timedelta(seconds=sec)
        if type == "hrs":
            tde = timedelta(hours=sec)
        return tde.total_seconds() / timedelta(hours=1).total_seconds()

    # Note: _check_subtask_level removed - empty constraint served no purpose
