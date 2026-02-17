# -*- coding: utf-8 -*-
from odoo import api, fields, models, _


class GanttNativePredecessor(models.AbstractModel):
    _name = 'gantt.native.predecessor'
    _description = "Gantt Native Predecessor"

    @api.model
    def _get_link_type(self):
        return [
            ('FS', _('完成到開始 (FS)')),
            ('SS', _('開始到開始 (SS)')),
            ('FF', _('完成到完成 (FF)')),
            ('SF', _('開始到完成 (SF)')),
        ]

    type = fields.Selection(
        selection='_get_link_type',
        string='類型',
        required=True,
        default='FS'
    )

    lag_hours = fields.Float(string='延遲(小時)', default=0.0)
