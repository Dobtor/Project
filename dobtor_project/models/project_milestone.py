# -*- coding: utf-8 -*-

from odoo import models, fields


class ProjectMilestone(models.Model):
    _inherit = 'project.milestone'

    sorting_seq = fields.Integer(string='排序序號', default=0)
    color_gantt = fields.Integer(
        string="顏色",
        help="甘特圖顏色索引 (0=無自訂顏色, 1-11=固定色)",
        default=0
    )
