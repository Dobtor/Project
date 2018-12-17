# -*- coding: utf-8 -*-

from odoo import models, fields, api



class project(models.Model):
    _inherit = 'project.project'

    @api.multi
    def _get_attachment_domain(self, obj):
        return [
            '|',
            '&',
            ('res_model', '=', 'project.project'),
            ('res_id', 'in', obj.ids),
            '&',
            ('res_model', '=', 'project.task'),
            ('res_id', 'in', obj.task_ids.ids),
        ]

    @api.multi
    def _compute_attached_docs_count(self):
        for project in self:
            project.doc_count = self.env['ir.attachment'].search_count(
                self._get_attachment_domain(project))

    @api.multi
    def attachment_tree_view(self):
        act_window = super(project, self).attachment_tree_view()
        act_window.update({
            'domain': self._get_attachment_domain(self),
        })
        return act_window
