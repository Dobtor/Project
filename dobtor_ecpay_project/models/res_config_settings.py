from odoo import fields, models, api

class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"
    
    delivery_complete_stage = fields.Many2one("project.task.type", related="company_id.delivery_complete_stage", string="Delivery Complete Task Stage", readonly=False)