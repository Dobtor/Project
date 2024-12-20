# -*- coding: utf-8 -*-
from odoo import models, fields, api


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    distributor_ids = fields.Many2many('res.users', string='Distributors')
    
    def _timesheet_create_task(self, project):
        task = super()._timesheet_create_task(project)

        if self.distributor_ids:
            user_ids_write = [(4, user_id) for user_id in self.distributor_ids.ids]
            task.write({
                'user_ids': user_ids_write
            })
        return task
