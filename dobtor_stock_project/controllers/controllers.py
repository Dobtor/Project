# -*- coding: utf-8 -*-
# from odoo import http


# class DobtorStockProject(http.Controller):
#     @http.route('/dobtor_stock_project/dobtor_stock_project', auth='public')
#     def index(self, **kw):
#         return "Hello, world"

#     @http.route('/dobtor_stock_project/dobtor_stock_project/objects', auth='public')
#     def list(self, **kw):
#         return http.request.render('dobtor_stock_project.listing', {
#             'root': '/dobtor_stock_project/dobtor_stock_project',
#             'objects': http.request.env['dobtor_stock_project.dobtor_stock_project'].search([]),
#         })

#     @http.route('/dobtor_stock_project/dobtor_stock_project/objects/<model("dobtor_stock_project.dobtor_stock_project"):obj>', auth='public')
#     def object(self, obj, **kw):
#         return http.request.render('dobtor_stock_project.object', {
#             'object': obj
#         })

