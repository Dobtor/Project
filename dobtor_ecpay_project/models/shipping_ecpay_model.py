import logging

from odoo import api, fields, models, _

_logger = logging.getLogger(__name__)

class ShippingEcpayModel(models.Model):
    _inherit = "shipping.ecpay.model"
    
    def write(self, vals):
        res = super(ShippingEcpayModel, self).write(vals)
        for ecpay in self.sudo():
            # 綠界新舊兩版回傳的貨態代碼位置不同：
            # 新版（JSON 加密，暫存轉單流程 /logistic/ecpay/server_reply_url）：
            #   RtnCode=1 代表 API 執行成功，貨態代碼放在 LogisticsStatus
            # 舊版（CheckMacValue，幕後開立正式訂單流程 /logistic/integration/...）：
            #   沒有 LogisticsStatus 這個 key，RtnCode 本身就是貨態代碼
            status_code = False
            if "LogisticsStatus" in vals and str(vals.get("RtnCode", "")) == "1":
                status_code = vals["LogisticsStatus"]
            elif "RtnCode" in vals and "LogisticsStatus" not in vals:
                status_code = vals["RtnCode"]

            if not status_code or not ecpay.LogisticsType or not ecpay.LogisticsSubType:
                continue

            # 貨態代碼依路徑可能是 int 或 str，統一轉字串再比對
            logistics_code = self.env["shipping.ecpay.logistics"].search([
                ("type", "=", ecpay.LogisticsType),
                ("sub_type", "=", ecpay.LogisticsSubType),
                ("code", "=", str(status_code)),
                ("is_complete", "=", True)
            ], limit=1)
            # 舊版路徑每次貨態通知都會進到這裡，非完成貨態直接跳過，避免多餘的 picking 查詢
            if not logistics_code:
                continue

            delivery_complte_stage = self.env.company.delivery_complete_stage
            picking = self.env["stock.picking"].search([("logistic_ecpay_id", "=", ecpay.id)], limit=1)
            task_ids = None
            if "repair_task_id" in self.env["repair.order"]._fields and picking.return_id:
                task_ids = picking and picking.return_id and picking.return_id.repair_ids and picking.return_id.repair_ids.repair_task_id

            if ecpay.ReferenceNo and ecpay.ReferenceNo.tasks_ids:
                task_ids = ecpay.ReferenceNo.tasks_ids

            if task_ids and delivery_complte_stage:
                if 'cancel_stage' in self.env['res.company']._fields:
                    cancel_stage = self.env.company.cancel_stage
                    if cancel_stage:
                        # 過濾掉已經是取消階段的任務
                        task_ids = task_ids.filtered(lambda t: t.stage_id != cancel_stage)

                if task_ids:
                    task_ids.sudo().write({
                        "stage_id": delivery_complte_stage.id
                    })

        return res