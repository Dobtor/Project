# -*- coding: utf-8 -*-

from odoo import models, fields, api


class project(models.Model):
    _inherit = 'project.project'

    @api.multi
    def _compute_issue_count(self):
        for project in self:
            project.issue_count = self.env['project.issue'].search_count(
                [
                    ('project_id', '=', project.id),
                    ('fold', '=', False)
                ]
            )

    @api.multi
    def _get_attachment_domain(self, obj):
        domain = super(project, self)._get_attachment_domain(self)
        issue_domain = [
            '&',
            ('res_model', '=', 'project.issue'),
            ('res_id', 'in', obj.issue_ids.ids),
        ]
        return ['|'] + domain + issue_domain
