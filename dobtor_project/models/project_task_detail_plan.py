# -*- coding: utf-8 -*-
from odoo import models, fields, api, _, Command


class ProjectTaskDetailPlan(models.Model):
    _name = 'project.task.detail.plan'
    _description = "Project Task Detail Plan"

    @api.model
    def _get_type(self):
        return [
            ('cut', _('日期時間截斷')),
            ('attendance', _('出勤')),
        ]

    @api.depends('resource_id', 'resource_id.name', 'name_att')
    def _compute_name(self):
        for rec in self:
            rec.name = "{} - {}".format(rec.name_att or "", rec.resource_id.name or "")

    name = fields.Char(
        string="名稱",
        compute='_compute_name',
        readonly=True,
        store=True
    )

    task_id = fields.Many2one(
        'project.task',
        string='任務',
        readonly=True,
        ondelete='cascade'
    )
    type_level = fields.Selection(
        selection='_get_type',
        string='類型',
        readonly=True
    )

    date_from = fields.Datetime(
        string="開始日期",
        readonly=True
    )
    date_to = fields.Datetime(
        string="結束日期",
        readonly=True
    )
    duration = fields.Float(
        string='工期（小時）',
        readonly=True
    )
    iteration = fields.Integer(
        string='迭代次數',
        readonly=True
    )
    name_att = fields.Char(
        string="出勤名稱",
        readonly=True
    )
    resource_id = fields.Many2one(
        'resource.resource',
        string='資源',
        readonly=True
    )

    color_gantt = fields.Integer(
        string="顏色",
        store=True,
        default=3,
        compute='_compute_color_gantt'
    )

    schedule_mode = fields.Selection(
        selection=[('auto', 'Auto'), ('manual', 'Manual')],
        string='排程模式',
        default='auto',
        readonly=True
    )

    date_aggr = fields.Date(
        string="彙總日期",
        readonly=True
    )

    @api.depends('type_level')
    def _compute_color_gantt(self):
        for plan in self:
            if plan.type_level == "cut":
                plan.color_gantt = 3  # Yellow
            else:
                plan.color_gantt = 2  # Orange


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
        string='細節計劃數',
        store=True
    )
    detail_plan_ids = fields.One2many(
        'project.task.detail.plan',
        'task_id',
        string='細節計劃列表'
    )
    detail_plan = fields.Boolean(
        string="細節計劃",
        help="允許儲存排程細節計劃",
        default=False
    )
    detail_plan_work = fields.Float(
        compute='_compute_detail_plan_count',
        string='細節工時（小時）',
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
                "date_from": level["date_from"],
                "date_to": level["date_to"],
                "duration": level["interval"].total_seconds() / 3600.0,
                "iteration": level["iteration"],
                "name_att": level["name"],
                "date_aggr": level["date_from"].date() if hasattr(level["date_from"], 'date') else level["date_from"],
                "resource_id": resource_id
            }

            task_detail_lines.append(Command.create(value))
        return task_detail_lines
