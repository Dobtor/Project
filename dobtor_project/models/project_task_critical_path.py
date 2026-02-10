# -*- coding: utf-8 -*-
from odoo import models, fields


class ProjectTaskCriticalPath(models.Model):
    _inherit = 'project.task'

    def _critical_path_calc(self, task):
        """Calculate critical path for a task"""
        task["critical_path"] = False
        task["info_vals"] = False
        value = {}

        need_key = ["soon_date_start", "soon_date_end", "late_date_start", "late_date_end"]

        if all(key in task for key in need_key):
            if task["late_date_start"] and task["soon_date_start"]:
                start = ((task["late_date_start"] - task["soon_date_start"]).total_seconds()) / 3600
                # Convert to string for Char fields on project.task.info
                value["left_up"] = fields.Datetime.to_string(task["soon_date_start"])
                value["left_down"] = fields.Datetime.to_string(task["late_date_start"])
                value["start"] = "{:.2f}".format(start)
                if start <= 0:
                    task["critical_path"] = True

            if task["late_date_end"] and task["soon_date_end"]:
                end = ((task["late_date_end"] - task["soon_date_end"]).total_seconds()) / 3600
                # Convert to string for Char fields on project.task.info
                value["right_up"] = fields.Datetime.to_string(task["soon_date_end"])
                value["right_down"] = fields.Datetime.to_string(task["late_date_end"])
                value["end"] = "{:.2f}".format(end)
                if end <= 0:
                    task["critical_path"] = True

            if value:
                task["info_vals"] = value

        return task
