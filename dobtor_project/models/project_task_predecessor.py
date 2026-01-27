# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError


class ProjectTaskPredecessor(models.Model):
    _name = 'project.task.predecessor'
    _description = "Project Task Predecessor"
    _inherit = ['gantt.native.predecessor']

    task_id = fields.Many2one(
        'project.task',
        string='Task',
        ondelete='cascade'
    )
    parent_task_id = fields.Many2one(
        'project.task',
        string='Parent Task',
        required=True,
        ondelete='restrict',
        domain="[('project_id','=', parent.project_id)]"
    )
    type = fields.Selection(
        selection='_get_link_type',
        string='Type',
        required=True,
        default='FS'
    )

    _sql_constraints = [
        ('project_task_link_uniq', 'unique(task_id, parent_task_id, type)', 'Must be unique.'),
    ]

    def write(self, vals):
        if "parent_task_id" in vals:
            self.check_parent(vals["parent_task_id"])
        res = super(ProjectTaskPredecessor, self).write(vals)
        # Update predecessor_parent on parent tasks after write
        if res and "parent_task_id" in vals:
            self._update_parent_task_predecessor_parent()
        return res

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if "parent_task_id" in vals:
                self.check_parent(vals["parent_task_id"])
        records = super(ProjectTaskPredecessor, self).create(vals_list)
        # Update predecessor_parent on parent tasks after create
        records._update_parent_task_predecessor_parent()
        return records

    def _update_parent_task_predecessor_parent(self):
        """Update predecessor_parent field on parent tasks.

        This method is called from create/write to maintain the predecessor_parent
        field, avoiding side effects in compute methods (Odoo 18 best practice).
        """
        parent_task_ids = self.mapped('parent_task_id').ids
        if parent_task_ids:
            # Set predecessor_parent = 1 for tasks that are parents in predecessor links
            self.env['project.task'].browse(parent_task_ids).write({
                'predecessor_parent': 1,
            })

    def check_parent(self, task_id):
        """Check if task can have predecessors - use browse instead of search"""
        task = self.env['project.task'].browse(task_id).exists()
        if not task:
            raise UserError(_('Task not found.'))
        if task.child_ids:
            raise UserError(_(
                'You can not add a Predecessor for Task with subtask (%(task_name)s).\n'
                'Please Select Task inside Parent Task.',
                task_name=task.name
            ))

    def unlink(self):
        """Delete predecessors and update parent tasks - optimized"""
        # Collect parent task IDs before deletion
        parent_task_ids = self.mapped('parent_task_id').ids

        res = super(ProjectTaskPredecessor, self).unlink()

        if res and parent_task_ids:
            # Batch query: find which parent tasks still have predecessors
            self.env.cr.execute("""
                SELECT DISTINCT parent_task_id
                FROM project_task_predecessor
                WHERE parent_task_id IN %s
            """, (tuple(parent_task_ids),))
            still_parents = {row[0] for row in self.env.cr.fetchall()}

            # Tasks that no longer have predecessors
            tasks_to_reset = set(parent_task_ids) - still_parents
            if tasks_to_reset:
                self.env['project.task'].browse(list(tasks_to_reset)).write({
                    'predecessor_parent': 0
                })

        return res
