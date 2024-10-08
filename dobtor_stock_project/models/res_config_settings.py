from odoo import fields, models, api

class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"
    
    stock_delivery_stage = fields.Many2one("project.task.type", related="company_id.stock_delivery_stage", string="Stock Delivery Stage", readonly=False)