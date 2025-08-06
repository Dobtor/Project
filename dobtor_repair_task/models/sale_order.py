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

    def _cancel_related_tasks(self):
        """取消相關派工的共用方法"""
        self.ensure_one()
        company = self.company_id
        if not company.cancel_stage:
            return
            
        tasks_to_cancel = self.tasks_ids.filtered(
            lambda t: company.cancel_stage in t.project_id.type_ids
        )
        
        # 排除已完成的任務
        if company.done_stage:
            tasks_to_cancel = tasks_to_cancel.filtered(
                lambda t: t.stage_id != company.done_stage
            )
        
        if tasks_to_cancel:
            tasks_to_cancel.write({
                'stage_id': company.cancel_stage.id
            })

    def sale_create_return(self):
        repair_order = super().sale_create_return()
        task_create = self.env.context['task_create'] if 'task_create' in self.env.context else True

        self._cancel_related_tasks()

        if repair_order and task_create:
            return_task_product = self.company_id.return_task_product
            taxes = return_task_product.taxes_id._filter_taxes_by_company(self.company_id)
            taxes_ids = taxes.ids

            if self.partner_id and self.fiscal_position_id:
                taxes_ids = self.fiscal_position_id.map_tax(taxes).ids

            distributor = repair_order.partner_id.commercial_partner_id.distributor
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
            repair_order.return_task_id = return_order.tasks_ids[:1].id
            repair_order.return_task_id.stage_id = repair_order.return_task_id.company_id.return_task_init_stage

        return repair_order
    
    def _action_cancel(self):
        res = super()._action_cancel()
        for order in self:
            order._cancel_related_tasks()
        return res
