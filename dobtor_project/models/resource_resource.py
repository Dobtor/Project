# -*- coding: utf-8 -*-
from odoo import models, fields


class ResourceAps(models.Model):
    _inherit = 'resource.resource'

    resource_task_ids = fields.One2many(
        'project.task.resource.link',
        'resource_id',
        string='資源'
    )
    max_capacity = fields.Float(
        string='可用容量',
        default=1.0,
        help='資源在同一時間可承擔的最大負載總和（1.0 = 100%）。'
             '同時段已指派任務的負載率（load_factor）總和超過此值即視為過載。'
    )
    cost_rate = fields.Monetary(
        string='每小時成本',
        currency_field='cost_currency_id',
        groups='dobtor_project.group_project_cost_manager',
        help='資源每工作小時的成本，用於賺得值（EV）與成本分析。'
    )
    cost_currency_id = fields.Many2one(
        'res.currency',
        string='成本幣別',
        default=lambda self: self.env.company.currency_id,
        groups='dobtor_project.group_project_cost_manager',
    )
