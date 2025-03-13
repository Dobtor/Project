# -*- coding: utf-8 -*-
from odoo import models, fields, api


class Repair(models.Model):
    _inherit = 'repair.order'

    return_task_id = fields.Many2one('project.task', 'Return Task', readonly=True, copy=False)
    repair_task_id = fields.Many2one('project.task', 'Repair Task', readonly=True, copy=False)
    
    def action_return_picking(self):
        return_picking = super().action_return_picking()

        if return_picking and self.return_task_id:
            partner = self.partner_id.commercial_partner_id
            repair_return_task_product = self.company_id.repair_return_task_product
            SaleOrderSudo = self.env['sale.order'].sudo()
            return_task_order = SaleOrderSudo.create({
                'partner_id': partner.id,
                'partner_shipping_id': self.partner_id.id,
                'order_line': [(0, 0, {
                    'product_uom_qty': 1,
                    'product_uom': repair_return_task_product.uom_id.id,
                    'product_id': repair_return_task_product.id,
                    'distributor_ids': [(6, 0, [partner.distributor.user_ids[:1].id] if partner.distributor else [])],
                })],
            })
            return_task_order.action_confirm()
            self.repair_task_id = return_task_order.tasks_ids[:1].id
        return return_picking

    def action_view_return_task(self):
        action = self.env['ir.actions.act_window']._for_xml_id('project.action_view_all_task')
        action['view_mode'] = 'form'
        action['res_id'] = self.return_task_id.id
        action['views'] = []
        return action
    
    def action_view_repair_return_task(self):
        action = self.env['ir.actions.act_window']._for_xml_id('project.action_view_all_task')
        action['view_mode'] = 'form'
        action['res_id'] = self.repair_task_id.id
        action['views'] = []
        return action
