from odoo import fields, models, api

class ResCompany(models.Model):
    _inherit = "res.company"
    
    stock_delivery_stage = fields.Many2one("project.task.type", string="Stock Delivery Task Stage")
    