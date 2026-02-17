# -*- coding: utf-8 -*-
from odoo import models, fields, api, _, Command


class ProjectTaskNativeResource(models.Model):
    _inherit = 'project.task'

    task_resource_ids = fields.One2many(
        'project.task.resource.link',
        'task_id',
        string='資源'
    )


class ProjectTaskResourceLink(models.Model):
    _name = 'project.task.resource.link'
    _description = "Project Task Resource Link"
    _order = 'date_start'

    @api.model
    def _get_load_control(self):
        return [
            ('no', _('否')),
            ('in_project', _('專案內')),
            ('everywhere', _('全域')),
        ]

    name = fields.Char(
        compute='_compute_name_link',
        readonly=True,
        store=False
    )

    resource_id = fields.Many2one(
        'resource.resource',
        string='資源',
        ondelete='restrict'
    )
    task_id = fields.Many2one(
        'project.task',
        string='任務',
        ondelete='cascade',
        readonly=True
    )
    load_factor = fields.Float(
        string="負載率",
        default=1.0
    )

    resource_type = fields.Selection(
        string='類型',
        related="resource_id.resource_type",
        readonly=True,
        store=True
    )
    date_start = fields.Datetime(
        related='task_id.date_start',
        string="開始日期",
        store=True,
        readonly=True
    )
    date_end = fields.Datetime(
        related='task_id.date_end',
        string="結束日期",
        store=True,
        readonly=True
    )
    duration = fields.Float(
        related='task_id.duration',
        string='工期（小時）',
        store=True,
        readonly=True
    )
    project_id = fields.Many2one(
        related='task_id.project_id',
        string='專案',
        store=True,
        readonly=True
    )

    load_control = fields.Selection(
        selection='_get_load_control',
        string='負載控制',
        required=True,
        default='everywhere'
    )

    @api.depends('task_id', 'load_factor', 'resource_id', 'resource_type')
    def _compute_name_link(self):
        for rec in self:
            rec.name = "{}-{} ({}) {}".format(
                rec.project_id.name or "",
                rec.task_id.name or "",
                rec.resource_id.name or "",
                rec.load_factor or ""
            )

    def write(self, vals):
        """Update resource link - optimized info update"""
        result = super().write(vals)
        if result and 'resource_id' in vals:
            # Only update info if resource changed
            info_names = ["res_{}".format(rec.id) for rec in self]
            info_tasks = self.env['project.task.info'].search([('name', 'in', info_names)])
            if info_tasks:
                # Create mapping for efficient update
                info_map = {info.name: info for info in info_tasks}
                for rec in self:
                    info_name = "res_{}".format(rec.id)
                    if info_name in info_map:
                        info_map[info_name].write({"end": rec.resource_id.name})
        return result

    def unlink(self):
        """Delete resource link and clean up info records - batch optimized"""
        info_names = ["res_{}".format(rec_id) for rec_id in self.ids]

        res = super().unlink()

        if res and info_names:
            # Batch delete all related info records
            self.env['project.task.info'].search([('name', 'in', info_names)]).unlink()

        return res

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)

        for new_id in records:
            info_name = "res_{}".format(new_id.id)
            value = {
                "name": info_name,
                "end": new_id.resource_id.name,
                "show": True
            }

            vals = {"info_ids": [Command.create(value)]}
            new_id.task_id.write(vals)

        return records

    _sql_constraints = [
        ('project_task_resource_link_uniq', 'unique(task_id, resource_id)', 'Duplicate Resource.'),
    ]
