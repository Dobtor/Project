# -*- coding: utf-8 -*-

from odoo import models, fields, api



class project(models.Model):
    _inherit = 'project.project'

    @api.multi
    def _get_attachment_domain(self):
        for obj in self:
            return [
                '|',
                '&',
                ('res_model', '=', 'project.project'),
                ('res_id', '=', obj.id),
                '&',
                ('res_model', '=', 'project.task'),
                ('res_id', 'in', obj.task_ids.ids),
            ]

    @api.multi
    def _compute_attached_docs_count(self):
        for project in self:
            project.doc_count = self.env['ir.attachment'].search_count(
                project._get_attachment_domain())

    @api.multi
    def attachment_tree_view(self):
        self.ensure_one()
        act_window = super(project, self).attachment_tree_view()
        act_window.update({
            'domain': self._get_attachment_domain(),
            'context': "{'form_view_ref': 'dobtor_project_core.view_project_core_attachment_form', 'default_res_model': '%s','default_res_id': %d}" % (self._name, self.id)
        })
        return act_window
