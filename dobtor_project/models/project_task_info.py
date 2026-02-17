# -*- coding: utf-8 -*-
from odoo import models, fields, Command


class ProjectTaskInfo(models.Model):
    _name = 'project.task.info'
    _description = "Project Task Info"

    name = fields.Char(string="名稱")
    task_id = fields.Many2one(
        'project.task',
        string='任務',
        ondelete='cascade'
    )
    start = fields.Char(string="開始")
    end = fields.Char(string="結束")
    left_up = fields.Char(string="左上")
    left_down = fields.Char(string="左下")
    right_up = fields.Char(string="右上")
    right_down = fields.Char(string="右下")
    show = fields.Boolean(string="顯示", default=False)


class ProjectTaskInfoMixin(models.Model):
    _inherit = 'project.task'

    info = fields.Integer(string='資訊', default=0)
    info_ids = fields.One2many(
        'project.task.info',
        'task_id',
        string='資訊值'
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
