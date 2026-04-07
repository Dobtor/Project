# -*- coding: utf-8 -*-
from odoo import models, api, _
from odoo.exceptions import UserError
from operator import itemgetter


class ProjectTaskTreeUpdate(models.Model):
    _inherit = 'project.task'

    @api.model
    def tree_update(self, tree_data, id_update, parent_id, project_id=None):
        """Update tree structure - optimized with batch operations"""
        if not project_id or not isinstance(project_id, int):
            raise UserError(_('必須指定有效的專案。'))
        proj = self.env['project.project'].browse(project_id).exists()
        if not proj:
            raise UserError(_('找不到專案。'))
        proj.check_access('write')

        # Validate id_update type
        if not isinstance(id_update, int):
            raise UserError(_('無效的任務 ID。'))

        # Validate parent_id belongs to the same project
        if parent_id:
            if not isinstance(parent_id, int):
                raise UserError(_('無效的父任務 ID。'))
            parent_task = self.browse(parent_id).exists()
            if not parent_task or parent_task.project_id.id != project_id:
                raise UserError(_('父任務不屬於同一專案。'))

        # Collect all updates first
        updates = {}
        for idx, val in enumerate(tree_data):
            if not val["is_group"]:
                try:
                    task_id = int(val["id"])
                except (ValueError, TypeError):
                    raise UserError(_('無效的任務 ID: %s', val.get("id")))
                var_data = {
                    "sorting_seq": idx,
                    "sorting_level": val["sorting_level"],
                    "plan_action": val["plan_action"],
                }

                if task_id == id_update:
                    var_data["parent_id"] = parent_id if parent_id and isinstance(parent_id, int) else False

                updates[task_id] = var_data

        # Batch update — validate all tasks belong to the same project
        if updates:
            task_ids = list(updates.keys())
            tasks = self.browse(task_ids).exists()
            tasks = tasks.filtered(lambda t: t.project_id.id == project_id)
            for task in tasks:
                task.write(updates[task.id])

        return True

    @api.model
    def fold_update(self, task_ids, project_id=None):
        """Update fold state - optimized with batch operations"""
        if not task_ids:
            return True

        all_ids = [int(k) for k in task_ids.keys()]
        tasks = self.browse(all_ids).exists()
        tasks.check_access('write')

        # Validate all tasks belong to the same project
        project_ids = tasks.mapped('project_id')
        if len(project_ids) > 1:
            raise UserError(_('所有任務必須屬於同一專案。'))
        if project_id and project_ids and project_ids.id != project_id:
            raise UserError(_('任務不屬於指定的專案。'))

        # Group tasks by fold state for batch updates
        fold_true_ids = [int(k) for k, v in task_ids.items() if v]
        fold_false_ids = [int(k) for k, v in task_ids.items() if not v]

        if fold_true_ids:
            tasks.filtered(lambda t: t.id in fold_true_ids).write({'fold': True})
        if fold_false_ids:
            tasks.filtered(lambda t: t.id in fold_false_ids).write({'fold': False})

        return True

    def tree_onfly(self, query, parent, _depth=0):
        """Build tree structure with nested children (depth limited to 50)."""
        parent['children'] = []
        if _depth >= 50:
            return parent
        for item in query:
            if item['parent_id'] == parent['id']:
                parent['children'].append(item)
                self.tree_onfly(query, item, _depth + 1)
        return parent

    def flat_onfly(self, object, level=0):
        """Flatten tree structure for display"""
        result = []

        def _get_rec(children, level, parent=None):
            children = sorted(children, key=itemgetter('sorting_seq'))
            for line in children:
                result.append({
                    'id': '{}'.format(line["id"]),
                    'name': u'{}'.format(line["name"]),
                    'parent_id': u'{}'.format(line["parent_id"]),
                    'sorting_seq': line["sorting_seq"],
                    'level': '{}'.format(level),
                })

                if line["children"] and level < 16:
                    _get_rec(line["children"], level + 1, line["id"])

        _get_rec(object, level)
        return result

    def do_sorting(self, project_id=None):
        """Sort tasks in project - optimized with batch read and write"""
        if not project_id:
            return
        project = self.env['project.project'].browse(project_id).exists()
        if project:
            project.check_access('write')
        search_objs = self.search([('project_id', '=', project_id)], order="sorting_seq asc")

        if not search_objs:
            return

        # Use read() for efficient batch data retrieval
        line_datas = search_objs.read(['id', 'name', 'parent_id', 'sorting_seq'])

        # Format data for tree building
        for line in line_datas:
            line['id'] = str(line['id'])
            line['parent_id'] = str(line['parent_id'][0]) if line['parent_id'] else 'False'

        root = {'id': "False"}

        # Build tree with all sub-levels
        tree_onfly = self.tree_onfly(line_datas, root)

        # Flatten tree to sorted list for UI display
        flat_onfly = self.flat_onfly(tree_onfly["children"])

        # Collect all updates for batch processing
        updates = {
            int(line["id"]): {
                "sorting_seq": index + 1,
                "sorting_level": int(line["level"]),
            }
            for index, line in enumerate(flat_onfly)
        }

        # Batch update via unnest + JOIN for O(1) queries instead of N
        # Using parameterized query to avoid SQL injection risk from f-string
        if updates:
            ids = list(updates.keys())
            seqs = [updates[tid]['sorting_seq'] for tid in ids]
            lvls = [updates[tid]['sorting_level'] for tid in ids]
            self.env.cr.execute("""
                UPDATE project_task AS t
                SET sorting_seq = v.seq,
                    sorting_level = v.lvl,
                    write_date = NOW() AT TIME ZONE 'UTC',
                    write_uid = %s
                FROM unnest(%s::int[], %s::int[], %s::int[])
                    AS v(id, seq, lvl)
                WHERE t.id = v.id
                  AND t.project_id = %s
            """, (self.env.uid, ids, seqs, lvls, project_id))
            self.browse(ids).invalidate_recordset(['sorting_seq', 'sorting_level', 'write_date', 'write_uid'])
