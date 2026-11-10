# -*- coding: utf-8 -*-
"""安裝派工的「客戶自行安裝」「更換安裝經銷商」。

佣金模組不是派工模組的 depends：有裝佣金模組才測佣金那一段，沒裝就跳過。
安裝費照 dech 實際設定為 0 元，佣金是固定金額 500。
"""

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged('post_install', '-at_install', 'repair_task_installation')
class TestInstallationTaskActions(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.has_commission = 'agent_ids' in cls.env['account.move.line']._fields
        cls.company = cls.env.company

        Stage = cls.env['project.task.type']
        cls.stage_waiting = Stage.create({'name': 'Waiting Shipment', 'sequence': 1})
        cls.stage_arranged = Stage.create({'name': 'Arranged', 'sequence': 3})
        cls.stage_accepted = Stage.create({'name': 'Accepted', 'sequence': 4})
        cls.stage_done = Stage.create({'name': 'Done', 'sequence': 6})
        cls.stage_cancel = Stage.create({'name': 'Cancelled', 'sequence': 7})
        stages = cls.stage_waiting | cls.stage_arranged | cls.stage_accepted | cls.stage_done | cls.stage_cancel
        cls.project = cls.env['project.project'].create({
            'name': 'New Installation',
            'type_ids': [(6, 0, stages.ids)],
        })

        product_vals = {
            'name': 'Installer Installation',
            'type': 'service',
            'list_price': 0.0,
            'invoice_policy': 'order',
            'service_tracking': 'task_global_project',
            'project_id': cls.project.id,
        }
        if cls.has_commission:
            cls.commission = cls.env['dobtor.commission'].create({
                'name': 'Installation Commission',
                'commission_object': 'agent',
                'commission_type': 'amount',
                'fix_amount': 500.0,
            })
            product_vals['commission'] = [(6, 0, cls.commission.ids)]
        cls.install_product = cls.env['product.product'].create(product_vals)
        cls.company.write({
            'installation_task_product': cls.install_product.id,
            'process_stage': cls.stage_accepted.id,
            'done_stage': cls.stage_done.id,
            'cancel_stage': cls.stage_cancel.id,
        })

        cls.user_a = cls._create_distributor('Installer A', 'installer_a')
        cls.user_b = cls._create_distributor('Installer B', 'installer_b')
        cls.customer = cls.env['res.partner'].create({
            'name': 'Customer',
            'distributor': cls.user_a.partner_id.id,
        })

    @classmethod
    def _create_distributor(cls, name, login):
        ''' 經銷商是前台帳號，身分設成經銷商後會自動變成可領佣金的對象 '''
        user = cls.env['res.users'].with_context(no_reset_password=True).create({
            'name': name,
            'login': login,
            'groups_id': [(6, 0, cls.env.ref('base.group_portal').ids)],
        })
        user.partner_id.membership_type = 'distributor'
        return user

    def _create_order(self):
        order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [(0, 0, {
                'product_id': self.install_product.id,
                'product_uom_qty': 1,
                'distributor_ids': [(6, 0, self.user_a.ids)],
            })],
        })
        order.action_confirm()
        task = order.tasks_ids
        self.assertEqual(len(task), 1, "前提：確認訂單應開出一張安裝派工")
        self.assertIn(self.user_a, task.user_ids, "前提：派工單指派給選定的經銷商")
        return order, task

    def _invoice(self, order):
        invoice = order._create_invoices()
        invoice.action_post()
        return invoice

    def _invoice_commission(self, invoice):
        return invoice.invoice_line_ids.agent_ids

    def _skip_without_commission(self):
        if not self.has_commission:
            self.skipTest("佣金模組沒裝，略過佣金相關檢查")

    # ------------------------------------------------------------------
    def test_buttons_only_on_open_installation_tasks(self):
        _order, task = self._create_order()
        self.assertTrue(task.show_installation_actions)

        task.stage_id = self.stage_done
        self.assertFalse(task.show_installation_actions, "已完工不能再操作")
        with self.assertRaises(UserError):
            task._action_customer_self_installed('客人自行安裝')

        other = self.env['project.task'].create({'name': 'Other', 'project_id': self.project.id})
        self.assertFalse(other.show_installation_actions, "不是安裝派工不出現按鈕")

    def test_self_installed_cancels_task_and_excludes_commission(self):
        self._skip_without_commission()
        order, task = self._create_order()
        invoice = self._invoice(order)
        commission = self._invoice_commission(invoice)
        self.assertEqual(commission.agent_id, self.user_a.partner_id, "前提：發票上有經銷商 A 的佣金")
        self.assertEqual(commission.amount, 500.0)

        deductions = task._action_customer_self_installed('客人自行安裝')

        self.assertFalse(deductions, "還沒結算不會開扣款單")
        self.assertEqual(task.stage_id, self.stage_cancel)
        self.assertTrue(commission.is_excluded)
        self.assertEqual(commission.exclude_reason, '客人自行安裝')
        self.assertFalse(order.order_line.agent_ids, "訂單明細上的佣金也拿掉")

    def test_self_installed_before_invoicing_keeps_commission_off_the_invoice(self):
        self._skip_without_commission()
        order, task = self._create_order()

        task._action_customer_self_installed('客人自行安裝')
        invoice = self._invoice(order)

        self.assertFalse(self._invoice_commission(invoice), "之後開的發票不應再帶佣金")

    def test_change_installer_reassigns_task_customer_and_commission(self):
        order, task = self._create_order()
        invoice = self._invoice(order) if self.has_commission else False
        task.stage_id = self.stage_accepted

        task._action_change_installation_distributor(self.user_b.partner_id, '客人想換經銷商')

        self.assertIn(self.user_b, task.user_ids)
        self.assertNotIn(self.user_a, task.user_ids, "舊經銷商不能再看到這張單")
        self.assertEqual(task.stage_id, self.stage_arranged, "已承攬要退回已安排，讓新經銷商重新承攬")
        self.assertEqual(order.order_line.distributor_ids, self.user_b)
        self.assertEqual(self.customer.distributor, self.user_b.partner_id, "客人綁定的經銷商一起換")
        if self.has_commission:
            commission = self._invoice_commission(invoice)
            self.assertEqual(commission.agent_id, self.user_b.partner_id, "還沒結算的佣金直接改給新經銷商")
            self.assertEqual(order.order_line.agent_ids.agent_id, self.user_b.partner_id)

    def test_change_installer_keeps_stage_before_arranged(self):
        _order, task = self._create_order()
        task.stage_id = self.stage_waiting

        task._action_change_installation_distributor(self.user_b.partner_id, '客人想換經銷商')

        self.assertEqual(task.stage_id, self.stage_waiting, "還沒到已安排的不動階段")

    def test_change_installer_can_keep_customer_distributor(self):
        _order, task = self._create_order()

        task._action_change_installation_distributor(
            self.user_b.partner_id, '客人想換經銷商', update_customer=False,
        )

        self.assertEqual(self.customer.distributor, self.user_a.partner_id)

    def test_change_installer_after_settlement_moves_commission(self):
        self._skip_without_commission()
        order, task = self._create_order()
        invoice = self._invoice(order)
        old_commission = self._invoice_commission(invoice)
        old_commission._settle_now()
        self.assertEqual(old_commission.commission_stage, 'settled', "前提：佣金已結算給 A")

        task._action_change_installation_distributor(self.user_b.partner_id, '客人想換經銷商')

        self.assertTrue(old_commission.is_excluded, "A 那筆不發")
        new_commission = self._invoice_commission(invoice) - old_commission
        self.assertEqual(new_commission.agent_id, self.user_b.partner_id)
        self.assertEqual(new_commission.commission_stage, 'settled', "B 那筆立刻結算")

    def test_change_to_current_installer_raises(self):
        _order, task = self._create_order()
        with self.assertRaises(UserError):
            task._action_change_installation_distributor(self.user_a.partner_id, '同一家')
