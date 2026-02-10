/** @odoo-module **/

import { Component, useState, useRef, onMounted } from "@odoo/owl";
import { useGanttGutter } from "./gantt_gutter_hook";
import { useGanttBarDrag } from "./gantt_bar_drag_hook";
import { useGanttBarResize } from "./gantt_bar_resize_hook";
import { useGanttDeadlineDrag } from "./gantt_deadline_drag_hook";
import { useGanttTreeDrag } from "./gantt_tree_drag_hook";
import { useGanttArrowDraw } from "./gantt_arrow_draw_hook";
import { useGanttProgressDrag } from "./gantt_progress_drag_hook";
import { GanttArrows } from "./gantt_arrows";
import { GanttTooltip } from "./gantt_tooltip";
import { GanttContextMenu } from "./gantt_context_menu";
import { GanttScrollMap } from "./gantt_scrollmap";
import { GanttInspector } from "./gantt_inspector";

const { DateTime } = luxon;

export class GanttRenderer extends Component {
    static template = "dobtor_project.GanttRenderer";
    static components = { GanttArrows, GanttTooltip, GanttContextMenu, GanttScrollMap, GanttInspector };

    static props = {
        model: Object,
        archInfo: Object,
        onRecordClick: Function,
        onAddTask: { type: Function, optional: true },
        onScrollToToday: { type: Function, optional: true },
        scale: String,
        weekType: { type: String, optional: true },
        sortMode: { type: String, optional: true },
        showListDetail: { type: Boolean, optional: true },
        showIntersection: { type: Boolean, optional: true },
        showViolationPanel: { type: Boolean, optional: true },
        violations: { type: Array, optional: true },
        onViolationClose: { type: Function, optional: true },
        onViolationTaskClick: { type: Function, optional: true },
        // Inspector (Phase 3A)
        showInspectorPanel: { type: Boolean, optional: true },
        inspectorRecordId: { type: Number, optional: true },
        onInspectorClose: { type: Function, optional: true },
        onInspectorFieldChange: { type: Function, optional: true },
        onInspectorOpen: { type: Function, optional: true },
        // Filter (Phase 3D)
        filterCriticalPath: { type: Boolean, optional: true },
        filterOverdue: { type: Boolean, optional: true },
        filterUnlinked: { type: Boolean, optional: true },
    };

    setup() {
        this.timelineRef = useRef("timeline");
        this.timelineDataRef = useRef("timelineData");
        this.listRowsRef = useRef("listRows");

        // Restore gutter width from localStorage
        const savedGutterWidth = parseInt(localStorage.getItem("gantt_gutter_width"), 10);

        this.state = useState({
            gutterWidth: (savedGutterWidth > 0) ? savedGutterWidth : 300,
            hoveredRowId: null,
            selectedRowId: null,
        });

        // Cell width per column unit for each scale
        this.cellWidths = {
            "1h": 60,      // px per 1-hour column
            "2h": 60,      // px per 2-hour column
            "4h": 60,      // px per 4-hour column
            "8h": 60,      // px per 8-hour column
            day: 40,        // px per day column
            week: 120,      // px per week column
            month: 180,     // px per month column
            quarter: 180,   // px per month-within-quarter column
        };

        // --- Hook: Gutter resize ---
        useGanttGutter(this.state, { min: 200, max: 500 });

        // --- Hook: Bar drag ---
        useGanttBarDrag({
            getTimelineEl: () => this.timelineDataRef.el,
            getCellWidth: () => this.cellWidth,
            getTimeStart: () => this.props.model.data?.timeStart,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            isSummary: (record) => record._hasChildren,
            onDragEnd: async (recordId, cellsDelta) => {
                const record = this.props.model.data?.records.find(r => r.id === recordId);
                if (!record) return;
                const dateStartField = this.props.archInfo.dateStart || "date_start";
                const dateStopField = this.props.archInfo.dateStop || "date_end";
                if (this._isFieldReadonly(dateStartField) || this._isFieldReadonly(dateStopField)) {
                    this.env.services.notification.add(
                        "Cannot modify: date field is read-only",
                        { type: "warning" }
                    );
                    return;
                }
                const shiftDur = this._cellsDeltaToDuration(cellsDelta);
                const values = {};
                if (record._dateStart) {
                    values[dateStartField] = record._dateStart.plus(shiftDur).toISO();
                }
                if (record._dateEnd) {
                    values[dateStopField] = record._dateEnd.plus(shiftDur).toISO();
                }
                await this.props.model.updateRecord(recordId, values);
            },
        });

        // --- Hook: Bar resize ---
        useGanttBarResize({
            getTimelineEl: () => this.timelineDataRef.el,
            getCellWidth: () => this.cellWidth,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            onResizeEnd: async (recordId, side, cellsDelta) => {
                const record = this.props.model.data?.records.find(r => r.id === recordId);
                if (!record) return;
                const dateStartField = this.props.archInfo.dateStart || "date_start";
                const dateStopField = this.props.archInfo.dateStop || "date_end";
                const checkField = side === "left" ? dateStartField : dateStopField;
                if (this._isFieldReadonly(checkField)) {
                    this.env.services.notification.add(
                        "Cannot modify: date field is read-only",
                        { type: "warning" }
                    );
                    return;
                }
                const shiftDur = this._cellsDeltaToDuration(cellsDelta);
                const values = {};
                if (side === "left" && record._dateStart) {
                    values[dateStartField] = record._dateStart.plus(shiftDur).toISO();
                } else if (side === "right" && record._dateEnd) {
                    values[dateStopField] = record._dateEnd.plus(shiftDur).toISO();
                }
                await this.props.model.updateRecord(recordId, values);
            },
            onConstraintSet: async (recordId, constrainType, constrainDate) => {
                const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
                const constrainDateField = this.props.archInfo.constrainDate || "constrain_date";
                await this.props.model.updateRecord(recordId, {
                    [constrainTypeField]: constrainType,
                    [constrainDateField]: constrainDate,
                });
            },
        });

        // --- Hook: Deadline drag ---
        useGanttDeadlineDrag({
            getTimelineEl: () => this.timelineDataRef.el,
            getCellWidth: () => this.cellWidth,
            getTimeStart: () => this.props.model.data?.timeStart,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            onDragEnd: async (recordId, cellsDelta) => {
                const record = this.props.model.data?.records.find(r => r.id === recordId);
                if (!record || !record._dateDeadline) return;
                const deadlineField = this.props.archInfo.dateDeadline;
                if (!deadlineField) return;
                if (this._isFieldReadonly(deadlineField)) {
                    this.env.services.notification.add(
                        "Cannot modify: deadline field is read-only",
                        { type: "warning" }
                    );
                    return;
                }
                const shiftDur = this._cellsDeltaToDuration(cellsDelta);
                const newDeadline = record._dateDeadline.plus(shiftDur);
                await this.props.model.updateRecord(recordId, {
                    [deadlineField]: newDeadline.toFormat("yyyy-MM-dd"),
                });
            },
        });

        // --- Hook: Tree drag-drop reordering ---
        useGanttTreeDrag({
            getListEl: () => this.listRowsRef.el,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            onReorder: async (recordId, targetId, position) => {
                const success = await this.props.model.reorderRecord(recordId, targetId, position);
                if (success) {
                    await this.props.model.load(this.props);
                }
            },
        });

        // --- Hook: Arrow draw (create/delete predecessor links) ---
        useGanttArrowDraw({
            getTimelineEl: () => this.timelineDataRef.el,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            onLinkCreated: async (fromId, toId, type) => {
                await this.props.model.createPredecessor(toId, fromId, type);
            },
            onLinkDeleted: async (predIdentifier) => {
                await this.props.model.deletePredecessor(predIdentifier);
            },
        });

        // --- Hook: Progress drag ---
        useGanttProgressDrag({
            getTimelineEl: () => this.timelineDataRef.el,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            onProgressEnd: async (recordId, newProgress) => {
                const progressField = this.props.archInfo.progress;
                if (!progressField) return;
                if (this._isFieldReadonly(progressField)) {
                    this.env.services.notification.add(
                        "Cannot modify: progress field is read-only",
                        { type: "warning" }
                    );
                    return;
                }
                await this.props.model.updateRecord(recordId, { [progressField]: newProgress });
            },
        });

        // Inline rename state
        this._editingRecordId = null;

        // Scrollmap state
        this._scrollState = useState({
            scrollLeft: 0,
            scrollTop: 0,
            viewportWidth: 0,
            viewportHeight: 0,
            totalHeight: 0,
        });

        onMounted(() => {
            this._syncScroll();
            this._initScrollTracking();
        });
    }

