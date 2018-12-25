# -*- coding: utf-8 -*-

from odoo import models, fields, api
from odoo.tools.translate import _


class dobtor_project_issue_extend(models.Model):
    _inherit = 'project.issue'

    name = fields.Char(
        string='Issue',
        stord=True,
        required=False,
        copy=False,
        compute='_compute_name'
    )
    is_serial = fields.Boolean(
        string='is_serial',
    )
    open_serial = fields.Boolean(
        string='Using Serial',
        default=True,
        help="using serial",
    )
    serial_number = fields.Char(
        string='serial_number',
        required=True,
        readonly=True,
        copy=False,
        default='',
    )
    topic = fields.Char(
        string='Issue Topic',
        required=True,
        default='New',
    )
    sub_ids = fields.One2many(
        string="Sub Issue",
        comodel_name='project.issue',
        inverse_name='main_id',
        copy=False,
    )
    main_id = fields.Many2one(
        comodel_name='project.issue',
        string="Resource",
        copy=False,
        readonly=True,
    )
    description = fields.Html(
        string='Private Note',
    )
    attachment_number = fields.Integer(
        compute='_compute_attachment_number',
        string='Number of Attachments',
        copy=False,
    )
    subissue_number = fields.Integer(
        compute='_compute_subissue_number',
        string='Number of Subissue',
        copy=False,
    )
    fold = fields.Boolean(
        string='Folded in Issues Pipeline',
        related='issue_stage_id.fold',
    )

    @api.multi
    def action_serial(self):
        for record in self:
            record.write({
                'topic': record.name,
                'serial_number': record.env['ir.sequence'].next_by_code('project.issue'),
                'is_serial': True,
            }) 

    @api.model
    def _query_origin_name(self, record, current_id):
        record.env.cr.execute(
            'select name from project_issue where id = %s',
            (current_id,)
        )
        return record.env.cr.fetchall()

    @api.model
    def _update_topic(self, record, topic):
        record.env.cr.execute(
            "update project_issue set topic = %s where id = %s",
            (topic, record.id)
        )

    @api.model
    def _update_name(self, record, name):
        record.env.cr.execute(
            "update project_issue set name = %s where id = %s",
            (name, record.id)
        )


    @api.multi
    def write(self, vals):
        if self._query_origin_name(self, self.id) != vals.get('topic'):
            self._update_name(self,vals.get('topic'))
        res = super(dobtor_project_issue_extend, self).write(vals)
        return True

    @api.multi
    @api.depends('serial_number', 'topic', 'is_serial')
    def _compute_name(self):
        for record in self:
            if record.is_serial:
                record.name = (record.serial_number or '') + ' ' + record.topic
            else:
                if record.topic == 'New' and record.id:
                    res = self._query_origin_name(record, record.id)
                    if len(res) > 0:
                        old_name = res[0][0]
                        if old_name:
                            record.topic = old_name or record.topic
                            record._update_topic(record, old_name)
                record.name = record.topic

    @api.multi
    def _compute_attachment_number(self):
        attachment_data = self.env['ir.attachment'].read_group(
            [('res_model', '=', self._name), ('res_id', 'in', self.ids)], ['res_id'], ['res_id'])
        attachment = dict((res['res_id'], res['res_id_count'])
                          for res in attachment_data)
        for record in self:
            record.attachment_number = attachment.get(record.id, 0)

    @api.multi
    def _get_attachment_domain(self, obj):
        return [
            '&',
            ('res_model', '=', self._name),
            ('res_id', 'in', obj.ids),
        ]

    @api.multi
    def attachment_tree_view(self):
        self.ensure_one()
        return {
            'name':  _('Attachments'),
            'domain': self._get_attachment_domain(self),
            'res_model': 'ir.attachment',
            'type': 'ir.actions.act_window',
            'view_id': False,
            'view_mode': 'kanban,tree,form',
            'view_type': 'form',
            'limit': 80,
            'context': "{'form_view_ref': 'dobtor_project_core.view_project_core_attachment_form', 'default_res_model': '%s','default_res_id': %d}" % (self._name, self.id)
        }

    @api.model
    def create(self, vals):
        if not vals.get('main_id', False) and vals.get('open_serial', False):
            vals['serial_number'] = self.env['ir.sequence'].next_by_code(
                'project.issue')
            vals['is_serial'] = True
        res = super(dobtor_project_issue_extend, self).create(vals)
        self._update_name(res, res.topic)
        return res

    @api.multi
    def action_create_subissue(self):
        """ Create subissue """

        res = self.copy(default={
            'serial_number': "%s-%s" % (self.serial_number, len(self.sub_ids) + 1) if self.is_serial else '',
            'main_id': self.id,
            'topic': self.topic if self.is_serial else 'Sub/' + self.topic,
        })
        return {
            'name': _(self._name + 'Subissue'),
            "type": "ir.actions.act_window",
            'res_model': self._name,
            "view_type": "form",
            "view_mode": "form",
            'res_id': res.id,
            'target': "self",
            'target': 'current',
        }

    @api.multi
    def _compute_subissue_number(self):
        for record in self:
            record.subissue_number = len(record.sub_ids)

    @api.multi
    def action_subissue_tree_view(self):
        self.ensure_one()
        return {
            'name':  _('Subissue'),
            'domain': [('main_id', '=', self.id)],
            'res_model': 'project.issue',
            'type': 'ir.actions.act_window',
            'view_id': False,
            'view_mode': 'kanban,tree,form',
            'view_type': 'form',
            'limit': 80,
            'context': "{'kanban_view_ref': 'project_issue_stage.project_issue_kanban_view','search_default_project_id': [%d], 'default_project_id': %d, }" % (self.project_id.id, self.project_id.id),
        }
