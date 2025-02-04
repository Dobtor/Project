# -*- coding: utf-8 -*-
from odoo import models, fields, api


class Task(models.Model):
    _inherit = 'project.task'

    user_ids = fields.Many2many(domain="[('active', '=', True)]")
    return_repair_ids = fields.One2many('repair.order', 'return_task_id', string='Return Repairs')
    fix_repair_ids = fields.One2many('repair.order', 'repair_task_id', string='Fix Repairs')

    def action_view_return_rpo(self):
        action = self.env['ir.actions.act_window']._for_xml_id('repair.action_repair_order_tree')

        if len(self.return_repair_ids) == 1:
            action['view_mode'] = 'form'
            action['res_id'] = self.return_repair_ids.id
            action['views'] = []
        else:
            action['domain'] = [('id', 'in', self.return_repair_ids.ids)]

        return action
    
    def action_view_repair_return_rpo(self):
        action = self.env['ir.actions.act_window']._for_xml_id('repair.action_repair_order_tree')

        if len(self.fix_repair_ids) == 1:
            action['view_mode'] = 'form'
            action['res_id'] = self.fix_repair_ids.id
            action['views'] = []
        else:
            action['domain'] = [('id', 'in', self.fix_repair_ids.ids)]

        return action