    _syncScroll() {
        // Sync vertical scroll between list and timeline
        const timeline = this.timelineRef.el;
        const listRows = this.listRowsRef.el;

        if (timeline && listRows) {
            timeline.addEventListener("scroll", () => {
                listRows.scrollTop = timeline.scrollTop;
            });
            listRows.addEventListener("scroll", () => {
                timeline.scrollTop = listRows.scrollTop;
            });
        }
    }

    _initScrollTracking() {
        const timeline = this.timelineRef.el;
        if (!timeline) return;

        const updateScroll = () => {
            this._scrollState.scrollLeft = timeline.scrollLeft;
            this._scrollState.scrollTop = timeline.scrollTop;
            this._scrollState.viewportWidth = timeline.clientWidth;
            this._scrollState.viewportHeight = timeline.clientHeight;
            this._scrollState.totalHeight = timeline.scrollHeight;
        };

        timeline.addEventListener("scroll", updateScroll);
        updateScroll();

        // Also observe resize
        if (typeof ResizeObserver !== "undefined") {
            const ro = new ResizeObserver(updateScroll);
            ro.observe(timeline);
        }
    }

    get cellWidth() {
        return this.cellWidths[this.props.scale] || 40;
    }

    get timelineColumns() {
        const data = this.props.model.data;
        if (!data?.timeStart || !data?.timeEnd) {
            // Default: show current month
            const now = DateTime.now();
            const start = now.startOf("month");
            const end = now.endOf("month");
            return this._generateColumns(start, end);
        }
        return this._generateColumns(data.timeStart, data.timeEnd);
    }

