import logging

from odoo import api, fields, models, _

_logger = logging.getLogger(__name__)

class ShippingEcpayModel(models.Model):
    _inherit = "shipping.ecpay.model"
    
    def write(self, vals):
        res = super(ShippingEcpayModel, self).write(vals)
        
        if "RtnCode" in vals and "LogisticsStatus" in vals:
            rtn_code = int(vals["RtnCode"])
            if rtn_code == 1:
                LogisticsSubType = self.LogisticsSubType
                LogisticsType = self.LogisticsType
                logistics_status = vals["LogisticsStatus"]
                if not rtn_code or not LogisticsSubType or not LogisticsType or not logistics_status:
                    return res
                logistics_code = self.env["shipping.ecpay.logistics"].search([
                    ("type", "=", LogisticsType),
                    ("sub_type", "=", LogisticsSubType),
                    ("code", "=", logistics_status),
                    ("is_complete", "=", True)
                ], limit=1)
                
                delivery_complte_stage = self.ReferenceNo.company_id.delivery_complete_stage
                
                if logistics_code and delivery_complte_stage:
                    self.ReferenceNo.tasks_ids.sudo().write({
                        "stage_id": delivery_complte_stage.id
                    })
            
        return res