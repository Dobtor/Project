# -*- coding: utf-8 -*-

# from odoo import models, fields, api


# class dobtor_stock_project(models.Model):
#     _name = 'dobtor_stock_project.dobtor_stock_project'
#     _description = 'dobtor_stock_project.dobtor_stock_project'

#     name = fields.Char()
#     value = fields.Integer()
#     value2 = fields.Float(compute="_value_pc", store=True)
#     description = fields.Text()
#
#     @api.depends('value')
#     def _value_pc(self):
#         for record in self:
#             record.value2 = float(record.value) / 100

