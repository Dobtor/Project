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
            record.topic = record.name
            record.serial_number = record.env['ir.sequence'].next_by_code(
                'project.issue')
            record.is_serial = True

    @api.model
    def _query_origin_name(self, record, current_id):
        record.env.cr.execute(
            'select name from project_issue where id = %s',
            (current_id,)
        )
        return record.env.cr.fetchall()

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
                        record.topic = res[0][0] or record.topic
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
            'context': "{'default_res_model': '%s','default_res_id': %d}" % (self._name, self.id)
        }

    @api.model
    def create(self, vals):
        if not vals.get('main_id', False):
            vals['serial_number'] = self.env['ir.sequence'].next_by_code(
                'project.issue')
            vals['is_serial'] = True
        return super(dobtor_project_issue_extend, self).create(vals)

    @api.multi
    def action_create_subissue(self):
        """ Create subissue """

        res = self.copy(default={
            'serial_number': "%s-%s" % (self.serial_number, len(self.sub_ids) + 1) if self.is_serial else '',
            'main_id': self.id,
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
            'context': "{'kanban_view_ref': 'project_issue_stage.project_issue_kanban_view', }",
        }
