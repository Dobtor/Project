# -*- coding: utf-8 -*-
from odoo import api, fields, models, _


class GanttNativePredecessor(models.AbstractModel):
    _name = 'gantt.native.predecessor'
    _description = "Gantt Native Predecessor"

    @api.model
    def _get_link_type(self):
        return [
            ('FS', _('Finish to Start (FS)')),
            ('SS', _('Start to Start (SS)')),
            ('FF', _('Finish to Finish (FF)')),
            ('SF', _('Start to Finish (SF)')),
        ]

    type = fields.Selection(
        selection='_get_link_type',
        string='Type',
        required=True,
        default='FS'
    )

    @api.model
    def _get_lag_type(self):
        return [
            ('minute', _('minute')),
            ('hour', _('hour')),
            ('day', _('day')),
            ('percent', _('percent')),
        ]

    lag_type = fields.Selection(
        selection='_get_lag_type',
        string='Lag type',
        required=True,
        default='day'
    )

    lag_qty = fields.Integer(string='Lag', default=0)
