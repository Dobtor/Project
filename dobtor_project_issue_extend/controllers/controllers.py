# -*- coding: utf-8 -*-
from odoo import http

# class DobtorProjectIssueExtend(http.Controller):
#     @http.route('/dobtor_project_issue_extend/dobtor_project_issue_extend/', auth='public')
#     def index(self, **kw):
#         return "Hello, world"

#     @http.route('/dobtor_project_issue_extend/dobtor_project_issue_extend/objects/', auth='public')
#     def list(self, **kw):
#         return http.request.render('dobtor_project_issue_extend.listing', {
#             'root': '/dobtor_project_issue_extend/dobtor_project_issue_extend',
#             'objects': http.request.env['dobtor_project_issue_extend.dobtor_project_issue_extend'].search([]),
#         })

#     @http.route('/dobtor_project_issue_extend/dobtor_project_issue_extend/objects/<model("dobtor_project_issue_extend.dobtor_project_issue_extend"):obj>/', auth='public')
#     def object(self, obj, **kw):
#         return http.request.render('dobtor_project_issue_extend.object', {
#             'object': obj
#         })