    _generateColumns(start, end) {
        const columns = [];
        const scale = this.props.scale;
        const now = DateTime.now();

        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            const hours = parseInt(scale);
            let current = start.startOf("hour");
            // Align to hour boundary
            const h = current.hour;
            current = current.set({ hour: h - (h % hours) });
            while (current <= end) {
                columns.push({
                    date: current,
                    label: current.toFormat("HH:mm"),
                    weekday: current.toFormat("EEE d"),
                    month: current.toFormat("MMM d, yyyy"),
                    isWeekend: current.weekday === 6 || current.weekday === 7,
                    isToday: current.hasSame(now, "hour") ||
                        (now >= current && now < current.plus({ hours })),
                });
                current = current.plus({ hours });
            }
        } else if (scale === "day") {
            const weekType = this.props.weekType || "iso";
            let current = start.startOf("day");
            while (current <= end) {
                // Luxon weekday: 1=Mon..7=Sun
                // ISO weekend: Sat(6)+Sun(7); US weekend: Sat(6)+Sun(7) is the same
                // but for US, Sunday is first day of week (visual only, weekend unchanged)
                const isWeekend = current.weekday === 6 || current.weekday === 7;
                columns.push({
                    date: current,
                    label: current.toFormat("d"),
                    weekday: current.toFormat("EEE"),
                    month: current.toFormat("MMM yyyy"),
                    isWeekend,
                    isToday: current.hasSame(now, "day"),
                });
                current = current.plus({ days: 1 });
            }
        } else if (scale === "week") {
            const weekType = this.props.weekType || "iso";
            // For US weeks (Sun start), shift to Sunday; for ISO (Mon start) use default
            if (weekType === "us") {
                // Luxon .startOf("week") always gives Monday (ISO).
                // For US Sunday-start: go to Monday then subtract 1 day.
                let current = start.startOf("week").minus({ days: 1 });
                if (current > start) current = current.minus({ weeks: 1 });
                while (current <= end) {
                    const weekEnd = current.plus({ days: 6 });
                    columns.push({
                        date: current,
                        label: `W${current.plus({ days: 1 }).weekNumber}`,
                        weekday: `${current.toFormat("d MMM")} - ${weekEnd.toFormat("d MMM")}`,
                        month: current.toFormat("MMM yyyy"),
                        isWeekend: false,
                        isToday: now >= current && now <= weekEnd,
                    });
                    current = current.plus({ weeks: 1 });
                }
            } else {
                let current = start.startOf("week");
                while (current <= end) {
                    const weekEnd = current.endOf("week");
                    columns.push({
                        date: current,
                        label: `W${current.weekNumber}`,
                        weekday: `${current.toFormat("d MMM")} - ${weekEnd.toFormat("d MMM")}`,
                        month: current.toFormat("MMM yyyy"),
                        isWeekend: false,
                        isToday: now >= current && now <= weekEnd,
                    });
                    current = current.plus({ weeks: 1 });
                }
            }
        } else if (scale === "month") {
            let current = start.startOf("month");
            while (current <= end) {
                columns.push({
                    date: current,
                    label: current.toFormat("MMM"),
                    weekday: current.toFormat("yyyy"),
                    month: current.toFormat("yyyy"),
                    isWeekend: false,
                    isToday: current.hasSame(now, "month"),
                });
                current = current.plus({ months: 1 });
            }
        } else if (scale === "quarter") {
            let current = start.startOf("month");
            while (current <= end) {
                const q = Math.ceil(current.month / 3);
                columns.push({
                    date: current,
                    label: current.toFormat("MMM"),
                    weekday: `Q${q}`,
                    month: `Q${q} ${current.toFormat("yyyy")}`,
                    isWeekend: false,
                    isToday: current.hasSame(now, "month"),
                });
                current = current.plus({ months: 1 });
            }
        }

