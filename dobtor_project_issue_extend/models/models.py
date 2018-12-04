# -*- coding: utf-8 -*-

from odoo import models, fields, api


class dobtor_project_issue_extend(models.Model):
    _inherit = 'project.issue'

    name = fields.Char(string='Issue', required=True, copy=False, readonly=True, index=True, default=lambda self: ('New'))


    @api.model
    def create(self, vals):
        context = dict(self.env.context)
        if vals.get('project_id') and not self.env.context.get('default_project_id'):
            context['default_project_id'] = vals.get('project_id')
        if vals.get('user_id') and not vals.get('date_open'):
            vals['date_open'] = fields.Datetime.now()
        if 'stage_id' in vals:
            vals.update(self.update_date_closed(vals['stage_id']))
        if vals.get('name', ('New')) == ('New'):
            vals['name'] = self.env['ir.sequence'].next_by_code('project.issue') or ('New')

        # context: no_log, because subtype already handle this
        context['mail_create_nolog'] = True
        return super(dobtor_project_issue_extend, self.with_context(context)).create(vals)


    
    description = fields.Html(
        string=u'Private Note',
    )
    issue_attachment = fields.One2many(
        string=u'Issue Attachment',
        comodel_name='ir.attachment',
        inverse_name='issue_attachment_id',
    )
    @api.multi
    def attachment_tree_view(self):
        self.ensure_one()
        return {
            'name': 'Attachments',
            'domain': self._get_attachment_domain(self),
            'res_model': 'ir.attachment',
            'type': 'ir.actions.act_window',
            'view_id': False,
            'view_mode': 'kanban,tree,form',
            'view_type': 'form',
            'help': ('''<p class="oe_view_nocontent_create">
                        Documents are attached to the tasks and issues of your project.</p><p>
                        Send messages or log internal notes with attachments to link
                        documents to your project.
                    </p>'''),
            'limit': 80,
            'context': "{'default_res_model': '%s','default_res_id': %d}" % (self._name, self.id)
        }
        
    @api.multi
    def _get_attachment_domain(self, obj):
        return [
            # '|',
            # '&',
            # ('res_model', '=', 'project.project'),
            # ('res_id', 'in', obj.ids),
            '&',
            ('res_model', '=', self._name),
            ('res_id', 'in', obj.ids),
        ]

    # region upload freature (Attchment)
    # @api.multi
    # def _get_issue_ids(slef, obj):
    #     issue_ids = []
    #     for issue_id in obj.task_ids:
    #         for todo_id in tsak_id.todolist_ids.ids:
    #             todolist_ids.append(todo_id)
    #     return todolist_ids
    
class issue_attachment_extend(models.Model):
    _inherit = 'ir.attachment'

    issue_attachment_id = fields.Many2one(
        string=u'Issue Attachment ID',
        comodel_name='project.issue',
    )
    

class project(models.Model):
    _inherit = 'project.project'

    @api.multi
    def _compute_issue_count(self):
        for project in self:
            project.issue_count = self.env['project.issue'].search_count([('project_id', '=', project.id), ('issue_stage_id', 'not in', ['Done','Cancelled'])])




