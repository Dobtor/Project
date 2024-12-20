# -*- coding: utf-8 -*-
# from odoo import http


# class DobtorRepairTask(http.Controller):
#     @http.route('/dobtor_repair_task/dobtor_repair_task', auth='public')
#     def index(self, **kw):
#         return "Hello, world"

#     @http.route('/dobtor_repair_task/dobtor_repair_task/objects', auth='public')
#     def list(self, **kw):
#         return http.request.render('dobtor_repair_task.listing', {
#             'root': '/dobtor_repair_task/dobtor_repair_task',
#             'objects': http.request.env['dobtor_repair_task.dobtor_repair_task'].search([]),
#         })

#     @http.route('/dobtor_repair_task/dobtor_repair_task/objects/<model("dobtor_repair_task.dobtor_repair_task"):obj>', auth='public')
#     def object(self, obj, **kw):
#         return http.request.render('dobtor_repair_task.object', {
#             'object': obj
#         })

