# -*- coding: utf-8 -*-
from odoo import models, api
from operator import itemgetter


class ProjectTaskTreeUpdate(models.Model):
    _inherit = 'project.task'

    @api.model
    def tree_update(self, tree_data, id_update, parent_id):
        """Update tree structure - optimized with batch operations"""
        # Collect all updates first
        updates = {}
        for idx, val in enumerate(tree_data):
            if not val["is_group"]:
                task_id = int(val["id"])
                var_data = {
                    "sorting_seq": idx,
                    "sorting_level": val["sorting_level"],
                    "plan_action": val["plan_action"],
                }

                if task_id == id_update:
                    var_data["parent_id"] = parent_id if parent_id and isinstance(parent_id, int) else None

                updates[task_id] = var_data

        # Batch update using browse instead of search
        if updates:
            for task_id, var_data in updates.items():
                task = self.browse(task_id).exists()
                if task:
                    task.write(var_data)

        return True

    @api.model
    def fold_update(self, task_ids):
        """Update fold state - optimized with batch operations"""
        if not task_ids:
            return True

        # Group tasks by fold state for batch updates
        fold_true_ids = [int(k) for k, v in task_ids.items() if v]
        fold_false_ids = [int(k) for k, v in task_ids.items() if not v]

        if fold_true_ids:
            self.browse(fold_true_ids).write({'fold': True})
        if fold_false_ids:
            self.browse(fold_false_ids).write({'fold': False})

        return True

    def tree_onfly(self, query, parent):
        """Build tree structure with nested children"""
        parent['children'] = []
        for item in query:
            if item['parent_id'] == parent['id']:
                parent['children'].append(item)
                self.tree_onfly(query, item)
        return parent

    def flat_onfly(self, object, level=0):
        """Flatten tree structure for display"""
        result = []

        def _get_rec(object, level, parent=None):
            object = sorted(object, key=itemgetter('sorting_seq'))
            for line in object:
                res = {}
                res['id'] = '{}'.format(line["id"])
                res['name'] = u'{}'.format(line["name"])
                res['parent_id'] = u'{}'.format(line["parent_id"])
                res['sorting_seq'] = line["sorting_seq"]
                res['level'] = '{}'.format(level)

                result.append(res)

                if line["children"]:
                    if level < 16:
                        level += 1
                        parent = line["id"]

                    _get_rec(line["children"], level, parent)

                    if level > 0 and level < 16:
                        level -= 1
                        parent = None

            return result

        children = _get_rec(object, level)
        return children

    def do_sorting(self, project_id=None):
        """Sort tasks in project - optimized with batch read and write"""
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

        # Batch update using browse
        for task_id, var_data in updates.items():
            self.browse(task_id).write(var_data)
