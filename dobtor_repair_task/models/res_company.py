# -*- coding: utf-8 -*-
from odoo import fields, models, api

class ResCompany(models.Model):
    _inherit = 'res.company'

    def _get_task_product_domain(self):
        return [
            ('sale_ok', '=', True),
            ('detailed_type', '=', 'service'),
            ('service_tracking', '=', 'task_global_project'),
        ]
    
    cancel_stage = fields.Many2one('project.task.type', string='Cancel Stage')
    done_stage = fields.Many2one('project.task.type', string='Done Stage')
    process_stage = fields.Many2one('project.task.type', string='Process Stage')
    rma_done_stage = fields.Many2one('project.task.type', string='Return To Manufacturer Done Stage')
    installation_task_product = fields.Many2one('product.product', string='Installation Task Product', domain=_get_task_product_domain)
    repair_task_product = fields.Many2one('product.product', string='Repair Task Product', domain=_get_task_product_domain)
    repair_return_task_product = fields.Many2one('product.product', string='Repair(Return) Task Product', domain=_get_task_product_domain)
    return_task_product = fields.Many2one('product.product', string='Return Task Product', domain=_get_task_product_domain)
