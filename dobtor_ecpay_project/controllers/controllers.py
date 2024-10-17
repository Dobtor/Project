# -*- coding: utf-8 -*-
# from odoo import http


# class DobtorEcpayProject(http.Controller):
#     @http.route('/dobtor_ecpay_project/dobtor_ecpay_project', auth='public')
#     def index(self, **kw):
#         return "Hello, world"

#     @http.route('/dobtor_ecpay_project/dobtor_ecpay_project/objects', auth='public')
#     def list(self, **kw):
#         return http.request.render('dobtor_ecpay_project.listing', {
#             'root': '/dobtor_ecpay_project/dobtor_ecpay_project',
#             'objects': http.request.env['dobtor_ecpay_project.dobtor_ecpay_project'].search([]),
#         })

#     @http.route('/dobtor_ecpay_project/dobtor_ecpay_project/objects/<model("dobtor_ecpay_project.dobtor_ecpay_project"):obj>', auth='public')
#     def object(self, obj, **kw):
#         return http.request.render('dobtor_ecpay_project.object', {
#             'object': obj
#         })

