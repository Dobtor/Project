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
        ondelete='cascade',
        index=True,
    )
    parent_task_id = fields.Many2one(
        'project.task',
        string='前置任務',
        required=True,
        ondelete='restrict',
        index=True,
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
        # predecessor_parent on parent tasks is recomputed automatically via the
        # project.task.as_predecessor_ids inverse relation — no manual write here.
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
        # predecessor_parent recomputes via the as_predecessor_ids inverse.
        # Sync depend_on_ids
        records._sync_depend_on_ids()
        return records

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
            # BFS: walk successors from task_id; if we reach parent_task_id → cycle.
            #
            # The graph is built from every link that TOUCHES the project, not
            # only those whose target lives in it: a link may cross projects
            # (_build_outbound_pred_map cascades across them), and a cycle that
            # left the project and came back was invisible to a same-project
            # graph. Keyed by project so the map is still built once per project
            # in a batch create.
            pid = rec.task_id.project_id.id
            if pid not in project_succ_maps:
                project_preds = Predecessor.search([
                    '|',
                    ('task_id.project_id', '=', pid),
                    ('parent_task_id.project_id', '=', pid),
                ])
                sm = {}
                for p in project_preds:
                    sm.setdefault(p.parent_task_id.id, []).append(p.task_id.id)
                # One hop out is not enough on its own: pull in the links of
                # every task the first hop reaches, so a path that leaves and
                # returns is walkable.
                outside = {t for succs in sm.values() for t in succs} - set(sm)
                if outside:
                    for p in Predecessor.search([('parent_task_id', 'in', list(outside))]):
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
        """Delete predecessors and re-sync native depend_on_ids."""
        # Collect affected task IDs before deletion. predecessor_parent on the
        # parent tasks is recomputed automatically via the as_predecessor_ids
        # inverse relation when these links are removed.
        had_blocking = self.filtered('enable_blocking').mapped('task_id').ids

        res = super().unlink()

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
