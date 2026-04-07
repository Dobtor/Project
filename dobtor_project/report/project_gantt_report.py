# -*- coding: utf-8 -*-
from collections import defaultdict
from datetime import datetime, time, timedelta

from odoo import api, fields, models, _
from odoo.exceptions import UserError

# Must match frontend PLANNING_T0 in gantt_model.js exactly
PLANNING_T0 = datetime(2000, 1, 1)

# Must match frontend GANTT_COLORS in gantt_inspector.js exactly
GANTT_COLORS = [
    "",          # 0: no color (white + border)
    "#ee2d2d",   # 1: Red
    "#dc8534",   # 2: Orange
    "#e8bb1d",   # 3: Yellow
    "#5794dd",   # 4: Cyan
    "#9f628f",   # 5: Purple
    "#db8865",   # 6: Almond
    "#41a9a2",   # 7: Teal
    "#304be0",   # 8: Blue
    "#ee2f8a",   # 9: Raspberry
    "#61c36e",   # 10: Green
    "#9872e6",   # 11: Violet
]

NO_COLOR_STYLE = "background:#fff;border:1.5px solid #999;"


class GanttReport(models.AbstractModel):
    _name = "report.dobtor_project.gantt_report"
    _description = "Gantt Chart Report"

    # ------------------------------------------------------------------
    # Shared: build children_map + root list matching frontend _buildTree
    #
    # Frontend loads records with order="date_start asc", then _buildTree
    # stable-sorts by sorting_seq.  For equal sorting_seq the original
    # date_start order is preserved.  We reproduce this by:
    #   1. Fetching tasks with order="date_start asc" (caller)
    #   2. Building children_map preserving that order
    #   3. Stable-sorting by sorting_seq
    # ------------------------------------------------------------------
    def _build_tree_maps(self, tasks, milestones):
        """Return (task_map, children_map, all_roots).

        children_map values are sorted by sorting_seq (stable, preserving
        the input order — which must be date_start asc — for ties).
        all_roots merges task roots + milestones sorted by sorting_seq.
        """
        task_map = {t.id: t for t in tasks}
        children_map = defaultdict(list)
        for task in tasks:
            parent_id = task.parent_id.id if task.parent_id else 0
            children_map[parent_id].append(task)
        for key in children_map:
            children_map[key].sort(key=lambda t: (t.sorting_seq or 0))

        task_roots = [
            t for t in tasks
            if not t.parent_id or t.parent_id.id not in task_map
        ]

        all_roots = []
        for t in task_roots:
            all_roots.append(('task', t, t.sorting_seq or 0))
        for m in milestones:
            all_roots.append(('milestone', m, m.sorting_seq or 0))
        all_roots.sort(key=lambda x: x[2])

        return task_map, children_map, all_roots

    # ------------------------------------------------------------------
    # WBS: matches frontend gantt_model.js _buildTree → computeTreeProps
    # ------------------------------------------------------------------
    def _compute_wbs(self, tasks, milestones):
        _task_map, children_map, all_roots = self._build_tree_maps(
            tasks, milestones
        )
        wbs_map = {}

        def _assign_children(parent_id, parent_wbs):
            for i, child in enumerate(children_map.get(parent_id, [])):
                wbs = f"{parent_wbs}.{i + 1}"
                wbs_map[child.id] = wbs
                _assign_children(child.id, wbs)

        for i, (kind, record, _seq) in enumerate(all_roots):
            wbs = str(i + 1)
            if kind == 'task':
                wbs_map[record.id] = wbs
                _assign_children(record.id, wbs)
            # Milestones occupy a slot but don't store WBS (they use M1, M2…)

        return wbs_map

    # ------------------------------------------------------------------
    # Display order + indent: DFS matching frontend _flattenTree
    #
    # Returns (kind, record, level) triples.  level is computed from the
    # tree structure (like frontend _indent), not from DB sorting_level.
    # ------------------------------------------------------------------
    def _build_display_order(self, tasks, milestones):
        _task_map, children_map, all_roots = self._build_tree_maps(
            tasks, milestones
        )
        result = []

        def _visit_task(task, level):
            result.append(('task', task, level))
            for child in children_map.get(task.id, []):
                _visit_task(child, level + 1)

        for kind, record, _seq in all_roots:
            if kind == 'task':
                _visit_task(record, 0)
            else:
                result.append(('milestone', record, 0))

        return result

    # ------------------------------------------------------------------
    # Effective dates
    # ------------------------------------------------------------------
    def _get_effective_dates(self, task):
        if task.child_ids:
            return (
                task.summary_date_start or task.date_start,
                task.summary_date_end or task.date_end,
            )
        return task.date_start, task.date_end

    # ------------------------------------------------------------------
    # Month markers
    # ------------------------------------------------------------------
    def _compute_month_markers(self, start_date, end_date, total_days):
        markers = []
        if total_days <= 0:
            return markers
        month = start_date.month + 1
        year = start_date.year
        if month > 12:
            month, year = 1, year + 1
        dt = start_date.replace(year=year, month=month, day=1)
        while dt <= end_date:
            left_pct = (dt - start_date).days / total_days * 100
            markers.append({'label': f"{dt.month}月", 'left_pct': round(left_pct, 2)})
            month = dt.month + 1
            year = dt.year
            if month > 12:
                month, year = 1, year + 1
            dt = dt.replace(year=year, month=month)
        return markers

    # ------------------------------------------------------------------
    # Bar color helper
    # ------------------------------------------------------------------
    def _get_color_css(self, color_index):
        """Return (background_css, is_no_color)."""
        idx = color_index or 0
        if 0 < idx < len(GANTT_COLORS) and GANTT_COLORS[idx]:
            return f"background:{GANTT_COLORS[idx]};", False
        return NO_COLOR_STYLE, True

    def _get_hex_color(self, color_index):
        """Return raw hex color for CSS border/triangle usage."""
        idx = color_index or 0
        if 0 < idx < len(GANTT_COLORS) and GANTT_COLORS[idx]:
            return GANTT_COLORS[idx]
        return "#999"

    # ------------------------------------------------------------------
    # Planning mode: virtual dates from plan_offset / plan_duration
    # ------------------------------------------------------------------
    def _compute_planning_virtual_dates(self, tasks, t0, scale_factor=1.0):
        """Compute virtual (ds, de) for every task in planning mode.

        Leaf tasks: ds = T0 + plan_offset * scale, de = ds + plan_duration * scale.
        Parent tasks: min(children ds), max(children de) — recursive DFS.
        scale_factor = 24 / hours_per_day — matches frontend _rescaleVirtualDates.
        Returns dict {task_id: (datetime, datetime) or (False, False)}.
        """
        task_map = {t.id: t for t in tasks}
        children_map = defaultdict(list)
        for task in tasks:
            pid = task.parent_id.id if task.parent_id else 0
            children_map[pid].append(task)

        result = {}

        def _compute(task):
            if task.id in result:
                return result[task.id]
            children = [c for c in children_map.get(task.id, [])
                        if c.id in task_map]
            if children:
                # Parent: aggregate from children
                min_ds, max_de = None, None
                for child in children:
                    cds, cde = _compute(child)
                    if cds and (min_ds is None or cds < min_ds):
                        min_ds = cds
                    if cde and (max_de is None or cde > max_de):
                        max_de = cde
                result[task.id] = (min_ds, max_de) if min_ds and max_de else (False, False)
            else:
                # Leaf task
                dur = task.plan_duration or 0
                if dur <= 0:
                    result[task.id] = (False, False)
                else:
                    offset = task.plan_offset or 0
                    ds = t0 + timedelta(hours=offset * scale_factor)
                    de = t0 + timedelta(hours=(offset + dur) * scale_factor)
                    result[task.id] = (ds, de)
            return result[task.id]

        for task in tasks:
            _compute(task)
        return result

    def _compute_planning_markers(self, start_date, end_date, total_days, t0_date):
        """Time-axis markers for planning mode using T+Xd labels."""
        markers = []
        if total_days <= 0:
            return markers
        # Choose interval based on total span
        if total_days <= 14:
            interval = 1
        elif total_days <= 60:
            interval = 7
        elif total_days <= 180:
            interval = 14
        else:
            interval = 30

        # Start from the nearest interval boundary after t0_date
        t0_offset = (start_date - t0_date).days
        first_mark = t0_offset - (t0_offset % interval) if t0_offset >= 0 else 0
        if first_mark < t0_offset:
            first_mark += interval

        day_offset = first_mark
        while True:
            mark_date = t0_date + timedelta(days=day_offset)
            if mark_date > end_date:
                break
            if mark_date >= start_date:
                left_pct = (mark_date - start_date).days / total_days * 100
                label = "T" if day_offset <= 0 else f"T+{day_offset}d"
                markers.append({'label': label, 'left_pct': round(left_pct, 2)})
            day_offset += interval
        return markers

    @staticmethod
    def _format_planning_day(dt_date, t0_date):
        """Format a date as 'T+Xd' relative to T0 (day granularity, for markers)."""
        off = (dt_date - t0_date).days
        return "T" if off <= 0 else f"T+{off}d"

    @staticmethod
    def _format_planning_label(dt, t0, scale_factor, hpd):
        """Format a virtual datetime as T+Xd with sub-day precision.

        Reverses scale_factor to get working hours, then divides by hpd
        to get working days — matches frontend _formatPlanningDay.
        """
        virtual_hours = (dt - t0).total_seconds() / 3600.0
        working_hours = virtual_hours / scale_factor if scale_factor else virtual_hours
        working_days = working_hours / hpd if hpd else 0
        if working_days < 0.001:
            return "T"
        if abs(working_days - round(working_days)) < 0.01:
            return f"T+{round(working_days)}d"
        return f"T+{working_days:.1f}d"

    def _planning_duration_label(self, task, is_parent, ds, de, project,
                                  scale_factor=1.0):
        """Duration label for planning mode tasks."""
        if is_parent:
            # Virtual dates are scaled; un-scale to get working hours
            hours = (de - ds).total_seconds() / 3600.0 / scale_factor
        else:
            hours = task.plan_duration or 0
        if hours <= 0:
            return "\u2014"
        if project.use_calendar and project.resource_calendar_id:
            hours_per_day = project.resource_calendar_id.hours_per_day or 8.0
        else:
            hours_per_day = 8.0  # Match frontend _calHpd planning default
        days = hours / hours_per_day
        return f"{int(days)}d" if days == int(days) else f"{days:.1f}d"

    # ------------------------------------------------------------------
    # Main
    # ------------------------------------------------------------------
    @api.model
    def _get_report_values(self, docids, data=None):
        project_id = data.get("project_id") if data else (docids[0] if docids else None)
        project = self.env["project.project"].browse(project_id).exists()
        if not project:
            raise UserError(_('找不到專案。'))
        is_planning = not project.schedule_start

        # Planning mode: sort by plan_offset; schedule mode: date_start asc
        # (matches the frontend's initial searchRead order).
        # _build_tree_maps then stable-sorts by sorting_seq.
        order = "plan_offset asc" if is_planning else "date_start asc"
        tasks = self.env["project.task"].search(
            [("project_id", "=", project.id)],
            order=order,
        )
        milestones = self.env["project.milestone"].search(
            [("project_id", "=", project.id)],
            order="sorting_seq asc",
        )

        # Scale factor: matches frontend _rescaleVirtualDates (24 / hpd)
        scale_factor = 1.0
        planning_hpd = 24.0
        if is_planning:
            if project.use_calendar and project.resource_calendar_id:
                planning_hpd = project.resource_calendar_id.hours_per_day or 8.0
            else:
                planning_hpd = 8.0  # Match frontend _calHpd default for planning mode
            if planning_hpd < 24:
                scale_factor = 24.0 / planning_hpd

        # Pre-compute virtual dates for planning mode
        virtual_dates = {}
        if is_planning:
            virtual_dates = self._compute_planning_virtual_dates(
                tasks, PLANNING_T0, scale_factor)
        t0_date = PLANNING_T0.date()  # date(2000, 1, 1)

        # Milestone effective position.
        # Scheduled mode: date objects.
        # Planning mode: datetime objects (sub-day precision for correct positioning).
        ms_effective_date = {}   # scheduled: {ms_id: date}
        ms_effective_dt = {}     # planning: {ms_id: datetime}
        for ms in milestones:
            if is_planning:
                linked = tasks.filtered(lambda t, m=ms: t.milestone_id.id == m.id)
                end_dts = []
                for t in linked:
                    vd = virtual_dates.get(t.id, (False, False))
                    if vd[1]:
                        end_dts.append(vd[1])
                if end_dts:
                    ms_effective_dt[ms.id] = max(end_dts)
            else:
                if ms.deadline:
                    ms_effective_date[ms.id] = ms.deadline
                else:
                    linked = tasks.filtered(lambda t, m=ms: t.milestone_id.id == m.id)
                    end_dates = [t.date_end for t in linked if t.date_end]
                    if end_dates:
                        max_dt = max(end_dates)
                        ms_effective_date[ms.id] = fields.Datetime.context_timestamp(
                            self, max_dt
                        ).date()

        wbs_map = self._compute_wbs(tasks, milestones)

        # Milestone numbering: M1, M2, ... per sorting_seq
        ms_number_map = {}
        for i, ms in enumerate(milestones):
            ms_number_map[ms.id] = f"M{i + 1}"

        # Collect range data
        if is_planning:
            # Planning mode: collect datetimes for sub-day positioning precision
            all_dts = []
            for task in tasks:
                vds, vde = virtual_dates.get(task.id, (False, False))
                if vds:
                    all_dts.append(vds)
                if vde:
                    all_dts.append(vde)
            for ms_dt in ms_effective_dt.values():
                all_dts.append(ms_dt)

            if all_dts:
                raw_start_dt = min(all_dts)
                raw_end_dt = max(all_dts)
            else:
                raw_start_dt = PLANNING_T0
                raw_end_dt = PLANNING_T0

            # Pad so bars at edges aren't clipped
            p_start_dt = raw_start_dt - timedelta(hours=24)
            p_end_dt = raw_end_dt + timedelta(hours=24)
            total_secs = (p_end_dt - p_start_dt).total_seconds() or 1

            # Date-based range still needed for T+Xd axis markers
            p_start_date = p_start_dt.date()
            p_end_date = p_end_dt.date()
            total_days = (p_end_date - p_start_date).days or 1
        else:
            # Scheduled mode: date objects (day granularity is fine)
            all_dates = []
            for task in tasks:
                ds, de = self._get_effective_dates(task)
                if ds:
                    all_dates.append(fields.Datetime.context_timestamp(self, ds).date())
                if de:
                    all_dates.append(fields.Datetime.context_timestamp(self, de).date())
            for ms_date in ms_effective_date.values():
                all_dates.append(ms_date)

            if all_dates:
                raw_start = min(all_dates)
                raw_end = max(all_dates)
            else:
                now_dt = fields.Datetime.now()
                raw_start = fields.Datetime.context_timestamp(self, now_dt).date()
                raw_end = raw_start

            p_start_date = raw_start - timedelta(days=1)
            p_end_date = raw_end + timedelta(days=1)
            total_days = (p_end_date - p_start_date).days or 1
            p_start_dt = None  # not used
            total_secs = 0     # not used

        # Build display order (DFS with milestones interleaved)
        display_order = self._build_display_order(tasks, milestones)

        rows_data = []
        for kind, record, level in display_order:
            if kind == 'milestone':
                ms = record
                left_pct = 0.0
                date_str = ""
                ms_upper = ""
                ms_lower = ""
                has_pos = False
                if is_planning:
                    ms_dt = ms_effective_dt.get(ms.id)
                    if ms_dt:
                        has_pos = True
                        date_str = self._format_planning_label(
                            ms_dt, PLANNING_T0, scale_factor, planning_hpd)
                        left_pct = round(
                            (ms_dt - p_start_dt).total_seconds()
                            / total_secs * 100, 2)
                else:
                    local_date = ms_effective_date.get(ms.id)
                    if local_date:
                        has_pos = True
                        date_str = local_date.strftime("%m/%d")
                        left_pct = round(
                            (local_date - p_start_date).days
                            / total_days * 100, 2)
                if has_pos:
                    _css, is_no = self._get_color_css(ms.color_gantt)
                    ms_color = "#ff9500" if is_no else self._get_hex_color(ms.color_gantt)
                    # Diamond: upper triangle (tip up) + lower triangle (tip down)
                    ms_upper = (
                        f"position:absolute;top:2px;left:{left_pct}%;"
                        f"margin-left:-5px;width:0px;height:0px;"
                        f"border-left:5px solid transparent;"
                        f"border-right:5px solid transparent;"
                        f"border-bottom:5px solid {ms_color};"
                    )
                    ms_lower = (
                        f"position:absolute;top:7px;left:{left_pct}%;"
                        f"margin-left:-5px;width:0px;height:0px;"
                        f"border-left:5px solid transparent;"
                        f"border-right:5px solid transparent;"
                        f"border-top:5px solid {ms_color};"
                    )
                rows_data.append({
                    'wbs': ms_number_map.get(ms.id, ""),
                    'name': ms.name,
                    'level': 0,
                    'start': date_str,
                    'end': date_str,
                    'duration_label': "\u2014",
                    'bar_style': '',
                    'ms_upper': ms_upper,
                    'ms_lower': ms_lower,
                    'is_parent': False,
                    'is_milestone': True,
                    'indent_px': 0,
                    'task_id': None,
                    'milestone_id': ms.id,
                    'left_pct': left_pct,
                    'end_pct': left_pct,
                    'dep_lines': [],
                })
            else:
                task = record
                if is_planning:
                    ds, de = virtual_dates.get(task.id, (False, False))
                else:
                    ds, de = self._get_effective_dates(task)
                left_pct = 0.0
                width_pct = 0.0
                start_str = ""
                end_str = ""
                duration_label = "\u2014"
                bar_style = ""
                left_cap = ""
                right_cap = ""
                is_parent = bool(task.child_ids)

                if ds and de:
                    if is_planning:
                        # Datetime precision — sub-day bars render correctly
                        start_str = self._format_planning_label(
                            ds, PLANNING_T0, scale_factor, planning_hpd)
                        end_str = self._format_planning_label(
                            de, PLANNING_T0, scale_factor, planning_hpd)
                        duration_label = self._planning_duration_label(
                            task, is_parent, ds, de, project, scale_factor
                        )
                        left_pct = round(
                            (ds - p_start_dt).total_seconds()
                            / total_secs * 100, 2)
                        raw_w = ((de - ds).total_seconds()
                                 / total_secs * 100)
                        width_pct = round(max(raw_w, 0.3), 2)
                    else:
                        local_start = fields.Datetime.context_timestamp(self, ds).date()
                        local_end = fields.Datetime.context_timestamp(self, de).date()
                        start_str = local_start.strftime("%m/%d")
                        end_str = local_end.strftime("%m/%d")

                        if is_parent:
                            span = (local_end - local_start).days
                            duration_label = f"{span}d" if span > 0 else "<1d"
                        elif project.use_calendar and project.resource_calendar_id:
                            hours_per_day = project.resource_calendar_id.hours_per_day or 8.0
                            working_hours = task.working_duration or task.duration
                            if working_hours and working_hours > 0:
                                days = working_hours / hours_per_day
                                duration_label = (
                                    f"{int(days)}d" if days == int(days) else f"{days:.1f}d"
                                )
                        elif task.duration and task.duration > 0:
                            days = task.duration / 24.0
                            duration_label = (
                                f"{int(days)}d" if days == int(days) else f"{days:.1f}d"
                            )

                        left_pct = round(
                            (local_start - p_start_date).days / total_days * 100, 2
                        )
                        raw_w = (local_end - local_start).days / total_days * 100
                        width_pct = round(max(raw_w, 0.5), 2)

                    color_css, is_no = self._get_color_css(task.color_gantt)
                    if is_parent:
                        cap_color = self._get_hex_color(task.color_gantt)
                        end_pct = round(left_pct + width_pct, 2)
                        bar_style = (
                            f"position:absolute;top:0;left:{left_pct}%;"
                            f"width:{width_pct}%;height:6px;"
                            f"{color_css}border-radius:0;"
                        )
                        left_cap = (
                            f"position:absolute;top:6px;left:{left_pct}%;"
                            f"width:0;height:0;"
                            f"border-left:4px solid transparent;"
                            f"border-right:4px solid transparent;"
                            f"border-top:4px solid {cap_color};"
                        )
                        right_cap = (
                            f"position:absolute;top:6px;left:{end_pct}%;"
                            f"margin-left:-8px;"
                            f"width:0;height:0;"
                            f"border-left:4px solid transparent;"
                            f"border-right:4px solid transparent;"
                            f"border-top:4px solid {cap_color};"
                        )
                    else:
                        bar_style = (
                            f"position:absolute;top:2px;left:{left_pct}%;"
                            f"width:{width_pct}%;height:10px;"
                            f"{color_css}border-radius:2px;"
                        )
                    if task.critical_path:
                        bar_style += "outline:2px solid #e74c3c;"

                rows_data.append({
                    'wbs': wbs_map.get(task.id, ""),
                    'name': task.name,
                    'level': level,
                    'start': start_str,
                    'end': end_str,
                    'duration_label': duration_label,
                    'bar_style': bar_style,
                    'is_parent': is_parent,
                    'is_milestone': False,
                    'indent_px': level * 12,
                    'task_id': task.id,
                    'left_pct': left_pct,
                    'end_pct': round(left_pct + width_pct, 2),
                    'left_cap': left_cap if is_parent else '',
                    'right_cap': right_cap if is_parent else '',
                })

        # ----------------------------------------------------------
        # Dependency lines: horizontal first, then vertical.
        # Arrow always points down (pred above) or up (pred below).
        #
        #   pred end ────┐  (horizontal at pred's row level)
        #                │  (vertical at successor's X)
        #                ↓  (arrow at successor's row)
        #            task start
        #
        # Row height: 14px gantt-wrap + 2px padding + 1px border = 17px
        # ----------------------------------------------------------
        ROW_HEIGHT = 17
        task_row_index = {}
        task_positions = {}
        for idx, row in enumerate(rows_data):
            tid = row.get('task_id')
            if tid:
                task_row_index[tid] = idx
                task_positions[tid] = (row.get('left_pct', 0), row.get('end_pct', 0))

        task_map = {t.id: t for t in tasks}
        for idx, row in enumerate(rows_data):
            dep_lines = []
            tid = row.get('task_id')
            if tid and tid in task_map:
                for pred in task_map[tid].predecessor_ids:
                    pid = pred.parent_task_id.id
                    if pid not in task_row_index:
                        continue
                    row_dist = idx - task_row_index[pid]
                    if row_dist == 0:
                        continue
                    pred_l, pred_r = task_positions.get(pid, (0, 0))
                    curr_l, curr_r = task_positions.get(tid, (0, 0))
                    if pred_l == 0 and pred_r == 0:
                        continue
                    if curr_l == 0 and curr_r == 0:
                        continue

                    link_type = pred.type or 'FS'
                    if link_type == 'FS':
                        from_pct, to_pct = pred_r, curr_l
                    elif link_type == 'SS':
                        from_pct, to_pct = pred_l, curr_l
                    elif link_type == 'FF':
                        from_pct, to_pct = pred_r, curr_r
                    elif link_type == 'SF':
                        from_pct, to_pct = pred_l, curr_r
                    else:
                        continue

                    vert_px = abs(row_dist) * ROW_HEIGHT
                    # pred_y: predecessor center relative to current gantt-wrap
                    pred_y = 7 - row_dist * ROW_HEIGHT

                    # Horizontal at predecessor's Y level
                    h_left = round(min(from_pct, to_pct), 2)
                    h_width = round(abs(to_pct - from_pct), 2)

                    # Vertical at successor's X, from pred_y to 7
                    v_x = round(to_pct, 2)
                    v_top = min(pred_y, 7)

                    # Arrow: always vertical (down or up)
                    if row_dist > 0:
                        # Predecessor above → arrow points DOWN
                        arrow_css = (
                            f"position:absolute;left:{v_x}%;top:2px;"
                            f"margin-left:-3px;width:0;height:0;"
                            f"border-left:3px solid transparent;"
                            f"border-right:3px solid transparent;"
                            f"border-top:5px solid #999;z-index:2;"
                        )
                    else:
                        # Predecessor below → arrow points UP
                        arrow_css = (
                            f"position:absolute;left:{v_x}%;top:7px;"
                            f"margin-left:-3px;width:0;height:0;"
                            f"border-left:3px solid transparent;"
                            f"border-right:3px solid transparent;"
                            f"border-bottom:5px solid #999;z-index:2;"
                        )
                    dep_lines.append({
                        'h_y': pred_y,
                        'h_left': h_left,
                        'h_width': h_width,
                        'v_x': v_x,
                        'v_top': v_top,
                        'v_height': vert_px,
                        'arrow_css': arrow_css,
                    })
            row['dep_lines'] = dep_lines

        # ----------------------------------------------------------
        # Milestone links: task.milestone_id → milestone (FS style).
        # Mirrors frontend _buildMilestoneLinks + _buildMilestonePaths.
        # Lines are drawn on the milestone's row.
        # ----------------------------------------------------------
        ms_row_map = {}  # milestone.id → row index
        for idx, row in enumerate(rows_data):
            mid = row.get('milestone_id')
            if mid:
                ms_row_map[mid] = idx

        for ms_id, ms_idx in ms_row_map.items():
            ms_row = rows_data[ms_idx]
            ms_x = ms_row.get('left_pct', 0)
            if not ms_x:
                continue
            linked = [t for t in tasks if t.milestone_id.id == ms_id]
            for task in linked:
                tid = task.id
                if tid not in task_row_index:
                    continue
                t_idx = task_row_index[tid]
                t_l, t_r = task_positions.get(tid, (0, 0))
                if t_l == 0 and t_r == 0:
                    continue
                row_dist = ms_idx - t_idx
                if row_dist == 0:
                    continue

                # FS: from task right edge to milestone diamond
                from_pct = t_r
                to_pct = ms_x

                vert_px = abs(row_dist) * ROW_HEIGHT
                task_y = 7 - row_dist * ROW_HEIGHT

                h_left = round(min(from_pct, to_pct), 2)
                h_width = round(abs(to_pct - from_pct), 2)
                v_x = round(to_pct, 2)
                v_top = min(task_y, 7)

                if row_dist > 0:
                    arrow_css = (
                        f"position:absolute;left:{v_x}%;top:2px;"
                        f"margin-left:-3px;width:0;height:0;"
                        f"border-left:3px solid transparent;"
                        f"border-right:3px solid transparent;"
                        f"border-top:5px solid #999;z-index:2;"
                    )
                else:
                    arrow_css = (
                        f"position:absolute;left:{v_x}%;top:7px;"
                        f"margin-left:-3px;width:0;height:0;"
                        f"border-left:3px solid transparent;"
                        f"border-right:3px solid transparent;"
                        f"border-bottom:5px solid #999;z-index:2;"
                    )

                ms_row['dep_lines'].append({
                    'h_y': task_y,
                    'h_left': h_left,
                    'h_width': h_width,
                    'v_x': v_x,
                    'v_top': v_top,
                    'v_height': vert_px,
                    'arrow_css': arrow_css,
                })

        if is_planning:
            month_markers = self._compute_planning_markers(
                p_start_date, p_end_date, total_days, t0_date
            )
            project_start_str = self._format_planning_label(
                raw_start_dt, PLANNING_T0, scale_factor, planning_hpd)
            project_end_str = self._format_planning_label(
                raw_end_dt, PLANNING_T0, scale_factor, planning_hpd)
        else:
            month_markers = self._compute_month_markers(p_start_date, p_end_date, total_days)
            project_start_str = p_start_date.strftime("%Y/%m/%d")
            project_end_str = p_end_date.strftime("%Y/%m/%d")

        now_tz = fields.Datetime.context_timestamp(self, fields.Datetime.now())

        return {
            "doc_ids": [project.id],
            "doc_model": "project.project",
            "docs": project,
            "project": project,
            "rows_data": rows_data,
            "month_markers": month_markers,
            "project_start_str": project_start_str,
            "project_end_str": project_end_str,
            "generated_str": now_tz.strftime("%Y-%m-%d %H:%M"),
        }
