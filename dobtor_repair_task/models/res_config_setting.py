# -*- coding: utf-8 -*-
from odoo import models, fields, api, _


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'
    
    cancel_stage = fields.Many2one('project.task.type', related='company_id.cancel_stage', string='Cancel Stage', readonly=False)
    done_stage = fields.Many2one('project.task.type', related='company_id.done_stage', string='Done Stage', readonly=False)
    process_stage = fields.Many2one('project.task.type', related='company_id.process_stage', string='Process Stage', readonly=False)
    rma_done_stage = fields.Many2one('project.task.type', related='company_id.rma_done_stage', string='Return To Manufacturer Done Stage', readonly=False)
    installation_task_product = fields.Many2one('product.product', related='company_id.installation_task_product', string='Installation Task Product', readonly=False)
    repair_task_product = fields.Many2one('product.product', related='company_id.repair_task_product', string='Repair Task Product', readonly=False)
    repair_return_task_product = fields.Many2one('product.product', related='company_id.repair_return_task_product', string='Repair(Return) Task Product', readonly=False)
    return_task_product = fields.Many2one('product.product', related='company_id.return_task_product', string='Return Task Product', readonly=False)
