# -*- coding: utf-8 -*-
from odoo import fields, models


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    type = fields.Selection(selection_add=[('ganttaps', 'Gantt APS')], ondelete={'ganttaps': 'cascade'})

    def _get_view_info(self):
        return {'ganttaps': {'icon': 'fa fa-tasks'}} | super()._get_view_info()

    def get_view_info(self):
        result = super().get_view_info()
        if 'ganttaps' not in result:
            result['ganttaps'] = {
                'display_name': 'Gantt APS',
                'icon': 'fa fa-tasks',
                'multi_record': True,
            }
        return result


class IrActionsActWindowView(models.Model):
    _inherit = 'ir.actions.act_window.view'

    view_mode = fields.Selection(selection_add=[('ganttaps', 'Gantt APS')], ondelete={'ganttaps': 'cascade'})
