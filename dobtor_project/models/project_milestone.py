# -*- coding: utf-8 -*-

from odoo import models, fields, api


class ProjectMilestone(models.Model):
    _inherit = 'project.milestone'

    deadline_datetime = fields.Datetime(
        string='期限日期時間',
        help="含時間的里程碑期限，用於甘特圖精確定位",
    )
    sorting_seq = fields.Integer(string='排序序號', default=0)
    color_gantt = fields.Integer(
        string="顏色",
        help="甘特圖顏色索引 (0=無自訂顏色, 1-11=固定色)",
        default=0
    )

    def _deadline_date_from_datetime(self, value):
        """Derive the local-calendar date from a UTC deadline_datetime.

        Datetime fields are stored in UTC; taking .date() directly would drop a
        day for users east of UTC (e.g. a 02:00 local milestone in UTC+8 is the
        previous day in UTC). Convert to the user's timezone first.
        """
        dt = fields.Datetime.from_string(value)
        return fields.Datetime.context_timestamp(self, dt).date()

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if 'deadline_datetime' in vals and vals['deadline_datetime']:
                vals['deadline'] = self._deadline_date_from_datetime(
                    vals['deadline_datetime'])
        return super().create(vals_list)

    def write(self, vals):
        if 'deadline_datetime' in vals:
            if vals['deadline_datetime']:
                vals['deadline'] = self._deadline_date_from_datetime(
                    vals['deadline_datetime'])
            else:
                vals['deadline'] = False
        return super().write(vals)
