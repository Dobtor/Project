import logging

from odoo import api, fields, models, _

_logger = logging.getLogger(__name__)

class ShippingEcpayModel(models.Model):
    _inherit = "shipping.ecpay.model"
    
    def write(self, vals):
        res = super(ShippingEcpayModel, self).write(vals)
        for ecpay in self.sudo():
            if "RtnCode" in vals and "LogisticsStatus" in vals:
                rtn_code = int(vals["RtnCode"])
                if rtn_code == 1:
                    LogisticsSubType = ecpay.LogisticsSubType
                    LogisticsType = ecpay.LogisticsType
                    logistics_status = vals["LogisticsStatus"]
                    if not rtn_code or not LogisticsSubType or not LogisticsType or not logistics_status:
                        continue
                    logistics_code = self.env["shipping.ecpay.logistics"].search([
                        ("type", "=", LogisticsType),
                        ("sub_type", "=", LogisticsSubType),
                        ("code", "=", logistics_status),
                        ("is_complete", "=", True)
                    ], limit=1)
                    
                    delivery_complte_stage = self.env.company.delivery_complete_stage
                    picking = self.env["stock.picking"].search([("logistic_ecpay_id", "=", ecpay.id)], limit=1)
                    if "repair_task_id" in self.env["repair.order"]._fields and picking.return_id:
                        task_ids = picking and picking.return_id and picking.return_id.repair_ids and picking.return_id.repair_ids.repair_task_id 
                    
                    if ecpay.ReferenceNo and ecpay.ReferenceNo.task_ids:
                        task_ids = ecpay.ReferenceNo.task_ids
                        
                    if logistics_code and delivery_complte_stage:
                        task_ids.sudo().write({
                            "stage_id": delivery_complte_stage.id
                        })
                
        return res