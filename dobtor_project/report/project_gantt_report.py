# -*- coding: utf-8 -*-
from collections import defaultdict
from datetime import datetime, time, timedelta

from odoo import api, fields, models

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
    # Main
    # ------------------------------------------------------------------
    @api.model
    def _get_report_values(self, docids, data=None):
        project_id = data.get("project_id") if data else (docids[0] if docids else None)
        project = self.env["project.project"].browse(project_id)
        # order="date_start asc" matches the frontend's initial searchRead.
        # _build_tree_maps then stable-sorts by sorting_seq, so tasks with
        # equal sorting_seq keep their date_start order (same as frontend).
        tasks = self.env["project.task"].search(
            [("project_id", "=", project.id)],
            order="date_start asc",
        )
        milestones = self.env["project.milestone"].search(
            [("project_id", "=", project.id)],
            order="sorting_seq asc",
        )

        # Milestone effective date (local calendar date).
        # Mirrors frontend _computeMilestonePositions: for milestones without
        # deadline, use max(date_end) of tasks linked via milestone_id.
        ms_effective_date = {}
        for ms in milestones:
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

        # Collect all dates for project range
        all_starts, all_ends = [], []
        for task in tasks:
            ds, de = self._get_effective_dates(task)
            if ds:
                all_starts.append(ds)
            if de:
                all_ends.append(de)
        for ms in milestones:
            ms_date = ms_effective_date.get(ms.id)
            if ms_date:
                dt = datetime.combine(ms_date, time(12, 0))
                all_starts.append(dt)
                all_ends.append(dt)

        if all_starts and all_ends:
            p_start_dt = min(all_starts)
            p_end_dt = max(all_ends)
        else:
            p_start_dt = fields.Datetime.now()
            p_end_dt = fields.Datetime.now()

        p_start_date = fields.Datetime.context_timestamp(self, p_start_dt).date()
        p_end_date = fields.Datetime.context_timestamp(self, p_end_dt).date()
        # Pad date range so bars/milestones at the edges aren't clipped
        p_start_date -= timedelta(days=1)
        p_end_date += timedelta(days=1)
        total_days = (p_end_date - p_start_date).days or 1

        # Build display order (DFS with milestones interleaved)
        display_order = self._build_display_order(tasks, milestones)

        rows_data = []
        for kind, record, level in display_order:
            if kind == 'milestone':
                ms = record
                local_date = ms_effective_date.get(ms.id)
                left_pct = 0.0
                date_str = ""
                ms_upper = ""
                ms_lower = ""
                if local_date:
                    date_str = local_date.strftime("%m/%d")
                    left_pct = round(
                        (local_date - p_start_date).days / total_days * 100, 2
                    )
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
                ds, de = self._get_effective_dates(task)
                left_pct = 0.0
                width_pct = 0.0
                start_str = ""
                end_str = ""
                duration_label = "\u2014"
                bar_style = ""
                is_parent = bool(task.child_ids)

                if ds and de:
                    local_start = fields.Datetime.context_timestamp(self, ds).date()
                    local_end = fields.Datetime.context_timestamp(self, de).date()
                    start_str = local_start.strftime("%m/%d")
                    end_str = local_end.strftime("%m/%d")

                    if is_parent:
                        span = (local_end - local_start).days
                        duration_label = f"{span}d" if span > 0 else "<1d"
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

        month_markers = self._compute_month_markers(p_start_date, p_end_date, total_days)
        now_tz = fields.Datetime.context_timestamp(self, fields.Datetime.now())

        return {
            "doc_ids": [project.id],
            "doc_model": "project.project",
            "docs": project,
            "project": project,
            "rows_data": rows_data,
            "month_markers": month_markers,
            "project_start_str": p_start_date.strftime("%Y/%m/%d"),
            "project_end_str": p_end_date.strftime("%Y/%m/%d"),
            "generated_str": now_tz.strftime("%Y-%m-%d %H:%M"),
        }
