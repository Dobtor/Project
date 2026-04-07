# -*- coding: utf-8 -*-
from collections import deque
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
    enable_blocking = fields.Boolean(
        default=True,
        help='FS 預設啟用阻擋；SS/FF/SF 預設不啟用。',
    )

    _sql_constraints = [
        ('project_task_link_uniq', 'unique(task_id, parent_task_id, type)', 'Must be unique.'),
    ]

    @api.onchange('type')
    def _onchange_type_set_blocking(self):
        """FS 預設啟用阻擋，其他類型預設不啟用。"""
        for rec in self:
            rec.enable_blocking = (rec.type == 'FS')

    @api.model
    def _default_enable_blocking(self, link_type):
        """Return default enable_blocking based on link type."""
        return link_type == 'FS'

    def write(self, vals):
        res = super().write(vals)
        # Update predecessor_parent on parent tasks after write
        if res and "parent_task_id" in vals:
            self._update_parent_task_predecessor_parent()
        # Sync depend_on_ids when blocking-related fields change
        if res and any(f in vals for f in ('parent_task_id', 'task_id', 'enable_blocking')):
            self._sync_depend_on_ids()
        return res

    @api.model_create_multi
    def create(self, vals_list):
        # Auto-set enable_blocking based on type if not explicitly provided
        for v in vals_list:
            if 'enable_blocking' not in v:
                v['enable_blocking'] = self._default_enable_blocking(v.get('type', 'FS'))
        records = super().create(vals_list)
        # Update predecessor_parent on parent tasks after create
        records._update_parent_task_predecessor_parent()
        # Sync depend_on_ids
        records._sync_depend_on_ids()
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
        # Pre-load predecessors per project once to avoid repeated searches
        project_succ_maps = {}
        for rec in self:
            if not rec.task_id or not rec.parent_task_id:
                continue
            if rec.task_id == rec.parent_task_id:
                raise ValidationError(_(
                    '任務不能以自身作為前置任務 (%(task_name)s)。',
                    task_name=rec.task_id.name,
                ))
            # BFS: walk successors from task_id; if we reach parent_task_id → cycle
            pid = rec.task_id.project_id.id
            if pid not in project_succ_maps:
                project_preds = Predecessor.search([
                    ('task_id.project_id', '=', pid),
                ])
                sm = {}
                for p in project_preds:
                    sm.setdefault(p.parent_task_id.id, []).append(p.task_id.id)
                project_succ_maps[pid] = sm
            succ_map = project_succ_maps[pid]

            visited = set()
            queue = deque([rec.task_id.id])
            target = rec.parent_task_id.id
            while queue:
                current = queue.popleft()
                if current in visited:
                    continue
                visited.add(current)
                for succ in succ_map.get(current, []):
                    if succ == target:
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
            depth = 0
            while task.parent_id and depth < 100:
                if task.parent_id == rec.parent_task_id:
                    raise ValidationError(_(
                        '不能在父子任務之間建立前置關聯 (%(task1)s ↔ %(task2)s)。',
                        task1=rec.task_id.name,
                        task2=rec.parent_task_id.name,
                    ))
                task = task.parent_id
                depth += 1
            # Check if task_id is an ancestor of parent_task_id
            task = rec.parent_task_id
            depth = 0
            while task.parent_id and depth < 100:
                if task.parent_id == rec.task_id:
                    raise ValidationError(_(
                        '不能在父子任務之間建立前置關聯 (%(task1)s ↔ %(task2)s)。',
                        task1=rec.task_id.name,
                        task2=rec.parent_task_id.name,
                    ))
                task = task.parent_id
                depth += 1

    def _sync_depend_on_ids(self):
        """Sync native depend_on_ids from predecessor records.

        For each affected task_id, rebuild its depend_on_ids to match
        all predecessor records where enable_blocking=True.
        """
        if self.env.context.get('skip_depend_on_sync'):
            return
        task_ids = self.mapped('task_id')
        if not task_ids:
            return
        for task in task_ids:
            blocking_parent_ids = self.search([
                ('task_id', '=', task.id),
                ('enable_blocking', '=', True),
            ]).mapped('parent_task_id').ids
            # Use context flag to prevent inverse from re-syncing back
            task.with_context(skip_predecessor_sync=True).write({
                'depend_on_ids': [(6, 0, blocking_parent_ids)],
            })

    def unlink(self):
        """Delete predecessors and update parent tasks - optimized"""
        # Collect affected task/parent IDs before deletion
        parent_task_ids = self.mapped('parent_task_id').ids
        affected_task_ids = self.mapped('task_id').ids
        had_blocking = self.filtered('enable_blocking').mapped('task_id').ids

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

        # Re-sync depend_on_ids for affected tasks (blocking links removed)
        if res and had_blocking:
            Task = self.env['project.task']
            for task_id in had_blocking:
                task = Task.browse(task_id).exists()
                if not task:
                    continue
                blocking_parent_ids = self.search([
                    ('task_id', '=', task_id),
                    ('enable_blocking', '=', True),
                ]).mapped('parent_task_id').ids
                task.with_context(skip_predecessor_sync=True).write({
                    'depend_on_ids': [(6, 0, blocking_parent_ids)],
                })

        return res
