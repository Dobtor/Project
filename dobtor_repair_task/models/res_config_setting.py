# -*- coding: utf-8 -*-
from odoo import models, fields, api, _


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'
    
    on_site_done_stage = fields.Many2one('project.task.type', related='company_id.on_site_done_stage', string='On Site Done Stage', readonly=False)
    factory_return_stage = fields.Many2one('project.task.type', related='company_id.factory_return_stage', string='Factory Return Stage', readonly=False)
    installation_task_product = fields.Many2one('product.product', related='company_id.installation_task_product', string='Installation Task Product', readonly=False)
    repair_task_product = fields.Many2one('product.product', related='company_id.repair_task_product', string='Repair Task Product', readonly=False)
    return_task_product = fields.Many2one('product.product', related='company_id.return_task_product', string='Return Task Product', readonly=False)