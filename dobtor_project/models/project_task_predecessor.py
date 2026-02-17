# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError, ValidationError


class ProjectTaskPredecessor(models.Model):
    _name = 'project.task.predecessor'
    _description = "Project Task Predecessor"
    _inherit = ['gantt.native.predecessor']

    task_id = fields.Many2one(
        'project.task',
        string='任務',
        ondelete='cascade'
    )
    parent_task_id = fields.Many2one(
        'project.task',
        string='前置任務',
        required=True,
        ondelete='restrict',
        domain="[('project_id','=', parent.project_id)]"
    )
    type = fields.Selection(
        selection='_get_link_type',
        string='類型',
        required=True,
        default='FS'
    )

    _sql_constraints = [
        ('project_task_link_uniq', 'unique(task_id, parent_task_id, type)', 'Must be unique.'),
    ]

    def write(self, vals):
        res = super().write(vals)
        # Update predecessor_parent on parent tasks after write
        if res and "parent_task_id" in vals:
            self._update_parent_task_predecessor_parent()
        return res

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
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
            # Set predecessor_parent = 1 as a boolean flag (0/1) indicating
            # this task is a parent in at least one predecessor link.
            # The actual count is maintained by _compute_predecessor_count;
            # this write is a fast-path signal for UI/scheduling checks.
            self.env['project.task'].browse(parent_task_ids).write({
                'predecessor_parent': 1,
            })

    @api.constrains('task_id', 'parent_task_id')
    def _check_circular_dependency(self):
        """Detect circular dependencies using BFS traversal."""
        Predecessor = self.env['project.task.predecessor']
        for rec in self:
            if not rec.task_id or not rec.parent_task_id:
                continue
            if rec.task_id == rec.parent_task_id:
                raise ValidationError(_(
                    '任務不能以自身作為前置任務 (%(task_name)s)。',
                    task_name=rec.task_id.name,
                ))
            # BFS: walk successors from task_id; if we reach parent_task_id → cycle
            visited = set()
            queue = [rec.task_id.id]
            while queue:
                current = queue.pop(0)
                if current in visited:
                    continue
                visited.add(current)
                successors = Predecessor.search([
                    ('parent_task_id', '=', current),
                ]).mapped('task_id.id')
                for succ in successors:
                    if succ == rec.parent_task_id.id:
                        raise ValidationError(_(
                            '偵測到循環依賴：%(from_name)s → ... → %(to_name)s → %(from_name)s',
                            from_name=rec.task_id.name,
                            to_name=rec.parent_task_id.name,
                        ))
                    queue.append(succ)

    @api.constrains('task_id', 'parent_task_id')
    def _check_ancestor_descendant(self):
        """Prevent predecessor links between tasks in the same parent-child hierarchy."""
        for rec in self:
            if not rec.task_id or not rec.parent_task_id:
                continue
            # Check if parent_task_id is an ancestor of task_id
            task = rec.task_id
            while task.parent_id:
                if task.parent_id == rec.parent_task_id:
                    raise ValidationError(_(
                        '不能在父子任務之間建立前置關聯 (%(task1)s ↔ %(task2)s)。',
                        task1=rec.task_id.name,
                        task2=rec.parent_task_id.name,
                    ))
                task = task.parent_id
            # Check if task_id is an ancestor of parent_task_id
            task = rec.parent_task_id
            while task.parent_id:
                if task.parent_id == rec.task_id:
                    raise ValidationError(_(
                        '不能在父子任務之間建立前置關聯 (%(task1)s ↔ %(task2)s)。',
                        task1=rec.task_id.name,
                        task2=rec.parent_task_id.name,
                    ))
                task = task.parent_id

    def unlink(self):
        """Delete predecessors and update parent tasks - optimized"""
        # Collect parent task IDs before deletion
        parent_task_ids = self.mapped('parent_task_id').ids

        res = super().unlink()

        if res and parent_task_ids:
            # Raw SQL for performance: avoids ORM search() + mapped() on
            # potentially large predecessor table after bulk unlink.
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
