from odoo import fields, models, api

class ResCompany(models.Model):
    _inherit = "res.company"
    
    delivery_complete_stage = fields.Many2one("project.task.type", string="Delivery Complete Task Stage")
    