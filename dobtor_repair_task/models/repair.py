# -*- coding: utf-8 -*-
from odoo import models, fields, api


class Repair(models.Model):
    _inherit = 'repair.order'

    task_order_id = fields.Many2one(
        'sale.order', 'Task Order', check_company=True, readonly=True, copy=False)

    def action_view_task_order(self):
        return {
            "type": "ir.actions.act_window",
            "res_model": "sale.order",
            "views": [[False, "form"]],
            "res_id": self.task_order_id.id,
        }