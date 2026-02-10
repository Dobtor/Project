# -*- coding: utf-8 -*-
from odoo import fields, models


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    type = fields.Selection(selection_add=[('ganttaps', 'Gantt APS')], ondelete={'ganttaps': 'cascade'})

    def _get_view_info(self):
        return {'ganttaps': {'icon': 'fa fa-tasks'}} | super()._get_view_info()


class IrActionsActWindowView(models.Model):
    _inherit = 'ir.actions.act_window.view'

    view_mode = fields.Selection(selection_add=[('ganttaps', 'Gantt APS')], ondelete={'ganttaps': 'cascade'})
