# -*- coding: utf-8 -*-

from odoo import models, fields, api


class project(models.Model):
    _inherit = 'project.project'

    @api.multi
    def _compute_issue_count(self):
        for project in self:
            project.issue_count = self.env['project.issue'].search_count(
                [('project_id', '=', project.id), ('issue_stage_id', 'not in', ['Done', 'Cancelled'])])
