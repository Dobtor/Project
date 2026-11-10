# -*- coding: utf-8 -*-
from odoo import api, fields, models


class TaskSelfInstallWizard(models.TransientModel):
    _name = 'dobtor.task.self.install.wizard'
    _description = 'Customer Self-Installed'

    task_id = fields.Many2one('project.task', string='Installation Task', required=True, readonly=True)
    reason = fields.Text(string='Reason', required=True)
    currency_id = fields.Many2one(related='task_id.sale_line_id.currency_id')
    installation_fee = fields.Monetary(
        string='Installation Fee',
        related='task_id.sale_line_id.price_total',
        help="Not refunded automatically. If the customer paid for installation, please create a credit note.",
    )

    def action_confirm(self):
        self.ensure_one()
        deductions = self.task_id._action_customer_self_installed(self.reason)
        return self.task_id._open_commission_deductions(deductions)


class TaskChangeDistributorWizard(models.TransientModel):
    _name = 'dobtor.task.change.distributor.wizard'
    _description = 'Change Installer'

    task_id = fields.Many2one('project.task', string='Installation Task', required=True, readonly=True)
    current_distributor_ids = fields.Many2many(
        'res.partner', string='Current Installer', compute='_compute_current_distributor_ids',
    )
    new_distributor_id = fields.Many2one(
        'res.partner',
        string='New Installer',
        required=True,
        domain="[('membership_type', '=', 'distributor'), ('user_ids', '!=', False), ('id', 'not in', current_distributor_ids)]",
    )
    update_customer = fields.Boolean(
        string="Also change the customer's distributor",
        default=True,
        help="Future repairs and returns of this customer will also go to the new distributor.",
    )
    reason = fields.Text(string='Reason', required=True)

    @api.depends('task_id')
    def _compute_current_distributor_ids(self):
        for wizard in self:
            wizard.current_distributor_ids = wizard.task_id._get_installation_distributor_partners()

    def action_confirm(self):
        self.ensure_one()
        deductions = self.task_id._action_change_installation_distributor(
            self.new_distributor_id, self.reason, update_customer=self.update_customer,
        )
        return self.task_id._open_commission_deductions(deductions)
