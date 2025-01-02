# -*- coding: utf-8 -*-
from odoo import models, fields, api


class Task(models.Model):
    _inherit = 'project.task'

    user_ids = fields.Many2many(domain="[('active', '=', True)]")
    return_repair_ids = fields.One2many('repair.order', 'return_task_id', string='Return Repairs')
    fix_repair_ids = fields.One2many('repair.order', 'repair_task_id', string='Fix Repairs')
