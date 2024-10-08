# -*- coding: utf-8 -*-
# from odoo import http


# class DobtorProjectSms(http.Controller):
#     @http.route('/dobtor_project_sms/dobtor_project_sms', auth='public')
#     def index(self, **kw):
#         return "Hello, world"

#     @http.route('/dobtor_project_sms/dobtor_project_sms/objects', auth='public')
#     def list(self, **kw):
#         return http.request.render('dobtor_project_sms.listing', {
#             'root': '/dobtor_project_sms/dobtor_project_sms',
#             'objects': http.request.env['dobtor_project_sms.dobtor_project_sms'].search([]),
#         })

#     @http.route('/dobtor_project_sms/dobtor_project_sms/objects/<model("dobtor_project_sms.dobtor_project_sms"):obj>', auth='public')
#     def object(self, obj, **kw):
#         return http.request.render('dobtor_project_sms.object', {
#             'object': obj
#         })

