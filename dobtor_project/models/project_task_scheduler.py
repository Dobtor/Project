# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from collections import deque
from datetime import timedelta
import logging

_logger = logging.getLogger(__name__)


class ProjectTaskNativeScheduler(models.Model):
    _inherit = 'project.task'
    
    def _scheduler_plan_start_calc(self, project):
        """Main scheduling entry point - optimized to avoid N+1 queries.

        The entire scheduling operation is wrapped in a DB savepoint so that
        if anything fails mid-way (e.g. after schedule_end has already been
        cleared by _project_check_date), the transaction rolls back to the
        pre-scheduling state and no data is permanently lost.
        """
        _logger.info("Starting schedule calculation for project: %s (ID: %s)", project.name, project.id)

        cr = self.env.cr

        scheduling_type = project.scheduling_type

        # Wrap the entire scheduling in a savepoint.  If any step fails
        # (especially after _project_check_date has cleared schedule_end),
        # the savepoint rollback restores the original values.
        with cr.savepoint():
            self._scheduler_plan_start_calc_inner(project, scheduling_type)

        _logger.info("Schedule calculation completed for project: %s (ID: %s)", project.name, project.id)

    def _scheduler_plan_start_calc_inner(self, project, scheduling_type):
        """Inner scheduling logic — called inside a savepoint."""
        tasks_ap = []
        project_id = project.id
        leave_ids = list()
        attendance_ids = list()
        t_params = {}

        # Tasks - search with active filter
        domain = [('project_id', '=', project_id), '|', ('active', '=', True), ('active', '=', False)]
        arch_tasks = self.env['project.task'].search(domain)
        tasks_list = arch_tasks.sorted(key=lambda x: x.sorting_seq)

        t_params = {
            'leave_ids': leave_ids,
            'attendance_ids': attendance_ids,
            'scheduling_type': scheduling_type,
            'project_id': project_id,
            'project': project
        }

        # OPTIMIZATION: Fetch ALL predecessors for ALL tasks in ONE query
        task_ids = tasks_list.ids
        all_predecessors = self.env['project.task.predecessor'].search([
            '|',
            ('task_id', 'in', task_ids),
            ('parent_task_id', 'in', task_ids)
        ])

        # Build predecessors_ap list from batch query result
        predecessors_ap = []
        predecessor_data = all_predecessors.read(['id', 'type', 'lag_hours', 'parent_task_id', 'task_id'])
        for pred in predecessor_data:
            predecessors_ap.append({
                "id": pred['id'],
                "type": pred['type'],
                "lag_hours": pred['lag_hours'] or 0.0,
                "parent_task_id": pred['parent_task_id'][0] if pred['parent_task_id'] else False,
                "task_id": pred['task_id'][0] if pred['task_id'] else False,
            })

        t_params["predecessors_ap"] = predecessors_ap

        # Batch delete all detail plans
        detail_plan_model = self.env['project.task.detail.plan']
        detail_plan_model.search([('task_id', 'in', task_ids)]).unlink()

        # OPTIMIZATION: Prefetch task resources to avoid N+1 queries
        tasks_list.mapped('task_resource_ids')
        
        # Batch fetch all task resources info
        task_resource_map = {}
        for task in tasks_list:
            if hasattr(task, 'task_resource_ids'):
                task_resource_map[task.id] = task.task_resource_ids

        for task in tasks_list:
            task_resource_ids = task_resource_map.get(task.id, False)

            cal_id, task_res, t_params = self.make_res_cal_leave(task_resource_ids, t_params, task_ids)

            soon_date_start = None
            soon_date_end = None
            late_date_start = None
            late_date_end = None

            if scheduling_type == "forward":
                soon_date_start = task.date_start or None
                soon_date_end = task.date_end or None

            if scheduling_type == "backward":
                late_date_start = task.date_start or None
                late_date_end = task.date_end or None

            tasks_ap.append({
                "id": task.id,
                "plan_duration": task.plan_duration,
                "plan_offset": task.plan_offset,
                "soon_date_start": soon_date_start,
                "soon_date_end": soon_date_end,
                "late_date_start": late_date_start,
                "late_date_end": late_date_end,
                "schedule_mode": task.schedule_mode,
                "project_id": project,
                "constrain_type": task.constrain_type,
                "constrain_date": task.constrain_date,
                "detail_plan": task.detail_plan,
                "name": task.name,
                "cal_id": cal_id,
                "task_resource_ids": task_resource_ids,
                "task_res": task_res,
                "fixed_calc_type": task.fixed_calc_type,
                "p_loop": False
            })

        # Project dates check
        p_date_start, p_date_end = self._project_check_date(project, scheduling_type)
        project_ap = {
            "id": project.id,
            "project_obj": project,
            "date_start": p_date_start,
            "date_end": p_date_end
        }

        # Remove task info by critical path
        info_name = "cp_{}".format(project.id)
        self._task_info_remove(info_name)

        # Calc First Step
        tasks_ap = self._ap_calc_tasks_list(project_ap=project_ap, tasks_ap=tasks_ap, t_params=t_params, revers_step=False)

        # Calc new project date
        project_ap = self._project_get_date(project_ap, tasks_ap, scheduling_type)

        # Calc Revers Step
        tasks_ap = self._ap_calc_tasks_list(project_ap=project_ap, tasks_ap=tasks_ap, t_params=t_params, revers_step=True)

        # Calc Critical Path
        for task_cp in tasks_ap:
            self._critical_path_calc(task=task_cp)

        # Check ALAP constraints
        for task_alap in tasks_ap:
            if task_alap["constrain_type"] == "alap":
                alap_run = False
                if scheduling_type == "forward":
                    soon_date_end = task_alap["soon_date_end"]
                    late_date_end = task_alap["late_date_end"]
                    if late_date_end > soon_date_end:
                        alap_run = True
                        task_alap["soon_date_start"] = task_alap["late_date_start"]
                        task_alap["soon_date_end"] = task_alap["late_date_end"]
                        if "late_detail_plan" in task_alap.keys():
                            task_alap["soon_detail_plan"] = task_alap["late_detail_plan"]
                else:
                    soon_date_start = task_alap["soon_date_start"]
                    late_date_start = task_alap["late_date_start"]
                    if soon_date_start > late_date_start:
                        alap_run = True
                        task_alap["late_date_start"] = task_alap["soon_date_start"]
                        task_alap["late_date_end"] = task_alap["soon_date_end"]
                        if "soon_detail_plan" in task_alap.keys():
                            task_alap["late_detail_plan"] = task_alap["soon_detail_plan"]

                if alap_run:
                    self._ap_calc_scheduler_recur_work(
                        task_id=task_alap["id"], project=project_ap, tasks=tasks_ap, t_params=t_params, revers_step=False
                    )

        # Write result to tasks — batch browse + deferred recompute
        calc_tasks = [t for t in tasks_ap if "calc" in t]
        calc_task_ids = [t["id"] for t in calc_tasks]
        task_obj_map = {
            t.id: t
            for t in self.env['project.task'].browse(calc_task_ids)
        } if calc_task_ids else {}

        # Collect (task_obj, vals) pairs first, then write in a deferred
        # recompute block so field recomputations happen only once at the end.
        write_queue = []
        for task_new in calc_tasks:
            task_obj = task_obj_map.get(task_new["id"])
            if not task_obj:
                continue

            vals = {}
            vals = self._task_info_add(task=task_new, vals=vals, info_name=info_name)

            if scheduling_type == "forward":
                task_date_start = "soon_date_start"
                task_date_end = "soon_date_end"
                detail_plan = "soon_detail_plan"
            else:
                task_date_start = "late_date_start"
                task_date_end = "late_date_end"
                detail_plan = "late_detail_plan"

            vals["date_start"] = task_new[task_date_start]
            vals["date_end"] = task_new[task_date_end]

            if detail_plan in task_new:
                save_detail_plan = False
                if task_obj.project_id and task_obj.project_id.detail_plan:
                    save_detail_plan = task_obj.project_id.detail_plan
                elif task_obj.detail_plan:
                    save_detail_plan = True

                if save_detail_plan:
                    task_detail_lines = self._add_detail_plan(task_new[detail_plan])
                    if task_detail_lines:
                        vals["detail_plan_ids"] = task_detail_lines

            if "critical_path" in task_new:
                vals["critical_path"] = task_new["critical_path"]

            vals["p_loop"] = task_new["p_loop"]
            write_queue.append((task_obj, vals))

        # Batch write: skip date snap and cascade push during scheduling
        for task_obj, vals in write_queue:
            task_obj.with_context(
                skip_date_snap=True,
                skip_cascade_push=True,
                skip_auto_complete=True,
            ).write(vals)

    def _project_get_date(self, project_ap, tasks_ap, scheduling_type):
        prj_task_date = []
        if scheduling_type == "forward":
            date_obj = "soon_date_end"
            p_date_obj = "date_end"
            limit = max
        elif scheduling_type == "backward":
            date_obj = "late_date_start"
            p_date_obj = "date_start"
            limit = min
        else:
            return False

        for task in tasks_ap:
            if task[date_obj] and "calc" in task.keys():
                prj_task_date.append(task[date_obj])

        if prj_task_date:
            new_date = limit(prj_task_date)
            project_ap[p_date_obj] = new_date

        return project_ap

    def _ap_calc_tasks_list(self, project_ap, tasks_ap, t_params, revers_step=False):
        """Calculate tasks list - removed unnecessary sudo()"""
        search_tasks = []
        scheduling_type = t_params["scheduling_type"]
        project_id = t_params["project_id"]

        if revers_step:
            if scheduling_type == "forward":
                scheduling_type = "backward"
            elif scheduling_type == "backward":
                scheduling_type = "forward"

        if scheduling_type == "forward":
            search_tasks = self.env['project.task'].search([
                ('project_id', '=', project_id),
                ('predecessor_count', '=', 0)
            ])

        if scheduling_type == "backward":
            search_tasks = self.env['project.task'].search([
                ('project_id', '=', project_id),
                ('predecessor_parent', '=', 0)
            ])

        # Use local scheduling_type — do NOT mutate t_params to avoid
        # polluting subsequent calls (e.g. ALAP processing after reverse step).
        local_params = dict(t_params, scheduling_type=scheduling_type)

        for search_task in search_tasks:
            tasks_ap = self._ap_calc_scheduler_first_work(
                task=search_task, tasks=tasks_ap, project=project_ap, t_params=local_params, revers_step=revers_step
            )
        return tasks_ap

    def _ap_calc_scheduler_first_work(self, task, tasks, project, t_params, revers_step=False):
        scheduling_type = t_params["scheduling_type"]

        if not task.child_ids:
            vals = {}

            if task.schedule_mode == "auto":
                task_obj = self._task_from_list(tasks, task.id)

                if scheduling_type == "forward":
                    direction = "normal"
                    date_type = "date_start"
                    cp_date_start = "soon_date_start"
                    cp_date_end = "soon_date_end"
                elif scheduling_type == "backward":
                    direction = "revers"
                    date_type = "date_end"
                    cp_date_start = "late_date_start"
                    cp_date_end = "late_date_end"
                else:
                    return tasks

                new_date = project[date_type]
                if not new_date:
                    return tasks

                # Use plan_offset to preserve relative position from planning mode
                plan_offset = task_obj.get("plan_offset", 0)
                if plan_offset:
                    proj_obj = t_params.get("project")
                    if proj_obj and proj_obj.use_calendar and proj_obj.resource_calendar_id:
                        # plan_offset is in working hours — convert via calendar
                        offset_task = {
                            "id": 0,
                            "name": "_offset_calc",
                            "project_id": proj_obj,
                            "task_resource_ids": task_obj.get("task_resource_ids", self.env['project.task.resource.link']),
                            "task_res": task_obj.get("task_res", [{"calendar_id": proj_obj.resource_calendar_id.id or -1,
                                                                     "resource_id": -1, "load_factor": 1, "load_control": "no"}]),
                            "fixed_calc_type": "duration",
                            "plan_duration": plan_offset,
                        }
                        offset_level = self._get_calendar_level(
                            offset_task, new_date, plan_offset, t_params, direction=direction)
                        if offset_level:
                            new_date = self._get_date_from_level(
                                offset_level, "date_to" if direction == "normal" else "date_from",
                                "max" if direction == "normal" else "min") or new_date
                        else:
                            new_date = new_date + timedelta(hours=plan_offset)
                    else:
                        new_date = new_date + timedelta(hours=plan_offset)

                calendar_level, date_start, date_end = self._ap_calc_period(
                    task_obj=task_obj, direction=direction, new_date=new_date, date_type=date_type, t_params=t_params
                )

                vals[cp_date_start] = date_start
                vals[cp_date_end] = date_end

                vals, calendar_level = self._scheduler_work_constrain(
                    task_obj, vals, calendar_level, scheduling_type, t_params
                )

                if calendar_level:
                    vals["detail_plan"] = calendar_level

                tasks = [self._task_date_update(x_task, task.id, vals) for x_task in tasks]
            else:
                vals["calc"] = True
                tasks = [self._task_date_update(x_task, task.id, vals) for x_task in tasks]

            tasks = self._ap_calc_scheduler_recur_work(
                task_id=task.id, project=project, tasks=tasks, t_params=t_params, revers_step=revers_step
            )
            return tasks
        else:
            return tasks

    def _ap_calc_scheduler_recur_work(self, task_id, project, tasks, t_params, revers_step=False):
        scheduling_type = t_params["scheduling_type"]
        predecessors = t_params["predecessors_ap"]

        task_field = 'task_id'
        next_task_field = "parent_task_id"

        if scheduling_type == "forward":
            task_field = "parent_task_id"
            next_task_field = "task_id"

        next_stack = deque([task_id])
        visited_ids = set()

        _itr = 0
        while next_stack:
            current_batch = list(next_stack)
            next_stack.clear()

            for next_id in current_batch:
                if next_id in visited_ids:
                    # Circular dependency detected — mark as loop
                    tasks = [self._task_date_update(x_task, next_id, {"p_loop": True}) for x_task in tasks]
                    continue

                visited_ids.add(next_id)

                search_objs = filter(lambda x: x[task_field] == next_id, predecessors)
                search_objs = list(search_objs)

                for predecessor_obj in search_objs:
                    date_list = self._calc_date_list(scheduling_type, predecessors, tasks, predecessor_obj)
                    target_id = predecessor_obj[next_task_field]
                    task_obj = self._task_from_list(tasks, task_id=target_id)

                    if task_obj:
                        vals, calendar_level = self._calc_new_date(
                            scheduling_type=scheduling_type, predecessor_obj=predecessor_obj,
                            task_obj=task_obj, date_list=date_list, t_params=t_params
                        )

                        if task_obj["schedule_mode"] == "auto":
                            if vals and 'plan_action' not in vals.keys():
                                vals, calendar_level = self._scheduler_work_constrain(
                                    task_obj, vals, calendar_level, scheduling_type, t_params
                                )
                                if calendar_level:
                                    vals["detail_plan"] = calendar_level
                        else:
                            vals["calc"] = True

                        tasks = [self._task_date_update(x_task, target_id, vals) for x_task in tasks]

                    if target_id not in visited_ids:
                        next_stack.append(target_id)

            _itr = _itr + 1
            if not next_stack:
                return tasks

        return tasks

    def _project_check_date(self, project, scheduling_type):
        """Check and set project schedule dates for scheduling.

        Uses schedule_start/schedule_end (Datetime) instead of native
        date_start (Date) to avoid type conflict with Odoo 18.
        """
        date_start = project.schedule_start
        date_end = project.schedule_end

        if scheduling_type == "forward":
            pvals = {}
            if not date_start:
                date_start = fields.Datetime.now()
                pvals['schedule_start'] = date_start
            pvals['schedule_end'] = date_end = None
            project.write(pvals)

        if scheduling_type == "backward":
            pvals = {}
            if not date_end:
                date_end = fields.Datetime.now()
                pvals['schedule_end'] = date_end
            pvals['schedule_start'] = date_start = None
            project.write(pvals)

        return date_start, date_end

    def _ap_calc_date(self, date_input, date_type, plan_duration):
        new_date_start = None
        new_date_end = None

        if date_type == "date_start":
            new_date_start = date_input
            if plan_duration == 0:
                new_date_end = new_date_start
            else:
                new_date_end = date_input + timedelta(hours=plan_duration)

        if date_type == "date_end":
            new_date_end = date_input
            if plan_duration == 0:
                new_date_start = new_date_end
            else:
                new_date_start = date_input - timedelta(hours=plan_duration)

        return new_date_start, new_date_end

    def _ap_calc_period(self, task_obj, direction, new_date, date_type, t_params, cal_value=None):
        if not cal_value:
            cal_value = {
                "start_value": "date_from",
                "start_type_op": "min",
                "end_value": "date_to",
                "end_type_op": "max"
            }

        if task_obj:
            plan_duration = task_obj["plan_duration"]
            calendar_level = self._get_calendar_level(task_obj, new_date, plan_duration, t_params, direction=direction)

            if calendar_level:
                date_start = self._get_date_from_level(calendar_level, cal_value["start_value"], cal_value["start_type_op"])
                date_end = self._get_date_from_level(calendar_level, cal_value["end_value"], cal_value["end_type_op"])
            else:
                date_start, date_end = self._ap_calc_date(new_date, date_type, plan_duration)

            return calendar_level, date_start, date_end
        else:
            return False, False, False

    def _task_date_update(self, task, task_id, vals):
        if task["id"] == task_id:
            if "p_loop" in vals.keys():
                task["p_loop"] = vals["p_loop"]
                task["calc"] = True
                return task

            if "calc" in vals.keys():
                task["calc"] = True
                return task

            if "soon_date_start" in vals.keys() and "soon_date_end" in vals.keys():
                date_start = "soon_date_start"
                date_end = "soon_date_end"
                detail_plan = "soon_detail_plan"
                task["calc"] = True
            elif "late_date_start" in vals.keys() and "late_date_end" in vals.keys():
                date_start = "late_date_start"
                date_end = "late_date_end"
                detail_plan = "late_detail_plan"
                task["calc"] = True
            else:
                return task

            task[date_start] = vals[date_start]
            task[date_end] = vals[date_end]

            if "detail_plan" in vals.keys():
                task[detail_plan] = vals["detail_plan"]
                del vals["detail_plan"]

        return task

    def _task_from_list(self, tasks, task_id):
        task_list = []
        if tasks and task_id:
            search_objs = filter(lambda x: x['id'] == task_id, tasks)

            if search_objs:
                search_objs_list = list(search_objs)
                if search_objs_list and search_objs_list[0]:
                    task_list = search_objs_list[0]

        return task_list

    def _calc_date_list(self, scheduling_type, predecessors, tasks, predecessor_obj):
        date_list = []
        type_link = predecessor_obj["type"]
        task_date_obj = 0
        parent_date_field_1 = 0
        parent_date_field_2 = 0

        if scheduling_type == "forward":
            dt_list_task_field = "task_id"
            dt_list_task_id = predecessor_obj["task_id"]
            cp_date_start = "soon_date_start"
            cp_date_end = "soon_date_end"

            if type_link == "FS":
                task_date_obj = "parent_task_id"
                parent_date_field_1 = cp_date_end
                parent_date_field_2 = cp_date_start
            elif type_link == "SS":
                task_date_obj = "parent_task_id"
                parent_date_field_1 = cp_date_start
                parent_date_field_2 = cp_date_end
            elif type_link == "FF":
                task_date_obj = "parent_task_id"
                parent_date_field_1 = cp_date_end
                parent_date_field_2 = cp_date_start
            elif type_link == "SF":
                task_date_obj = "parent_task_id"
                parent_date_field_1 = cp_date_start
                parent_date_field_2 = cp_date_end

        elif scheduling_type == "backward":
            dt_list_task_field = 'parent_task_id'
            dt_list_task_id = predecessor_obj["parent_task_id"]
            cp_date_start = "late_date_start"
            cp_date_end = "late_date_end"

            if type_link == "FS":
                task_date_obj = "task_id"
                parent_date_field_1 = cp_date_start
                parent_date_field_2 = cp_date_end
            elif type_link == "SS":
                task_date_obj = "task_id"
                parent_date_field_1 = cp_date_start
                parent_date_field_2 = cp_date_end
            elif type_link == "FF":
                task_date_obj = "task_id"
                parent_date_field_1 = cp_date_end
                parent_date_field_2 = cp_date_start
            elif type_link == "SF":
                task_date_obj = "task_id"
                parent_date_field_1 = cp_date_end
                parent_date_field_2 = cp_date_start
        else:
            return date_list

        search_date_objs = filter(lambda x: x[dt_list_task_field] == dt_list_task_id and x['type'] == type_link, predecessors)
        search_date_objs = list(search_date_objs)

        for date_obj in search_date_objs:
            parent_task = self._task_from_list(tasks, task_id=date_obj[task_date_obj])

            if parent_task and parent_date_field_1 and parent_task[parent_date_field_1]:
                parent_date = parent_task[parent_date_field_1]

                if date_obj["lag_hours"] != 0 and parent_date and parent_task[parent_date_field_2]:
                    parent_date_two = parent_task[parent_date_field_2]
                    parent_date = self._predecessor_lag_timedelta(
                        parent_date, date_obj["lag_hours"], parent_date_two
                    )
                date_list.append(parent_date)

        return date_list

    def _calc_new_date(self, scheduling_type, predecessor_obj, task_obj, date_list, t_params):
        new_date = cp_date_start = cp_date_end = direction = date_type = False
        vals = {}
        calendar_level = []
        type_link = predecessor_obj["type"]

        if date_list:
            if scheduling_type == "forward":
                cp_date_start = "soon_date_start"
                cp_date_end = "soon_date_end"

                if type_link == "FS":
                    new_date = max(date_list)
                    date_type = "date_start"
                    direction = "normal"
                if type_link == "SS":
                    new_date = min(date_list)
                    date_type = "date_start"
                    direction = "normal"
                if type_link == "FF":
                    new_date = max(date_list)
                    date_type = "date_end"
                    direction = "revers"
                if type_link == "SF":
                    new_date = min(date_list)
                    date_type = "date_end"
                    direction = "revers"

            elif scheduling_type == "backward":
                cp_date_start = "late_date_start"
                cp_date_end = "late_date_end"

                if type_link == "FS":
                    new_date = min(date_list)
                    date_type = "date_end"
                    direction = "revers"
                if type_link == "SS":
                    new_date = max(date_list)
                    date_type = "date_start"
                    direction = "normal"
                if type_link == "FF":
                    new_date = max(date_list)
                    date_type = "date_end"
                    direction = "revers"
                if type_link == "SF":
                    new_date = max(date_list)
                    date_type = "date_start"
                    direction = "normal"

        if new_date:
            calendar_level, date_start, date_end = self._ap_calc_period(
                task_obj=task_obj, direction=direction, new_date=new_date, date_type=date_type, t_params=t_params, cal_value=None
            )
            vals[cp_date_start] = date_start
            vals[cp_date_end] = date_end
        else:
            vals['plan_action'] = True

        return vals, calendar_level

    def _predecessor_lag_timedelta(self, parent_date, lag_hours, parent_date_two, plan_type='forward'):
        if plan_type == 'backward':
            lag_hours = lag_hours * -1

        diff = timedelta(hours=lag_hours)
        return parent_date + diff

    def _scheduler_work_constrain(self, task_obj, vals, calendar_level, scheduling_type, t_params):
        """Override a task's link-derived schedule (``vals``) with its date
        constraint, per the precedence in auto_scheduling.md §4.3.

        ``constrain_type`` is a single exclusive value per task, so there is no
        multi-constraint conflict to arbitrate — the precedence is expressed
        directly by which branch fires:

          * MSO / MFO          → unconditional hard pin (start / end).
          * SNET / SNLT /
            FNET / FNLT        → pin only when the link-derived date *violates*
                                 the boundary (otherwise the link date stands).
          * ASAP / ALAP        → no constraint; the link-derived date is kept
                                 (skipped by the guard below).

        In every constrained case the constraint wins over the predecessor-link
        date already in ``vals`` (which itself already won over plain ASAP/ALAP).
        The branches are mutually exclusive (``elif``) to make that explicit.
        """
        if scheduling_type == "forward":
            cp_date_start = "soon_date_start"
            cp_date_end = "soon_date_end"
        elif scheduling_type == "backward":
            cp_date_start = "late_date_start"
            cp_date_end = "late_date_end"
        else:
            return vals, calendar_level

        constrain_type = task_obj["constrain_type"]
        constrain_date = task_obj["constrain_date"]

        if constrain_type and constrain_type not in ["asap", "alap"] and constrain_date and vals:
            direction = date_type = None

            # Hard pins (unconditional) — highest precedence.
            if constrain_type == "mso":
                direction = "normal"
                date_type = "date_start"
            elif constrain_type == "mfo":
                direction = "revers"
                date_type = "date_end"
            # Boundary constraints — pin only when the link date violates them.
            elif constrain_type == "fnet":
                if vals[cp_date_end] < constrain_date:
                    direction = "revers"
                    date_type = "date_end"
            elif constrain_type == "fnlt":
                if vals[cp_date_end] > constrain_date:
                    direction = "revers"
                    date_type = "date_end"
            elif constrain_type == "snet":
                if vals[cp_date_start] < constrain_date:
                    direction = "normal"
                    date_type = "date_start"
            elif constrain_type == "snlt":
                if vals[cp_date_start] > constrain_date:
                    direction = "normal"
                    date_type = "date_start"

            if direction and date_type:
                calendar_level_new, date_start, date_end = self._ap_calc_period(
                    task_obj=task_obj, direction=direction, new_date=constrain_date, date_type=date_type, t_params=t_params
                )

                if date_start and date_end:
                    vals[cp_date_start] = date_start
                    vals[cp_date_end] = date_end

                if calendar_level_new:
                    calendar_level = calendar_level_new

        return vals, calendar_level

