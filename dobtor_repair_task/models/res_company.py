# -*- coding: utf-8 -*-
from odoo import fields, models, api

class ResCompany(models.Model):
    _inherit = 'res.company'

    def _get_task_product_domain(self):
        return [
            ('website_published', '=', True),
            ('sale_ok', '=', True),
            ('detailed_type', '=', 'service'),
            ('service_tracking', '=', 'task_global_project'),
        ]
    
    on_site_done_stage = fields.Many2one('project.task.type', string='On Site Done Stage')
    factory_return_stage = fields.Many2one('project.task.type', string='Factory Return Stage')
    installation_task_product = fields.Many2one('product.product', string='Installation Task Product', domain=_get_task_product_domain)
    repair_task_product = fields.Many2one('product.product', string='Repair Task Product', domain=_get_task_product_domain)
    return_task_product = fields.Many2one('product.product', string='Return Task Product', domain=_get_task_product_domain)