        return columns;
    }

    /**
     * Convert a cell count delta to a Luxon Duration based on current scale.
     */
    _cellsDeltaToDuration(cellsDelta) {
        const scale = this.props.scale;
        if (scale === "1h") return { hours: cellsDelta };
        if (scale === "2h") return { hours: cellsDelta * 2 };
        if (scale === "4h") return { hours: cellsDelta * 4 };
        if (scale === "8h") return { hours: cellsDelta * 8 };
        if (scale === "week") return { weeks: cellsDelta };
        if (scale === "month" || scale === "quarter") return { months: cellsDelta };
        return { days: cellsDelta }; // default: day
    }

    /**
     * Convert a DateTime to pixel position relative to timeline start.
     * Uses uniform px/ms for sub-day scales, px/day for day and above.
     */
    _dateToPx(dt) {
        const data = this.props.model.data;
        if (!data?.timeStart || !dt) return 0;

        const scale = this.props.scale;
        const cw = this.cellWidth;
        const start = data.timeStart;

        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            const hours = parseInt(scale);
            const msPerCol = hours * 3600 * 1000;
            const diffMs = dt.toMillis() - start.toMillis();
            return (diffMs / msPerCol) * cw;
        }
        // Day and above: use days diff
        return dt.diff(start, "days").days * cw;
    }

    /**
     * Returns the pixel width of exactly one day at the current scale.
     * Used by load bars to ensure consistent daily-width rendering.
     */
    _getDayWidth() {
        const scale = this.props.scale;
        const cw = this.cellWidth;
        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            const hoursPerCell = parseInt(scale);
            return (24 / hoursPerCell) * cw;
        }
        if (scale === "day") return cw;
        if (scale === "week") return cw / 7;
        // month / quarter: approximate — cellWidth is per-month
        if (scale === "month" || scale === "quarter") return cw / 30;
        return cw;
    }

    get groupedMonths() {
        const columns = this.timelineColumns;
        const grouped = [];
        let currentMonth = null;
        let currentGroup = null;

        for (const col of columns) {
            if (col.month !== currentMonth) {
                currentMonth = col.month;
                currentGroup = { label: col.month, span: 1 };
                grouped.push(currentGroup);
            } else {
                currentGroup.span++;
            }
        }

        return grouped;
    }

    get flattenedRows() {
        const rows = [];
        const groups = this.props.model.data?.groups || [];

        for (const group of groups) {
            rows.push(group);
            if (!group.fold) {
                // Use tree-ordered records if available, otherwise fall back to flat
                const records = group._treeRecords || group.records || [];
                for (const record of records) {
                    rows.push(record);
                }
            }
        }

        return rows;
    }

    get timelineWidth() {
        return this.timelineColumns.length * this.cellWidth;
    }

    get todayPosition() {
        const data = this.props.model.data;
        if (!data?.timeStart) return null;

        const today = DateTime.now();
        if (today < data.timeStart || today > data.timeEnd) return null;

        return this._dateToPx(today);
    }

    // -------------------------------------------------------------------------
    // Arrow component props
    // -------------------------------------------------------------------------

    get arrowProps() {
        const data = this.props.model.data;
        return {
            predecessors: data?.predecessors || [],
            records: data?.records || [],
            flattenedRows: this.flattenedRows,
            timeStart: data?.timeStart,
            cellWidth: this.cellWidth,
            rowHeight: 44,
            selectedRowId: this.state.selectedRowId,
            criticalField: this.props.archInfo.criticalPath || "",
        };
    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------

    onGroupClick(group) {
        if (this.props.model.toggleGroup) {
            this.props.model.toggleGroup(group.id);
        }
    }

    onRecordClick(record) {
        this.state.selectedRowId = record.id;
        this.props.onRecordClick(record);
    }

    onBarClick(record) {
        this.state.selectedRowId = record.id;
        if (this.props.onInspectorOpen) {
            this.props.onInspectorOpen(record.id);
        }
    }

    onTaskSelect(record) {
        this.state.selectedRowId = record.id;
    }

    onTaskFoldClick(record) {
        if (this.props.model.toggleTaskFold) {
            this.props.model.toggleTaskFold(record.id);
        }
    }

    onRowHover(rowId) {
        this.state.hoveredRowId = rowId;
    }

    onRowLeave() {
        this.state.hoveredRowId = null;
    }

    // -------------------------------------------------------------------------
    // Inline rename (double-click)
    // -------------------------------------------------------------------------

    onTaskDblClick(record, ev) {
        const nameEl = ev.target.closest(".o_gantt_task_name");
        if (!nameEl) return;

        ev.stopPropagation();
        this._editingRecordId = record.id;

        // Create contenteditable input
        const origText = record.display_name || "";
        nameEl.setAttribute("contenteditable", "true");
        nameEl.classList.add("o_gantt_inline_editing");
        nameEl.textContent = origText;
        nameEl.focus();

        // Select all text
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        sel.removeAllRanges();
        sel.addRange(range);

        const finishEdit = async () => {
            nameEl.removeAttribute("contenteditable");
            nameEl.classList.remove("o_gantt_inline_editing");
            nameEl.removeEventListener("blur", onBlur);
            nameEl.removeEventListener("keydown", onKeyDown);

            const newText = nameEl.textContent.trim();
            this._editingRecordId = null;

            if (newText && newText !== origText) {
                await this.props.model.renameRecord(record.id, newText);
            } else {
                nameEl.textContent = origText;
            }
        };

        const onBlur = () => finishEdit();
        const onKeyDown = (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                nameEl.blur();
            } else if (e.key === "Escape") {
                nameEl.textContent = origText;
                nameEl.blur();
            }
        };

        nameEl.addEventListener("blur", onBlur, { once: true });
        nameEl.addEventListener("keydown", onKeyDown);
    }

    // -------------------------------------------------------------------------
    // Add subtask from tree
    // -------------------------------------------------------------------------

    async onAddSubtask(parentRecord) {
        const parentField = this.props.archInfo.parentId || "parent_id";
        const groupField = this.props.archInfo.mainGroupIdName || "project_id";

        const projectVal = parentRecord[groupField];
        const projectId = Array.isArray(projectVal) ? projectVal[0] : projectVal;

        const defaults = {
            [`default_${parentField}`]: parentRecord.id,
        };
        if (projectId) {
            defaults[`default_${groupField}`] = projectId;
        }

        if (this.props.onAddTask) {
            this.props.onAddTask(defaults);
        }
    }

    onAddTaskToGroup(group) {
        const groupField = this.props.archInfo.mainGroupIdName || "project_id";
        const defaults = {
            [`default_${groupField}`]: group.id,
        };

        if (this.props.onAddTask) {
            this.props.onAddTask(defaults);
        }
    }

    // -------------------------------------------------------------------------
    // Ghost/Baseline bars
    // -------------------------------------------------------------------------

    getGhostBars(record) {
        const ghostBars = this.props.model.data?.ghostBars || [];
        return ghostBars.filter(gb => gb.taskId === record.id);
    }

    getGhostBarStyle(ghostBar) {
        const data = this.props.model.data;
        if (!data?.timeStart || !ghostBar.dateStart) return "display: none;";

        const left = this._dateToPx(ghostBar.dateStart);
        let width = 20;
        if (ghostBar.dateEnd) {
            const right = this._dateToPx(ghostBar.dateEnd);
            width = Math.max(right - left, 4);
        }
        return `left: ${left}px; width: ${width}px;`;
    }

    // -------------------------------------------------------------------------
    // Resource intersection highlighting
    // -------------------------------------------------------------------------

    getResourceIntersections(record) {
        const resourceField = this.props.archInfo.resourceField;
        if (!resourceField) return [];

        const resourceVal = record[resourceField];
        if (!resourceVal) return [];
        const resourceId = Array.isArray(resourceVal) ? resourceVal[0] : resourceVal;
        if (!resourceId || !record._dateStart || !record._dateEnd) return [];

        // Find all other records that share same resource and overlap in time
        const records = this.props.model.data?.records || [];
        const conflicts = [];

        for (const other of records) {
            if (other.id === record.id) continue;
            const otherRes = other[resourceField];
            const otherId = Array.isArray(otherRes) ? otherRes[0] : otherRes;
            if (otherId !== resourceId) continue;
            if (!other._dateStart || !other._dateEnd) continue;

            // Check time overlap
            if (record._dateStart < other._dateEnd && record._dateEnd > other._dateStart) {
                conflicts.push(other);
            }
        }

        return conflicts;
    }

    hasResourceConflict(record) {
        return this.getResourceIntersections(record).length > 0;
    }

    // -------------------------------------------------------------------------
    // Scrollmap props
    // -------------------------------------------------------------------------

    get scrollMapProps() {
        return {
            timelineWidth: this.timelineWidth,
            viewportWidth: this._scrollState.viewportWidth || 800,
            scrollLeft: this._scrollState.scrollLeft || 0,
            rowCount: this.flattenedRows.length,
            viewportHeight: this._scrollState.viewportHeight || 400,
            scrollTop: this._scrollState.scrollTop || 0,
            totalHeight: this._scrollState.totalHeight || 400,
            todayPosition: this.todayPosition,
            onScroll: (left, top) => {
                const timeline = this.timelineRef.el;
                if (timeline) {
                    timeline.scrollLeft = left;
                    timeline.scrollTop = top;
                }
            },
        };
    }

    // -------------------------------------------------------------------------
    // Inspector computed props (Phase 3A)
    // -------------------------------------------------------------------------

    get inspectorRecord() {
        if (!this.props.inspectorRecordId) return null;
        return this.props.model.data?.records?.find(r => r.id === this.props.inspectorRecordId) || null;
    }

    get inspectorPredecessors() {
        if (!this.props.inspectorRecordId) return [];
        return (this.props.model.data?.predecessors || []).filter(p =>
            p.task_id === this.props.inspectorRecordId || p.parent_task_id === this.props.inspectorRecordId
        );
    }

    async onInspectorFieldChange(recordId, fieldName, newValue) {
        if (this.props.onInspectorFieldChange) {
            await this.props.onInspectorFieldChange(recordId, fieldName, newValue);
        }
    }

    // -------------------------------------------------------------------------
    // Filter logic (Phase 3D)
    // -------------------------------------------------------------------------

    isRowFiltered(record) {
        const any = this.props.filterCriticalPath || this.props.filterOverdue || this.props.filterUnlinked;
        if (!any) return false;
        let matches = false;
        if (this.props.filterCriticalPath) {
            const f = this.props.archInfo.criticalPath;
            if (f && record[f]) matches = true;
        }
        if (this.props.filterOverdue) {
            const now = DateTime.now();
            if (record._dateEnd && record._dateDeadline && record._dateEnd > record._dateDeadline) matches = true;
            if (record._dateEnd && record._dateEnd < now && (record._progress || 0) < 100) matches = true;
        }
        if (this.props.filterUnlinked) {
            const preds = this.props.model.data?.predecessors || [];
            const hasLink = preds.some(p => p.task_id === record.id || p.parent_task_id === record.id);
            if (!hasLink && record._scheduleMode === "auto") matches = true;
        }
        return !matches; // true = should be dimmed
    }

    async onContextAction(recordId, action) {
        const model = this.props.model;
        const scheduleModeField = this.props.archInfo.scheduleMode || "schedule_mode";

        switch (action) {
            case "open":
                this.props.onRecordClick({ id: recordId });
                break;
            case "set_auto":
                await model.updateRecord(recordId, { [scheduleModeField]: "auto" });
                break;
            case "set_manual":
                await model.updateRecord(recordId, { [scheduleModeField]: "manual" });
                break;
            case "fold":
            case "unfold":
                if (model.toggleTaskFold) {
                    model.toggleTaskFold(recordId);
                }
                break;
            case "add_subtask": {
                const record = model.data?.records?.find(r => r.id === recordId);
                if (record) {
                    this.onAddSubtask(record);
                }
                break;
            }
            case "remove_constraint": {
                const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
                const constrainDateField = this.props.archInfo.constrainDate || "constrain_date";
                await model.updateRecord(recordId, {
                    [constrainTypeField]: "asap",
                    [constrainDateField]: false,
                });
                break;
            }
            case "detail_plan":
                this.props.onRecordClick({ id: recordId, action: "detail_plan" });
                break;
            case "delete":
                this.props.onRecordClick({ id: recordId, action: "delete" });
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Class / Style helpers
    // -------------------------------------------------------------------------

    getRowClass(row) {
        const classes = ["o_gantt_list_row", "p-2", "border-bottom"];
        if (row._isGroup) {
            classes.push("o_gantt_group_row");
        }
        if (this.state.hoveredRowId === row.id) {
            classes.push("o_gantt_row_hover");
        }
        if (this.state.selectedRowId === row.id) {
            classes.push("o_gantt_selected");
        }
        return classes.join(" ");
    }

    getTimelineRowClass(row) {
        const classes = ["o_gantt_timeline_row"];
        if (row._isGroup) {
            classes.push("o_gantt_group_row");
        }
        if (this.state.hoveredRowId === row.id) {
            classes.push("o_gantt_row_hover");
        }
        if (!row._isGroup && this.state.selectedRowId === row.id) {
            classes.push("o_gantt_row_selected");
        }
        return classes.join(" ");
    }

    getBarStyle(record) {
        const data = this.props.model.data;
        if (!data?.timeStart) {
            return "display: none;";
        }

        // Use summary dates for parent tasks if available
        let dateStart = record._dateStart;
        let dateEnd = record._dateEnd;

        if (record._hasChildren) {
            dateStart = record._summaryDateStart || dateStart;
            dateEnd = record._summaryDateEnd || dateEnd;
        }

        if (!dateStart) {
            return "display: none;";
        }

        const left = this._dateToPx(dateStart);

        let width;
        if (dateEnd) {
            const right = this._dateToPx(dateEnd);
            width = Math.max(right - left, 20);
        } else {
            width = 50;
        }

        return `left: ${left}px; width: ${width}px;`;
    }

    getBarClass(record) {
        const classes = ["o_gantt_bar"];

        if (record._isMilestone) {
            classes.push("o_gantt_milestone");
        }

        // Summary/parent bar
        if (record._hasChildren) {
            classes.push("o_gantt_summary");
        }

        // Schedule mode color classes
        const mode = record._scheduleMode;
        if (mode === "auto") {
            const constrainField = this.props.archInfo.constrainType;
            const constrainType = constrainField ? record[constrainField] : "";
            if (constrainType && constrainType !== "asap" && constrainType !== "alap") {
                classes.push("o_gantt_bar_auto_constrained");
            } else {
                classes.push("o_gantt_bar_auto");
            }
        } else {
            classes.push("o_gantt_bar_manual");
        }

        // Critical path
        const criticalField = this.props.archInfo.criticalPath;
        if (criticalField && record[criticalField]) {
            classes.push("o_gantt_critical_path");
        }

        if (this.state.selectedRowId === record.id) {
            classes.push("o_gantt_selected");
        }

        // Phase 3D: Filter dimming
        if (this.isRowFiltered(record)) {
            classes.push("o_gantt_bar_filtered");
        }

        return classes.join(" ");
    }

    getBarCustomStyle(record) {
        // Custom color from color_gantt field (RGBA string)
        const colorSetField = this.props.archInfo.colorGanttSet;
        const colorField = this.props.archInfo.colorGantt;

        if (colorSetField && colorField && record[colorSetField] && record[colorField]) {
            return `background: ${record[colorField]};`;
        }
        return "";
    }

    getIndentStyle(record) {
        const indent = record._indent || 0;
        return `width: ${indent * 20}px;`;
    }

    getCellClass(column) {
        const classes = ["o_gantt_timeline_header_cell"];
        if (column.isWeekend) {
            classes.push("o_gantt_weekend");
        }
        if (column.isToday) {
            classes.push("o_gantt_today");
        }
        return classes.join(" ");
    }

    formatDateRange(record) {
        const start = record._dateStart;
        const end = record._dateEnd;

        if (!start) return "";

        const startStr = start.toFormat("MMM d");
        if (!end) return startStr;

        const endStr = end.toFormat("MMM d");
        return `${startStr} - ${endStr}`;
    }

    // -------------------------------------------------------------------------
    // Read-only field check
    // -------------------------------------------------------------------------

    _isFieldReadonly(fieldName) {
        const fieldDef = this.props.model.fields?.[fieldName];
        return fieldDef?.readonly === true;
    }

    // -------------------------------------------------------------------------
    // Deadline helpers
    // -------------------------------------------------------------------------

    hasDeadline(record) {
        return !!record._dateDeadline;
    }

    getDeadlineStyle(record) {
        const data = this.props.model.data;
        if (!data?.timeStart || !record._dateDeadline) return "display: none;";

        const left = this._dateToPx(record._dateDeadline);
        return `left: ${left}px;`;
    }

    getDeadlineClass(record) {
        const classes = ["o_gantt_deadline_marker"];
        // Overdue: end date past deadline
        if (record._dateEnd && record._dateEnd > record._dateDeadline) {
            classes.push("o_gantt_deadline_overdue");
        }
        return classes.join(" ");
    }

    formatDeadline(record) {
        if (!record._dateDeadline) return "";
        return record._dateDeadline.toFormat("MMM d, yyyy");
    }

    getDeadlineLagInfo(record) {
        if (!record._dateDeadline || !record._dateEnd) return null;
        const lagDays = record._dateDeadline.diff(record._dateEnd, "days").days;
        if (Math.abs(lagDays) < 0.1) return null;
        const overdue = lagDays < 0;
        const endPx = this._dateToPx(record._dateEnd);
        const deadlinePx = this._dateToPx(record._dateDeadline);
        const left = Math.min(endPx, deadlinePx);
        const width = Math.max(Math.abs(deadlinePx - endPx), 2);
        const label = overdue
            ? `-${Math.round(Math.abs(lagDays))}d`
            : `+${Math.round(lagDays)}d`;
        return { left, width, overdue, label };
    }

    // -------------------------------------------------------------------------
    // Load bar helpers
    // -------------------------------------------------------------------------

    getLoadBars(record) {
        const loadBars = this.props.model.data?.loadBars || [];
        return loadBars.filter(lb => lb.taskId === record.id);
    }

    // -------------------------------------------------------------------------
    // Loop / Doc count / Done marker / Task Info helpers
    // -------------------------------------------------------------------------

    hasLoop(record) {
        const pLoopField = this.props.archInfo.pLoop;
        return pLoopField && record[pLoopField];
    }

    getDocCount(record) {
        const docField = this.props.archInfo.docCount;
        if (!docField) return 0;
        const val = record[docField];
        // doc_count could be a number or an array (One2many ids)
        if (Array.isArray(val)) return val.length;
        return val || 0;
    }

    hasPlanAction(record) {
        const field = this.props.archInfo.planAction;
        return field && record[field];
    }

    getDoneMarkerStyle(record) {
        const data = this.props.model.data;
        if (!data?.timeStart || !record._dateDone) return "display: none;";
        const left = this._dateToPx(record._dateDone);
        return `left: ${left}px;`;
    }

    getTaskInfos(record) {
        const infoMap = this.props.model.data?.taskInfos;
        if (!infoMap || !(infoMap instanceof Map)) return [];
        return infoMap.get(record.id) || [];
    }

    // -------------------------------------------------------------------------
    // Focus / Scroll to bar
    // -------------------------------------------------------------------------

    onFocusClick(record) {
        if (!record._dateStart) return;

        const timeline = this.timelineRef.el;
        if (!timeline) return;

        // Horizontal scroll: center the bar's start position
        const barLeft = this._dateToPx(record._dateStart);
        const timelineWidth = timeline.clientWidth;
        timeline.scrollLeft = barLeft - timelineWidth / 2;

        // Vertical scroll: find the row in the timeline
        const timelineData = this.timelineDataRef.el;
        if (!timelineData) return;

        const barEl = timelineData.querySelector(`[data-record-id="${record.id}"]`);
        if (barEl) {
            const rowEl = barEl.closest(".o_gantt_timeline_row");
            if (rowEl) {
                const rowTop = rowEl.offsetTop;
                const viewportHeight = timeline.clientHeight;
                timeline.scrollTop = rowTop - viewportHeight / 2;
            }
        }

        // Briefly highlight the bar
        this.state.selectedRowId = record.id;
    }

    // -------------------------------------------------------------------------
    // Info column helpers (duration + date range)
    // -------------------------------------------------------------------------

    getInfoDuration(record) {
        if (!record._dateStart || !record._dateEnd) return "";
        const days = record._dateEnd.diff(record._dateStart, "days").days;
        return this._humanizeDuration(days);
    }

    getInfoDateRange(record) {
        if (!record._dateStart) return "";
        const start = record._dateStart.toFormat("M/d");
        if (!record._dateEnd) return start;
        const end = record._dateEnd.toFormat("M/d");
        return `${start}-${end}`;
    }

    getInfoStartDate(record) {
        if (!record._dateStart) return "";
        return record._dateStart.toFormat("M/d");
    }

    getInfoEndDate(record) {
        if (!record._dateEnd) return "";
        return record._dateEnd.toFormat("M/d");
    }

    _humanizeDuration(days) {
        if (days <= 0) return "0d";
        if (days < 1) {
            const hours = Math.round(days * 24);
            return `${hours}h`;
        }
        if (days < 7) {
            return `${Math.round(days * 10) / 10}d`;
        }
        if (days < 30) {
            const weeks = Math.floor(days / 7);
            const remain = Math.round(days % 7);
            return remain > 0 ? `${weeks}w${remain}d` : `${weeks}w`;
        }
        const months = Math.floor(days / 30);
        const remainDays = Math.round(days % 30);
        return remainDays > 0 ? `${months}m${remainDays}d` : `${months}m`;
    }

    getLoadBarStyle(loadBar) {
        if (!loadBar.dateStart) return "display: none;";

        const left = this._dateToPx(loadBar.dateStart);
        let width = 20;
        if (loadBar.dateEnd) {
            const right = this._dateToPx(loadBar.dateEnd);
            width = Math.max(right - left, 4);
        }

        let bg = "";
        if (loadBar.colorSet && loadBar.color) {
            bg = `background: ${loadBar.color};`;
        }

        return `left: ${left}px; width: ${width}px; ${bg}`;
    }

    // -------------------------------------------------------------------------
    // Round 3 Feature 13: Column header hints
    // -------------------------------------------------------------------------

    getColumnHint(column) {
        const scale = this.props.scale;
        if (scale === "day") {
            return column.date.toFormat("EEEE, MMMM d, yyyy");
        }
        if (scale === "week") {
            const end = column.date.endOf("week");
            return `${column.date.toFormat("MMM d")} - ${end.toFormat("MMM d, yyyy")}`;
        }
        if (scale === "month" || scale === "quarter") {
            return column.date.toFormat("MMMM yyyy");
        }
        // Sub-day scales
        return column.date.toFormat("EEE, MMM d  HH:mm");
    }

    // -------------------------------------------------------------------------
    // Round 3 Feature 15: Project bar indicators
    // -------------------------------------------------------------------------

    getGroupProgress(group) {
        if (!group.records || group.records.length === 0) return 0;
        let total = 0;
        let count = 0;
        for (const record of group.records) {
            if (record._progress != null) {
                total += record._progress;
                count++;
            }
        }
        return count > 0 ? Math.round(total / count) : 0;
    }

    getGroupProgressStyle(group) {
        const progress = this.getGroupProgress(group);
        return `width: ${Math.min(progress, 100)}%;`;
    }

    getGroupDateRange(group) {
        if (!group.records || group.records.length === 0) return "";
        let minDate = null;
        let maxDate = null;
        for (const record of group.records) {
            if (record._dateStart && (!minDate || record._dateStart < minDate)) {
                minDate = record._dateStart;
            }
            if (record._dateEnd && (!maxDate || record._dateEnd > maxDate)) {
                maxDate = record._dateEnd;
            }
        }
        if (!minDate) return "";
        const start = minDate.toFormat("M/d");
        const end = maxDate ? maxDate.toFormat("M/d") : "";
        return end ? `${start}-${end}` : start;
    }

    getGroupBarStyle(group) {
        const data = this.props.model.data;
        if (!data?.timeStart || !group.records?.length) return "display: none;";

        let minDate = null;
        let maxDate = null;
        for (const record of group.records) {
            if (record._dateStart && (!minDate || record._dateStart < minDate)) {
                minDate = record._dateStart;
            }
            if (record._dateEnd && (!maxDate || record._dateEnd > maxDate)) {
                maxDate = record._dateEnd;
            }
        }

        if (!minDate) return "display: none;";

        const left = this._dateToPx(minDate);
        const right = maxDate ? this._dateToPx(maxDate) : left + 50;
        const width = Math.max(right - left, 20);
        return `left: ${left}px; width: ${width}px;`;
    }

    // -------------------------------------------------------------------------
    // Intersection View: child task mini-bars on group rows
    // -------------------------------------------------------------------------

    getIntersectionBars(group) {
        if (!this.props.showIntersection) return [];
        const records = group.records || [];
        const sorted = records
            .filter(r => r._dateStart && r._dateEnd)
            .sort((a, b) => a._dateStart.toMillis() - b._dateStart.toMillis());

        let prevRight = 0;
        let prevTop = 0;
        return sorted.map(r => {
            const left = this._dateToPx(r._dateStart);
            const right = this._dateToPx(r._dateEnd);
            const width = Math.max(right - left, 4);

            // Alternating top offset for overlaps
            let top = 2;
            if (left < prevRight) {
                top = prevTop === 2 ? 16 : 2;
            }
            prevRight = left + width;
            prevTop = top;

            return {
                id: r.id,
                name: r.display_name || "",
                left, width, top,
                color: this._getIntersectionColor(r),
            };
        });
    }

    _getIntersectionColor(record) {
        const colorSetField = this.props.archInfo.colorGanttSet;
        const colorField = this.props.archInfo.colorGantt;
        if (colorSetField && colorField && record[colorSetField] && record[colorField]) {
            return record[colorField];
        }
        return "rgba(242, 133, 113, 0.6)";
    }

    // -------------------------------------------------------------------------
    // Group-level daily load bars (from loadBars data)
    // -------------------------------------------------------------------------

    getGroupLoadBars(group) {
        const allLoadBars = this.props.model.data?.loadBars || [];
        if (allLoadBars.length === 0) return [];

        // Collect task IDs in this group
        const taskIds = new Set((group.records || []).map(r => r.id));

        // Filter load bars for this group's tasks
        const groupBars = allLoadBars.filter(lb => taskIds.has(lb.taskId));
        if (groupBars.length === 0) return [];

        // Group by date (day), sum duration — prefer data_aggr over dateStart
        const dailyMap = new Map();
        for (const lb of groupBars) {
            if (!lb.dateAggr && !lb.dateStart) continue;
            const key = lb.dateAggr || lb.dateStart.toFormat("yyyy-MM-dd");
            if (!dailyMap.has(key)) {
                dailyMap.set(key, { date: key, totalDuration: 0 });
            }
            dailyMap.get(key).totalDuration += lb.duration || 0;
        }

        // Convert to positioned bars
        const result = [];
        const dayWidth = this._getDayWidth();
        for (const [dateStr, entry] of dailyMap) {
            const dt = DateTime.fromISO(dateStr);
            if (!dt.isValid) continue;

            const left = this._dateToPx(dt);
            const width = Math.max(dayWidth - 2, 4);
            const hours = Math.floor(entry.totalDuration);
            const minutes = Math.round((entry.totalDuration % 1) * 60);
            const label = minutes > 0
                ? `${hours}:${String(minutes).padStart(2, "0")}`
                : `${hours}h`;

            result.push({ date: dateStr, left, width, label, hours: entry.totalDuration });
        }

        return result.sort((a, b) => a.date.localeCompare(b.date));
    }

    // -------------------------------------------------------------------------
    // Round 3 Feature 18: Resource level display
    // -------------------------------------------------------------------------

    getResourceLevel(record) {
        const loadBars = this.getLoadBars(record);
        if (loadBars.length === 0) return "";
        // Count distinct resources
        const resources = new Set(loadBars.map(lb => lb.resourceId).filter(Boolean));
        return `${resources.size}R`;
    }

    // -------------------------------------------------------------------------
    // Round 3 Feature 17: Duration humanize (for tooltip, extended)
    // -------------------------------------------------------------------------

    getDetailedDuration(record) {
        if (!record._dateStart || !record._dateEnd) return "";
        const diff = record._dateEnd.diff(record._dateStart, ["days", "hours"]);
        const days = Math.floor(diff.days);
        const hours = Math.round(diff.hours);
        if (days === 0 && hours > 0) return `${hours}h`;
        if (hours === 0) return `${days}d`;
        return `${days}d ${hours}h`;
    }

    // -------------------------------------------------------------------------
    // Scroll position save / restore (called by controller around reloads)
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Constraint badge helper
    // -------------------------------------------------------------------------

    getConstraintBadge(record) {
        const typeField = this.props.archInfo.constrainType || "constrain_type";
        const type = record[typeField];
        if (!type || type === "asap" || type === "alap") return null;
        const labels = {
            snet: "SNET", snlt: "SNLT", fnet: "FNET", fnlt: "FNLT",
            mso: "MSO", mfo: "MFO",
        };
        return labels[type] || type.toUpperCase();
    }

    // -------------------------------------------------------------------------
    // Violation panel helpers
    // -------------------------------------------------------------------------

    onViolationClick(taskId) {
        this.state.selectedRowId = taskId;
        this.scrollToRecord(taskId);
        if (this.props.onViolationTaskClick) {
            this.props.onViolationTaskClick(taskId);
        }
    }

    scrollToRecord(recordId) {
        const bar = this.timelineDataRef.el?.querySelector(
            `.o_gantt_bar[data-record-id="${recordId}"]`
        );
        if (bar) {
            bar.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        }
    }

    saveScroll() {
        const timeline = this.timelineRef.el;
        if (!timeline) return null;
        return { left: timeline.scrollLeft, top: timeline.scrollTop };
    }

    restoreScroll(state) {
        if (!state) return;
        const timeline = this.timelineRef.el;
        if (!timeline) return;
        requestAnimationFrame(() => {
            timeline.scrollLeft = state.left;
            timeline.scrollTop = state.top;
        });
    }
}
