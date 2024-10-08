
from odoo import fields, models


class ProjectTaskType(models.Model):
    _inherit = "project.task.type"

    mitake_sms_template_id = fields.Many2one('sms.template', string="Mitake SMS Template",
        domain=[('model', '=', 'project.task')],
        help="If set, an SMS Text Message will be automatically sent to the customer when the task reaches this stage.")
