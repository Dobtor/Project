# -*- coding: utf-8 -*-
from odoo import models, fields, api


class ProjectBaseline(models.Model):
    _name = 'project.baseline'
    _description = "Project Baseline"
    _order = 'create_date desc'

    name = fields.Char(string="Name", required=True)
    project_id = fields.Many2one('project.project', string="Project",
                                 required=True, ondelete='cascade')
    line_ids = fields.One2many('project.baseline.line', 'baseline_id',
                               string="Baseline Lines")
    note = fields.Text(string="Notes")

    def action_save_snapshot(self):
        self.ensure_one()
        tasks = self.env['project.task'].search([
            ('project_id', '=', self.project_id.id),
            ('date_start', '!=', False),
        ])
        self.env['project.baseline.line'].create([{
            'baseline_id': self.id,
            'task_id': t.id,
            'date_start': t.date_start,
            'date_end': t.date_end,
            'duration': t.duration,
            'progress': t.progress,
        } for t in tasks])
        return True


class ProjectBaselineLine(models.Model):
    _name = 'project.baseline.line'
    _description = "Project Baseline Line"

    baseline_id = fields.Many2one('project.baseline', required=True, ondelete='cascade')
    task_id = fields.Many2one('project.task', required=True, ondelete='cascade')
    date_start = fields.Datetime(string="Start Date")
    date_end = fields.Datetime(string="End Date")
    duration = fields.Integer(string="Duration")
    progress = fields.Float(string="Progress")
