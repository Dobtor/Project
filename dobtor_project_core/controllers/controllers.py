# -*- coding: utf-8 -*-
from odoo import http

# class DobtorProjectCore(http.Controller):
#     @http.route('/dobtor_project_core/dobtor_project_core/', auth='public')
#     def index(self, **kw):
#         return "Hello, world"

#     @http.route('/dobtor_project_core/dobtor_project_core/objects/', auth='public')
#     def list(self, **kw):
#         return http.request.render('dobtor_project_core.listing', {
#             'root': '/dobtor_project_core/dobtor_project_core',
#             'objects': http.request.env['dobtor_project_core.dobtor_project_core'].search([]),
#         })

#     @http.route('/dobtor_project_core/dobtor_project_core/objects/<model("dobtor_project_core.dobtor_project_core"):obj>/', auth='public')
#     def object(self, obj, **kw):
#         return http.request.render('dobtor_project_core.object', {
#             'object': obj
#         })