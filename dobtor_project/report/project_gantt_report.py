# -*- coding: utf-8 -*-
from odoo import api, models


class GanttReport(models.AbstractModel):
    _name = "report.dobtor_project.gantt_report"
    _description = "Gantt Chart Report"

    @api.model
    def _get_report_values(self, docids, data=None):
        project_id = data.get("project_id") if data else (docids[0] if docids else None)
        project = self.env["project.project"].browse(project_id)
        tasks = self.env["project.task"].search(
            [("project_id", "=", project.id)],
            order="sorting_seq asc",
        )
        return {
            "doc_ids": [project.id],
            "doc_model": "project.project",
            "docs": project,
            "project": project,
            "tasks": tasks,
        }
