# -*- coding: utf-8 -*-
from markupsafe import Markup

from odoo import _, api, fields, models
from odoo.exceptions import UserError


class Task(models.Model):
    _inherit = 'project.task'

    user_ids = fields.Many2many(domain="[('active', '=', True)]")
    return_repair_ids = fields.One2many('repair.order', 'return_task_id', string='Return Repairs')
    fix_repair_ids = fields.One2many('repair.order', 'repair_task_id', string='Fix Repairs')
    show_installation_actions = fields.Boolean(compute='_compute_show_installation_actions')

    def _get_installation_company(self):
        ''' 派工設定（安裝商品、各階段）看訂單的公司：專案可以不指定公司，派工單上的公司可能是空的 '''
        return self.sale_line_id.company_id or self.company_id or self.env.company

    @api.depends('sale_line_id.product_id', 'stage_id')
    def _compute_show_installation_actions(self):
        ''' 「客戶自行安裝」「更換安裝經銷商」只給還沒完工、沒取消的安裝派工 '''
        for task in self:
            company = task._get_installation_company()
            product = company.installation_task_product
            task.show_installation_actions = bool(
                product
                and task.sale_line_id.product_id == product
                and task.stage_id not in (company.done_stage | company.cancel_stage)
            )

    def _check_installation_action(self):
        self.ensure_one()
        if not self.show_installation_actions:
            raise UserError(_("Only installation tasks that are not done or cancelled can be changed."))

    def _get_installation_distributor_partners(self):
        ''' 目前負責安裝的經銷商：訂單明細指定的經銷商，加上派工單上的前台帳號（經銷商是前台帳號） '''
        users = self.sale_line_id.distributor_ids | self.user_ids.filtered('share')
        return users.partner_id

    def _get_assigned_stage(self):
        ''' 「已安排」＝「已承攬」的前一個階段。跟前台判斷經銷商能不能按「承攬」同一套規則，不另外加設定 '''
        stages = self.project_id.type_ids
        process_stage = self._get_installation_company().process_stage
        if process_stage not in stages:
            return self.env['project.task.type']
        index = list(stages).index(process_stage)
        return stages[index - 1] if index else self.env['project.task.type']

    def _get_installation_commission_lines(self, agents):
        ''' 安裝明細開進發票後，給這些經銷商的佣金。

            佣金模組刻意不列在 depends：派工模組不綁佣金，有裝才處理
            （同 dobtor_distributor 換客人經銷商時「有佣金欄位才更新」的作法）。
            沒裝佣金模組時回傳 None。
        '''
        if 'agent_ids' not in self.env['account.move.line']._fields:
            return None
        invoice_lines = self.sale_line_id.invoice_lines.filtered(
            lambda l: l.move_id.move_type == 'out_invoice' and l.move_id.state == 'posted'
        )
        return invoice_lines.agent_ids.filtered(lambda a: not a.is_excluded and a.agent_id in agents)

    def _open_commission_deductions(self, deductions):
        ''' 有開扣款單就直接打開給會計確認，沒有就關掉視窗 '''
        if not deductions:
            return {'type': 'ir.actions.act_window_close'}
        action = {
            'type': 'ir.actions.act_window',
            'name': _('Commission Deductions'),
            'res_model': 'account.move',
            'context': {'default_move_type': 'in_refund'},
        }
        if len(deductions) == 1:
            action.update({'view_mode': 'form', 'res_id': deductions.id})
        else:
            action.update({'view_mode': 'tree,form', 'domain': [('id', 'in', deductions.ids)]})
        return action

    def _action_customer_self_installed(self, reason):
        ''' 客人沒等經銷商、自己裝好：派工單取消，原本要給經銷商的安裝佣金不發。
            回傳因此開出、要會計確認的扣款單。
        '''
        self.ensure_one()
        self._check_installation_action()
        cancel_stage = self._get_installation_company().cancel_stage
        if not cancel_stage:
            raise UserError(_("Please set the Cancel Stage in the settings first."))
        old_partners = self._get_installation_distributor_partners()

        # 階段一改就會照設定發取消簡訊給客人與經銷商
        self.write({'stage_id': cancel_stage.id})

        deductions = self.env['account.move']
        commission_lines = self._get_installation_commission_lines(old_partners)
        if commission_lines is not None:
            deductions = commission_lines.sudo()._exclude_commission(reason)
            # 還沒開進發票的佣金只掛在訂單明細上，直接拿掉，之後開票就不會帶過去
            self.sale_line_id.agent_ids.filtered(lambda a: a.agent_id in old_partners).sudo().unlink()

        self.message_post(body=Markup('%s<br/>%s') % (
            _("Customer installed it by themselves. Task cancelled."),
            _("Reason: %(reason)s", reason=reason),
        ))
        return deductions

    def _action_change_installation_distributor(self, new_distributor, reason, update_customer=True):
        ''' 換安裝經銷商。

            先換負責人再改階段：每個階段都會發簡訊給派工單上的負責人，順序反了簡訊會發給舊經銷商。
            已經安排或承攬的退回「已安排」，讓新經銷商收到通知、重新按承攬。
            佣金跟著改給新經銷商；回傳因此開出、要會計確認的扣款單。
        '''
        self.ensure_one()
        self._check_installation_action()
        new_user = new_distributor.user_ids[:1]
        if not new_user:
            raise UserError(_("%s has no login account, so the task cannot be assigned to it.", new_distributor.display_name))
        old_partners = self._get_installation_distributor_partners()
        if new_distributor in old_partners:
            raise UserError(_("%s is already the installer of this task.", new_distributor.display_name))
        old_names = ', '.join(old_partners.mapped('display_name'))

        # 舊經銷商是前台帳號；派工單上的內部人員保留不動
        old_users = self.user_ids.filtered('share')
        self.write({'user_ids': [(3, user.id) for user in old_users] + [(4, new_user.id)]})
        # 訂單明細的經銷商一起換，報表與之後的退貨、報修才對得上
        self.sale_line_id.sudo().distributor_ids = [(6, 0, new_user.ids)]

        assigned_stage = self._get_assigned_stage()
        stages = self.project_id.type_ids
        if assigned_stage and self.stage_id in stages \
                and list(stages).index(self.stage_id) >= list(stages).index(assigned_stage):
            # 階段相同也要重寫一次，簡訊才會發給新的經銷商
            self.write({'stage_id': assigned_stage.id})

        customer = self.sale_line_id.order_id.partner_id
        if update_customer and customer:
            # 客人綁定的經銷商一起換，以後報修、退貨預設找新經銷商（會自動留更換紀錄）
            customer.sudo().write({'distributor': new_distributor.id})

        deductions = self.env['account.move']
        commission_lines = self._get_installation_commission_lines(old_partners)
        if commission_lines is not None:
            _new_lines, deductions = commission_lines.sudo()._reassign_commission(new_distributor, reason)
            # 還沒開進發票的佣金只掛在訂單明細上，直接改給新經銷商，之後開票就會帶新的
            sale_agents = self.sale_line_id.agent_ids.filtered(lambda a: a.agent_id in old_partners).sudo()
            if sale_agents and new_distributor not in self.sale_line_id.agent_ids.agent_id:
                sale_agents[:1].agent_id = new_distributor
                sale_agents = sale_agents[1:]
            sale_agents.unlink()

        self.message_post(body=Markup('%s<br/>%s') % (
            _("Installer changed from %(old)s to %(new)s.", old=old_names, new=new_distributor.display_name),
            _("Reason: %(reason)s", reason=reason),
        ))
        return deductions

    def action_open_self_install_wizard(self):
        self.ensure_one()
        self._check_installation_action()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Customer Self-Installed'),
            'res_model': 'dobtor.task.self.install.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {'default_task_id': self.id},
        }

    def action_open_change_distributor_wizard(self):
        self.ensure_one()
        self._check_installation_action()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Change Installer'),
            'res_model': 'dobtor.task.change.distributor.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {'default_task_id': self.id},
        }

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
