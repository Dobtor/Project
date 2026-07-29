# -*- coding: utf-8 -*-
from odoo import fields, models


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    type = fields.Selection(selection_add=[('ganttaps', 'Gantt APS')], ondelete={'ganttaps': 'cascade'})

    def _get_view_info(self):
        # web's get_view_info() builds its result from the `type` selection
        # intersected with this dict, so registering the icon here is the whole
        # job: the label comes from the selection_add above and multi_record
        # defaults to True. (A second override of the public get_view_info() that
        # re-added the entry "if missing" could therefore never fire.)
        return {'ganttaps': {'icon': 'fa fa-tasks'}} | super()._get_view_info()


class IrActionsActWindowView(models.Model):
    _inherit = 'ir.actions.act_window.view'

    view_mode = fields.Selection(selection_add=[('ganttaps', 'Gantt APS')], ondelete={'ganttaps': 'cascade'})
