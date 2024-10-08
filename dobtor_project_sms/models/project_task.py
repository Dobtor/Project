import logging
from odoo import api, models

_logger = logging.getLogger(__name__)

class ProjectTask(models.Model):
    _inherit = "project.task"
    
    def write(self, vals):
        res = super().write(vals)
        
        if "stage_id" in vals:
            self.sudo().send_mitake_sms()
            
        return res
    
    def send_mitake_sms(self):
        for task in self:
            if task.partner_id and task.stage_id and task.stage_id.mitake_sms_template_id:
                sms_template = task.stage_id.mitake_sms_template_id
                message = sms_template._render_field("body", self.ids, compute_lang=True)[task.id]
                sms_values = [{
                    "body": message, 
                    "number": task.partner_id.mobile or task.partner_id.phone,
                    "adapter": "mitake",
                }]
                print(f" sms_values: {sms_values}")
                try:
                    self.env["sms.sms"].sudo().create(sms_values).send()
                except Exception as e:
                    _logger.error("Send Invoice Failed: %s", str(e))
                
    