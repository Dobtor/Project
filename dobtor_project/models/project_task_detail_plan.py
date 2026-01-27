# -*- coding: utf-8 -*-
from odoo import models, fields, api, _, Command


class ProjectTaskDetailPlan(models.Model):
    _name = 'project.task.detail.plan'
    _description = "Project Task Detail Plan"

    @api.model
    def _get_type(self):
        return [
            ('cut', _('Cut of DateTime')),
            ('attendance', _('Attendance')),
        ]

    @api.depends('resource_id', 'name_att')
    def _compute_name(self):
        for rec in self:
            rec.name = "{} - {}".format(rec.name_att or "", rec.resource_id.name or "")

    name = fields.Char(
        string="Name",
        compute='_compute_name',
        readonly=True,
        store=True
    )

    task_id = fields.Many2one(
        'project.task',
        string='Task',
        readonly=True,
        ondelete='cascade'
    )
    type_level = fields.Selection(
        selection='_get_type',
        string='Type',
        readonly=True
    )

    data_from = fields.Datetime(
        string="Date From",
        readonly=True
    )
    data_to = fields.Datetime(
        string="Date To",
        readonly=True
    )
    duration = fields.Integer(
        string='Duration',
        readonly=True
    )
    iteration = fields.Integer(
        string='iteration',
        readonly=True
    )
    name_att = fields.Char(
        string="Name att",
        readonly=True
    )
    resource_id = fields.Many2one(
        'resource.resource',
        string='Resource',
        readonly=True
    )

    color_gantt_set = fields.Boolean(
        string="Set Color Task",
        default=True
    )
    color_gantt = fields.Char(
        string="Color",
        store=True,
        default="rgba(170,170,13,0.53)",
        compute='_compute_color_gantt'
    )

    schedule_mode = fields.Selection(
        selection=[('auto', 'Auto'), ('manual', 'Manual')],
        string='Schedule Mode',
        default='auto',
        readonly=True
    )

    data_aggr = fields.Date(
        string="Date Aggr.",
        readonly=True
    )

    @api.depends('type_level')
    def _compute_color_gantt(self):
        for plan in self:
            if plan.type_level == "cut":
                plan.color_gantt = "rgba(190,170,23,0.53)"
            else:
                plan.color_gantt = "rgba(170,170,13,0.53)"


class ProjectTaskDetailPlanMixin(models.Model):
    _inherit = 'project.task'

    @api.depends("detail_plan_ids", "detail_plan_ids.duration")
    def _compute_detail_plan_count(self):
        """Optimized computation using mapped() instead of loops"""
        for task in self:
            detail_plans = task.detail_plan_ids
            task.detail_plan_count = len(detail_plans)
            # Use sum with mapped for efficient aggregation
            task.detail_plan_work = sum(detail_plans.mapped('duration'))

    detail_plan_count = fields.Integer(
        compute='_compute_detail_plan_count',
        string='Detail plan Count',
        store=True
    )
    detail_plan_ids = fields.One2many(
        'project.task.detail.plan',
        'task_id',
        string='Detail Plan List'
    )
    detail_plan = fields.Boolean(
        string="Detail Plan",
        help="Allow Save Detail Plan",
        default=False
    )
    detail_plan_work = fields.Integer(
        compute='_compute_detail_plan_count',
        string='Detail plan work',
        store=True
    )

    def _add_detail_plan(self, calendar_level):
        task_detail_lines = []

        for level in calendar_level:
            resource_id = False
            if level["res_ids"] and level["res_ids"] != -1:
                resource_id = level["res_ids"]

            value = {
                "name": level["name"],
                "type_level": level["type"],
                "data_from": level["date_from"],
                "data_to": level["date_to"],
                "duration": level["interval"].total_seconds(),
                "iteration": level["iteration"],
                "name_att": level["name"],
                "data_aggr": level["date_from"].date() if hasattr(level["date_from"], 'date') else level["date_from"],
                "resource_id": resource_id
            }

            task_detail_lines.append(Command.create(value))
        return task_detail_lines
