# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import UserError


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    amount_project = fields.Monetary(
        string="Project Amount",
        compute='_compute_amount_project',
        help="Tax included or excluded depending on the website configuration.",
    )

    @api.depends('order_line.price_total', 'order_line.price_subtotal')
    def _compute_amount_project(self):
        self.amount_project = 0.0
        for order in self.filtered('website_id'):
            project_lines = order.order_line.filtered(lambda sol: sol.is_service and sol.product_id.sale_ok and sol.product_id.service_tracking != 'no')
            
            if order.website_id.show_line_subtotals_tax_selection == 'tax_excluded':
                order.amount_project = sum(project_lines.mapped('price_subtotal'))
            else:
                order.amount_project = sum(project_lines.mapped('price_total'))

    def sale_create_return(self):
        super().sale_create_return()
        latest_picking = self.env["stock.picking"].search([
            ("id", "in", self.picking_ids.ids),
            ("state", "not in", ["cancel"])
        ], order="create_date desc", limit=1)

        if not (latest_picking and latest_picking.return_id and latest_picking.repair_ids):
            return
        
        if not self.company_id.rma_done_stage:
            raise UserError(_('Return to manufacturer done stage not setting.'))

        if not self.company_id.return_task_product:
            raise UserError(_('Return task product not setting.'))
        
        return_task_product = self.company_id.return_task_product
        taxes = return_task_product.taxes_id._filter_taxes_by_company(self.company_id)
        taxes_ids = taxes.ids

        if self.partner_id and self.fiscal_position_id:
            taxes_ids = self.fiscal_position_id.map_tax(taxes).ids

        distributor = self.partner_id.distributor
        return_order = self.copy()
        return_order.order_line = [(5, 0, 0), (0, 0, {
            'order_id': return_order.id,
            'product_uom_qty': 1,
            'product_uom': return_task_product.uom_id.id,
            'product_id': return_task_product.id,
            'tax_id': [(6, 0, taxes_ids)],
            'distributor_ids': [(6, 0, [distributor.user_ids[:1].id] if distributor else [])],
        })]
        return_order.action_confirm()
        return_order.tasks_ids.sudo().write({
            'stage_id': self.company_id.rma_done_stage.id,
        })
        latest_picking.repair_ids.sudo().write({
            'task_order_id': return_order.id,
        })
