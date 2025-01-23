# -*- coding: utf-8 -*-
from odoo import api, fields, models, _


class StockLot(models.Model):
    _inherit = "stock.lot"
    
    def create_repair_order(self):
        repair_order = super().create_repair_order()
        task_create = self.env.context.get('task_create') or True
        
        if repair_order and task_create:
            partner = repair_order.partner_id.commercial_partner_id
            repair_task_product = repair_order.company_id.repair_task_product
            SaleOrderSudo = self.env['sale.order'].sudo()
            repair_task_order = SaleOrderSudo.create({
                'partner_id': partner.id,
                'partner_shipping_id': repair_order.partner_id.id,
                'order_line': [(0, 0, {
                    'product_uom_qty': 1,
                    'product_uom': repair_task_product.uom_id.id,
                    'product_id': repair_task_product.id,
                    'distributor_ids': [(6, 0, [partner.distributor.user_ids[:1].id] if partner.distributor else [])],
                })],
            })
            repair_task_order.action_confirm()
            repair_order.return_task_id = repair_task_order.tasks_ids[:1].id
            repair_order.return_task_id.stage_id = repair_order.return_task_id.company_id.return_task_init_stage

        return repair_order
