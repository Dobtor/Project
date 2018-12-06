# -*- coding: utf-8 -*-

from odoo import models, fields, api


class dobtor_project_issue_extend(models.Model):
    _inherit = 'project.issue'

    name = fields.Char(string='Issue', required=True, copy=False,
                       readonly=True, index=True, default=lambda self: ('New'))
    sub_ids = fields.One2many('project.issue', 'main_id', string="Sub Issue")
    main_id = fields.Many2one('project.issue', "Main Issue")

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
            vals['name'] = self.env['ir.sequence'].next_by_code(
                'project.issue') or ('New')

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

    @api.multi
    def action_create_subissue(self):
        # name = "{0}-{1}".format(self.name, len(self.sub_ids) + 1)
        # name = "%s-%s" %(self.name, len(self.sub_ids) +1)
        res = {
            'name': "Create Sub RMA",
            "type": "ir.actions.act_window",
            'res_model': "project.issue",
            "view_type": "form",
            "view_mode": "form",
            'target': "self",
            "context": {
                # 'default_name': name,
                'default_main_id': self.id,
                'default_project_id': self.project_id.id,
            }
        }

        return res


class issue_attachment_extend(models.Model):
    _inherit = 'ir.attachment'

    issue_attachment_id = fields.Many2one(
        string=u'Issue Attachment ID',
        comodel_name='project.issue',
    )