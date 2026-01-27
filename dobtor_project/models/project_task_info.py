# -*- coding: utf-8 -*-
from odoo import models, fields, Command


class ProjectTaskInfo(models.Model):
    _name = 'project.task.info'
    _description = "Project Task Info"

    name = fields.Char(string="Name")
    task_id = fields.Many2one(
        'project.task',
        string='Task',
        ondelete='cascade'
    )
    start = fields.Char(string="Start")
    end = fields.Char(string="End")
    left_up = fields.Char(string="Left Up")
    left_down = fields.Char(string="Left Down")
    right_up = fields.Char(string="Right Up")
    right_down = fields.Char(string="Right Down")
    show = fields.Boolean(string="Show", default=False)


class ProjectTaskInfoMixin(models.Model):
    _inherit = 'project.task'

    info = fields.Integer(string='Info', default=False)
    info_ids = fields.One2many(
        'project.task.info',
        'task_id',
        string='Info Value'
    )

    def _task_info_add(self, task, vals, info_name):
        if "info_vals" in task.keys() and task["info_vals"]:
            info_data = task["info_vals"]
            info_data["name"] = info_name
            task_info_lines = [Command.create(info_data)]
            vals["info_ids"] = task_info_lines
        return vals

    def _task_info_remove(self, info_name):
        """Remove task info records by name - removed unnecessary sudo()"""
        result = self.env['project.task.info'].search([('name', '=', info_name)])
        if result:
            result.unlink()
