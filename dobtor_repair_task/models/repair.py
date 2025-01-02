# -*- coding: utf-8 -*-
from odoo import models, fields, api


class Repair(models.Model):
    _inherit = 'repair.order'

    task_order_id = fields.Many2one(
        'sale.order', 'Task Order', check_company=True, readonly=True, copy=False)
    return_task_id = fields.Many2one('project.task', 'Return Task', readonly=True, copy=False)
    repair_task_id = fields.Many2one('project.task', 'Repair Task', readonly=True, copy=False)

    def action_view_task_order(self):
        return {
            "type": "ir.actions.act_window",
            "res_model": "sale.order",
            "views": [[False, "form"]],
            "res_id": self.task_order_id.id,
        }
    
    def action_return_picking(self):
        return_picking = super().action_return_picking()

        if return_picking:
            partner = self.partner_id
            repair_return_task_product = self.company_id.repair_return_task_product
            SaleOrderSudo = self.env['sale.order'].sudo()
            return_task_order = SaleOrderSudo.create({
                'partner_id': partner.commercial_partner_id.id,
                'partner_shipping_id': partner.id,
                'order_line': [(0, 0, {
                    'product_uom_qty': 1,
                    'product_uom': repair_return_task_product.uom_id.id,
                    'product_id': repair_return_task_product.id,
                    'distributor_ids': [(6, 0, [partner.distributor.user_ids[:1].id] if partner.distributor else [])],
                })],
            })
            return_task_order.action_confirm()
            return_picking.repair_task_id = return_task_order.task_ids[:1].id
        return return_picking
