/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount, markRaw, reactive } from "@odoo/owl";
import { useOwnedDialogs } from "@web/core/utils/hooks";
import { usePopover } from "@web/core/popover/popover_hook";
import { DateTimePickerPopover } from "@web/core/datetime/datetime_picker_popover";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { useGanttGutter } from "./gantt_gutter_hook";
import { useGanttBarDrag } from "./gantt_bar_drag_hook";
import { useGanttBarResize } from "./gantt_bar_resize_hook";
import { useGanttDeadlineDrag } from "./gantt_deadline_drag_hook";
import { useGanttTreeDrag } from "./gantt_tree_drag_hook";
import { useGanttArrowDraw } from "./gantt_arrow_draw_hook";
import { useGanttProgressDrag } from "./gantt_progress_drag_hook";
import { cellsDeltaToDuration } from "./gantt_utils";
import { GanttArrows } from "./gantt_arrows";
import { GanttTooltip } from "./gantt_tooltip";
import { GanttContextMenu } from "./gantt_context_menu";
import { GanttScrollMap } from "./gantt_scrollmap";
import { GanttInspector, GANTT_COLORS } from "./gantt_inspector";

const { DateTime } = luxon;

/** Fixed reference date for planning mode virtual timeline (T+0). */
const PLANNING_T0 = DateTime.fromObject({ year: 2000, month: 1, day: 1 });

export class GanttRenderer extends Component {
    static template = "dobtor_project.GanttRenderer";
    static components = { GanttArrows, GanttTooltip, GanttContextMenu, GanttScrollMap, GanttInspector };

    static props = {
        onRendererReady: { type: Function, optional: true },
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
        inspectorRecordId: { optional: true },
        onInspectorClose: { type: Function, optional: true },
        onInspectorFieldChange: { type: Function, optional: true },
        onInspectorOpen: { type: Function, optional: true },
        // Reload callback (to reload with proper domain/context from controller)
        onReload: { type: Function, optional: true },
        // Filter (Phase 3D)
        filterCriticalPath: { type: Boolean, optional: true },
        filterOverdue: { type: Boolean, optional: true },
        filterUnlinked: { type: Boolean, optional: true },
        // PDF report
        onReportClick: { type: Function, optional: true },
    };

    setup() {
        this.displayDialog = useOwnedDialogs();
        this.timelineRef = useRef("timeline");
        this.timelineDataRef = useRef("timelineData");
        this.listRowsRef = useRef("listRows");
        this.durationRowsRef = useRef("durationRows");

        // CRITICAL: Register onRendererReady FIRST, before any hooks.
        // Hook onMounted callbacks fire in registration order; if any hook's
        // onMounted throws, later callbacks are skipped.  By registering
        // this as the very first onMounted we guarantee the controller
        // receives the renderer API even if a downstream hook errors.
        onMounted(() => {
            if (this.props.onRendererReady) {
                this.props.onRendererReady({
                    saveScroll: () => this.saveScroll(),
                    restoreScroll: (s) => this.restoreScroll(s),
                    scrollToRecord: (id) => this.scrollToRecord(id),
                    getSelectedRowId: () => this.state.selectedRowId,
                    setSelectedRowId: (id) => { this.state.selectedRowId = id; },
                    getSelectedRowIds: () => this.state.selectedRowIds,
                    clearMultiSelect: () => this.state.selectedRowIds.clear(),
                    getFlattenedRows: () => this.flattenedRows,
                    createSiblingTask: (id) => this.createSiblingTask(id),
                });
            }
        });

        // Project date range popover (Odoo native DateTimePicker)
        // Must use reactive() so DateTimePicker re-renders on value/focusedDateIndex changes
        this._datePickerGroup = null;
        this._datePickerProps = reactive({
            type: "date",
            range: true,
            focusedDateIndex: 0,
            value: [false, false],
            onSelect: (value, unit) => {
                value &&= markRaw(value);
                if (unit !== "time") {
                    if (this._datePickerProps.focusedDateIndex === 0 ||
                        (value[0] && value[1] && value[1] < value[0])) {
                        // First date picked or end < start: set both dates to same, focus end
                        const { year, month, day } = value[this._datePickerProps.focusedDateIndex];
                        for (let i = 0; i < value.length; i++) {
                            value[i] = value[i] && value[i].set({ year, month, day });
                        }
                        this._datePickerProps.focusedDateIndex = 1;
                    } else {
                        this._datePickerProps.focusedDateIndex =
                            this._datePickerProps.focusedDateIndex === 1 ? 0 : 1;
                    }
                }
                this._datePickerProps.value = markRaw(value);
            },
        });
        this.dateRangePopover = usePopover(DateTimePickerPopover, {
            onClose: () => this._onDateRangePopoverClose(),
        });

        // Restore gutter widths from localStorage
        const savedGutterWidth = parseInt(localStorage.getItem("gantt_gutter_width"), 10);
        const savedDurationWidth = parseInt(localStorage.getItem("gantt_duration_width"), 10);

        this.state = useState({
            gutterWidth: (savedGutterWidth > 0) ? savedGutterWidth : 300,
            durationWidth: (savedDurationWidth > 0) ? savedDurationWidth : 80,
            hoveredRowId: null,
            selectedRowId: null,
            selectedRowIds: new Set(),
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

        // --- Hook: Gutter resize (Task List ↔ Duration) ---
        useGanttGutter(this.state, {
            refName: "gutter",
            stateKey: "gutterWidth",
            storageKey: "gantt_gutter_width",
            min: 200, max: 500,
        });

        // --- Hook: Duration gutter resize (Duration ↔ Timeline) ---
        useGanttGutter(this.state, {
            refName: "gutterDuration",
            stateKey: "durationWidth",
            storageKey: "gantt_duration_width",
            min: 60, max: 200,
        });

        // --- Hook: Bar drag ---
        useGanttBarDrag({
            getTimelineEl: () => this.timelineDataRef.el,
            getCellWidth: () => this.cellWidth,
            getScale: () => this.props.scale,
            getTimeStart: () => this.props.model.data?.timeStart,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            getMinStart: (id) => {
                const rec = this.props.model.data?.records.find(r => r.id === id);
                if (rec && rec._hasChildren) {
                    return this.props.model.getMinStartForParentDrag(id);
                }
                return this.props.model.getMinStartForRecord(id);
            },
            onBoundaryHit: (id) => {
                const info = this.props.model.getBlockingFsInfo(id);
                if (info) {
                    this.env.services.notification.add(info.message, {
                        type: "warning",
                        sticky: false,
                    });
                }
            },
            onDragEnd: async (recordId, cellsDelta) => {
                const record = this.props.model.data?.records.find(r => r.id === recordId);
                if (!record) return;

                const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);

                // --- Parent task: move with all descendants ---
                if (record._hasChildren) {
                    const summaryStart = record._summaryDateStart || record._dateStart;
                    if (!summaryStart) return;
                    let newStart = summaryStart.plus(shiftDur);
                    // Clamp to FS predecessor constraints (own + all descendants)
                    const minStart = this.props.model.getMinStartForParentDrag(recordId);
                    if (minStart && newStart < minStart) {
                        newStart = minStart;
                    }
                    const shiftHours = newStart.diff(summaryStart, "hours").hours;
                    if (Math.abs(shiftHours) < 0.01) return;
                    await this.props.model.moveRecordWithChildren(recordId, shiftHours);
                    await this.props.model._pushFSSuccessors(recordId);
                    await this.props.model._recalcAndUpdateLags(recordId);
                    if (this.props.onReload) await this.props.onReload();
                    return;
                }

                // --- Leaf task: existing logic ---
                // Clamp: start never before predecessor's end or parent's start
                const minStart = this.props.model.getMinStartForRecord(recordId);

                if (record._isVirtualDates) {
                    // Planning mode: update plan_offset (hours)
                    const shiftHours = DateTime.fromMillis(0).plus(shiftDur).toMillis() / 3600000;
                    let newOffset = Math.max(0, (record._planOffset || 0) + shiftHours);
                    // Clamp to FS predecessor end
                    if (minStart) {
                        const T0 = PLANNING_T0;
                        const minOffset = minStart.diff(T0, "hours").hours;
                        if (newOffset < minOffset) newOffset = minOffset;
                    }
                    await this.props.model.updatePlanOffset(recordId, newOffset);
                } else if (record._scheduleMode === "auto") {
                    // Auto mode: convert drag to SNET constraint instead of overwriting dates
                    let newStart = record._dateStart ? record._dateStart.plus(shiftDur) : null;
                    if (minStart && newStart && newStart < minStart) {
                        newStart = minStart;
                    }
                    if (newStart) {
                        const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
                        const constrainDateField = this.props.archInfo.constrainDate || "constrain_date";
                        await this.props.model.updateRecord(recordId, {
                            [constrainTypeField]: "snet",
                            [constrainDateField]: newStart.toFormat("yyyy-MM-dd HH:mm:ss"),
                        });
                    }
                } else {
                    // Manual mode: update actual dates
                    const dateStartField = this.props.archInfo.dateStart || "date_start";
                    const dateStopField = this.props.archInfo.dateStop || "date_end";
                    if (this._isFieldReadonly(dateStartField) || this._isFieldReadonly(dateStopField)) {
                        this.env.services.notification.add(
                            "\u7121\u6CD5\u4FEE\u6539\uFF1A\u65E5\u671F\u6B04\u4F4D\u70BA\u552F\u8B80",
                            { type: "warning" }
                        );
                        return;
                    }
                    let newStart = record._dateStart ? record._dateStart.plus(shiftDur) : null;
                    // Clamp to FS predecessor end
                    if (minStart && newStart && newStart < minStart) {
                        newStart = minStart;
                    }
                    const values = {};
                    if (newStart) {
                        values[dateStartField] = newStart.toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    if (record._dateEnd && record._dateStart) {
                        const duration = record._dateEnd.diff(record._dateStart);
                        values[dateStopField] = (newStart || record._dateStart).plus(duration).toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    await this.props.model.updateRecord(recordId, values);
                }
                // Push FS successors if this task's end moved forward
                await this.props.model._pushFSSuccessors(recordId);
                await this.props.model._recalcAndUpdateLags(recordId);
                // Full reload to refresh server-computed fields
                if (this.props.onReload) await this.props.onReload();
            },
            // Vertical reorder: drag bar up/down to reorder tasks
            onVerticalReorder: async (recordId, targetId, position) => {
                await this.props.model.reorderRecord(recordId, targetId, position);
                // No reload — model handles optimistic local update internally
            },
            getFlattenedRows: () => this.flattenedRows,
            getListEl: () => this.listRowsRef.el,
        });

        // --- Hook: Bar resize ---
        useGanttBarResize({
            getTimelineEl: () => this.timelineDataRef.el,
            getCellWidth: () => this.cellWidth,
            getScale: () => this.props.scale,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            onResizeEnd: async (recordId, side, cellsDelta) => {
                const record = this.props.model.data?.records.find(r => r.id === recordId);
                if (!record) return;

                // Constraint for left-side resize: FS predecessors + parent start
                const minStart = (side === "left")
                    ? this.props.model.getMinStartForRecord(recordId)
                    : null;

                if (record._isVirtualDates) {
                    // Planning mode: update plan_duration and plan_offset (hours)
                    const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
                    const shiftHours = DateTime.fromMillis(0).plus(shiftDur).toMillis() / 3600000;
                    if (side === "right") {
                        const newDuration = Math.max(24, (record._planDuration || 24) + shiftHours);
                        await this.props.model.updatePlanDuration(recordId, newDuration);
                    } else {
                        // Left resize: adjust both offset and duration
                        let newOffset = Math.max(0, (record._planOffset || 0) + shiftHours);
                        let newDuration = Math.max(24, (record._planDuration || 24) - shiftHours);
                        // Clamp to FS predecessor end
                        if (minStart) {
                            const T0 = PLANNING_T0;
                            const minOffset = minStart.diff(T0, "hours").hours;
                            if (newOffset < minOffset) {
                                newDuration = Math.max(24, newDuration - (minOffset - newOffset));
                                newOffset = minOffset;
                            }
                        }
                        const planDurationField = this.props.archInfo.planDuration || "plan_duration";
                        const planOffsetField = this.props.archInfo.planOffset || "plan_offset";
                        await this.props.model.updateRecord(recordId, {
                            [planOffsetField]: newOffset,
                            [planDurationField]: newDuration,
                        });
                    }
                } else {
                    // Normal mode: update actual dates
                    const dateStartField = this.props.archInfo.dateStart || "date_start";
                    const dateStopField = this.props.archInfo.dateStop || "date_end";
                    const checkField = side === "left" ? dateStartField : dateStopField;
                    if (this._isFieldReadonly(checkField)) {
                        this.env.services.notification.add(
                            "\u7121\u6CD5\u4FEE\u6539\uFF1A\u65E5\u671F\u6B04\u4F4D\u70BA\u552F\u8B80",
                            { type: "warning" }
                        );
                        return;
                    }
                    const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
                    const values = {};
                    if (side === "left" && record._dateStart) {
                        let newStart = record._dateStart.plus(shiftDur);
                        // Clamp to FS predecessor end
                        if (minStart && newStart < minStart) newStart = minStart;
                        values[dateStartField] = newStart.toFormat("yyyy-MM-dd HH:mm:ss");
                    } else if (side === "right" && record._dateEnd) {
                        values[dateStopField] = record._dateEnd.plus(shiftDur).toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    await this.props.model.updateRecord(recordId, values);
                }
                // Push FS successors if this task's end moved forward
                await this.props.model._pushFSSuccessors(recordId);
                await this.props.model._recalcAndUpdateLags(recordId);
                if (this.props.onReload) await this.props.onReload();
            },
            onConstraintSet: async (recordId, constrainType, constrainDate) => {
                const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
                const constrainDateField = this.props.archInfo.constrainDate || "constrain_date";
                await this.props.model.updateRecord(recordId, {
                    [constrainTypeField]: constrainType,
                    [constrainDateField]: constrainDate,
                });
                if (this.props.onReload) await this.props.onReload();
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
                        "\u7121\u6CD5\u4FEE\u6539\uFF1A\u622A\u6B62\u65E5\u6B04\u4F4D\u70BA\u552F\u8B80",
                        { type: "warning" }
                    );
                    return;
                }
                const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
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
                await this.props.model.reorderRecord(recordId, targetId, position);
                // No reload — model handles optimistic local update internally
            },
        });

        // --- Hook: Arrow draw (create/delete predecessor links) ---
        useGanttArrowDraw({
            getTimelineEl: () => this.timelineDataRef.el,
            getRecord: (id) => this.props.model.data?.records.find(r => r.id === id),
            onLinkCreated: async (fromId, toId, type) => {
                if (toId < 0) {
                    // Target is a milestone (negative ID)
                    await this.props.model.linkTaskToMilestone(fromId, toId);
                } else if (fromId < 0) {
                    // Source is a milestone — not allowed
                    return;
                } else {
                    // Block links between ancestor-descendant tasks
                    const records = this.props.model.data?.records || [];
                    const isAncestor = (aId, dId) => {
                        let r = records.find(x => x.id === dId);
                        while (r && r._parentId) {
                            if (r._parentId === aId) return true;
                            r = records.find(x => x.id === r._parentId);
                        }
                        return false;
                    };
                    if (isAncestor(fromId, toId) || isAncestor(toId, fromId)) {
                        return;
                    }
                    // Normal task→task predecessor
                    await this.props.model.createPredecessor(toId, fromId, type);
                }
                // Reload to pick up ancestor date propagation from server
                if (this.props.onReload) await this.props.onReload();
            },
            onLinkDeleted: async (predIdentifier) => {
                await this.props.model.deletePredecessor(predIdentifier);
                if (this.props.onReload) await this.props.onReload();
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
                        "\u7121\u6CD5\u4FEE\u6539\uFF1A\u9032\u5EA6\u6B04\u4F4D\u70BA\u552F\u8B80",
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

        // Keyboard: Enter to create sibling task (handled in renderer directly,
        // avoids cross-component API bridge timing issues)
        this._onRendererKeyDown = (ev) => {
            if (ev.isComposing) return; // IME composition (e.g. 注音選字)
            if (ev.target.closest("input, textarea, [contenteditable], .modal")) return;
            if (ev.key === "Enter" && this.state.selectedRowId) {
                ev.preventDefault();
                this.createSiblingTask(this.state.selectedRowId);
            }
        };

        onMounted(() => {
            this._syncScroll();
            this._initScrollTracking();
            document.addEventListener("keydown", this._onRendererKeyDown);
        });

        onWillUnmount(() => {
            document.removeEventListener("keydown", this._onRendererKeyDown);
            if (this._resizeObserver) {
                this._resizeObserver.disconnect();
                this._resizeObserver = null;
            }
        });
    }

    _syncScroll() {
        // Sync vertical scroll across all panels (list, duration, timeline) with loop prevention
        const timeline = this.timelineRef.el;
        const listRows = this.listRowsRef.el;
        const durationRows = this.durationRowsRef.el;
        if (!timeline || !listRows) return;

        let isSyncing = false;
        const panels = [timeline, listRows];
        if (durationRows) panels.push(durationRows);

        const syncScroll = (source) => {
            if (isSyncing) return;
            isSyncing = true;
            // Apply scrollTop synchronously to avoid stale values
            for (const panel of panels) {
                if (panel !== source) {
                    panel.scrollTop = source.scrollTop;
                }
            }
            // Keep flag true until next frame to suppress feedback scroll events
            requestAnimationFrame(() => {
                isSyncing = false;
            });
        };

        for (const panel of panels) {
            panel.addEventListener("scroll", () => syncScroll(panel), { passive: true });
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
            this._resizeObserver = new ResizeObserver(updateScroll);
            this._resizeObserver.observe(timeline);
        }
    }

    get cellWidth() {
        return this.cellWidths[this.props.scale] || 40;
    }

    /**
     * Whether all groups are in planning mode (no schedule_start).
     */
    get isPlanningMode() {
        const groups = this.props.model.data?.groups || [];
        return groups.length > 0 && groups.every(g => g._isPlanningMode);
    }

    get timelineColumns() {
        const data = this.props.model.data;
        if (!data?.timeStart || !data?.timeEnd ||
            !data.timeStart.isValid || !data.timeEnd.isValid) {
            // Default: show current month
            const now = DateTime.now();
            const start = now.startOf("month");
            const end = now.endOf("month");
            return this._generateColumns(start, end);
        }
        // Extend range on both sides so edge bars can scroll to center
        const extStart = this._extendedTimeStart || data.timeStart;
        const extEnd = this._extendedTimeEnd || data.timeEnd;
        return this._generateColumns(extStart, extEnd);
    }

    _generateColumns(start, end) {
        // Guard: if start or end are invalid, fall back to current month
        if (!start || !start.isValid || !end || !end.isValid) {
            const now = DateTime.now();
            start = now.startOf("month");
            end = now.endOf("month");
        }
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
                    weekday: current.toFormat("M/d"),
                    month: current.toFormat("yyyy/M/d"),
                    isWeekend: current.weekday === 6 || current.weekday === 7,
                    isToday: current.hasSame(now, "hour") ||
                        (now >= current && now < current.plus({ hours })),
                });
                current = current.plus({ hours });
            }
        } else if (scale === "day") {
            const weekType = this.props.weekType || "iso";
            let current = start.startOf("day");
            // T0 reference for planning mode
            const T0 = PLANNING_T0;
            const inPlanningMode = this.isPlanningMode;
            while (current <= end) {
                if (inPlanningMode) {
                    const dayOffset = Math.round(current.diff(T0, "days").days);
                    columns.push({
                        date: current,
                        label: `T+${dayOffset}`,
                        weekday: "",
                        month: "T-day",
                        isWeekend: false,
                        isToday: false,
                    });
                } else {
                    // Luxon weekday: 1=Mon..7=Sun
                    const isWeekend = current.weekday === 6 || current.weekday === 7;
                    columns.push({
                        date: current,
                        label: current.toFormat("d"),
                        weekday: current.toFormat("EEE"),
                        month: current.toFormat("yyyy\u5E74M\u6708"),
                        isWeekend,
                        isToday: current.hasSame(now, "day"),
                    });
                }
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
                        weekday: `${current.toFormat("M/d")} - ${weekEnd.toFormat("M/d")}`,
                        month: current.toFormat("yyyy\u5E74M\u6708"),
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
                        weekday: `${current.toFormat("M/d")} - ${weekEnd.toFormat("M/d")}`,
                        month: current.toFormat("yyyy\u5E74M\u6708"),
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
                    label: `${current.month}\u6708`,
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
                    label: `${current.month}\u6708`,
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
     * Convert a DateTime to pixel position relative to timeline start.
     * Uses uniform px/ms for sub-day scales, px/day for day and above.
     */
    _dateToPx(dt) {
        const data = this.props.model.data;
        if (!data?.timeStart || !dt) return 0;
        // Guard against invalid Luxon DateTimes
        if (!data.timeStart.isValid || (dt.isValid !== undefined && !dt.isValid)) return 0;

        const scale = this.props.scale;
        const cw = this.cellWidth;
        const start = this._extendedTimeStart || data.timeStart;

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

    /**
     * Number of extra columns to prepend/append so that edge bars
     * (first / last task) can still be scrolled to the viewport center.
     */
    get extraPaddingCols() {
        const vw = this._scrollState.viewportWidth;
        const cw = this.cellWidth;
        if (cw <= 0) return 0;
        return Math.ceil((vw > 0 ? vw : 800) / 2 / cw);
    }

    /** Timeline start shifted back by extraPaddingCols column units. */
    get _extendedTimeStart() {
        const data = this.props.model.data;
        if (!data?.timeStart?.isValid) return null;
        return this._shiftByColumns(data.timeStart, -this.extraPaddingCols);
    }

    /** Timeline end shifted forward by extraPaddingCols column units. */
    get _extendedTimeEnd() {
        const data = this.props.model.data;
        if (!data?.timeEnd?.isValid) return null;
        return this._shiftByColumns(data.timeEnd, this.extraPaddingCols);
    }

    /** Shift a date by n column units based on current scale. */
    _shiftByColumns(date, n) {
        const scale = this.props.scale;
        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            return date.plus({ hours: n * parseInt(scale) });
        }
        if (scale === "day") return date.plus({ days: n });
        if (scale === "week") return date.plus({ weeks: n });
        return date.plus({ months: n }); // month & quarter
    }

    get todayPosition() {
        const data = this.props.model.data;
        if (!data?.timeStart || !data.timeStart.isValid) return null;
        if (!data?.timeEnd || !data.timeEnd.isValid) return null;

        const today = DateTime.now();
        const extStart = this._extendedTimeStart || data.timeStart;
        const extEnd = this._extendedTimeEnd || data.timeEnd;
        if (today < extStart || today > extEnd) return null;

        return this._dateToPx(today);
    }

    // -------------------------------------------------------------------------
    // Arrow component props
    // -------------------------------------------------------------------------

    get arrowProps() {
        const data = this.props.model.data;
        return {
            predecessors: data?.predecessors || [],
            milestoneLinks: data?.milestoneLinks || [],
            records: data?.records || [],
            flattenedRows: this.flattenedRows,
            timeStart: this._extendedTimeStart || data?.timeStart,
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

    onBarClick(record, ev) {
        // Multi-select with Ctrl/Cmd key
        if (ev && (ev.ctrlKey || ev.metaKey)) {
            if (this.state.selectedRowIds.has(record.id)) {
                this.state.selectedRowIds.delete(record.id);
            } else {
                this.state.selectedRowIds.add(record.id);
            }
        } else {
            this.state.selectedRowIds.clear();
        }
        this.state.selectedRowId = record.id;
    }

    onTaskSelect(record, ev) {
        // Multi-select with Ctrl/Cmd key
        if (ev && (ev.ctrlKey || ev.metaKey)) {
            if (this.state.selectedRowIds.has(record.id)) {
                this.state.selectedRowIds.delete(record.id);
            } else {
                this.state.selectedRowIds.add(record.id);
            }
        } else {
            this.state.selectedRowIds.clear();
        }
        this.state.selectedRowId = record.id;
    }

    async onTaskFoldClick(record) {
        if (this.props.model.toggleTaskFold) {
            await this.props.model.toggleTaskFold(record.id);
        }
    }

    isLoadingChildren(record) {
        return this.props.model.isLoadingChildren
            ? this.props.model.isLoadingChildren(record.id)
            : false;
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
        // Milestone double-click: rename or open form
        if (record._isMilestoneRecord) {
            const nameEl = ev.target.closest(".o_gantt_milestone_name");
            if (nameEl) {
                ev.stopPropagation();
                this._startMilestoneInlineEdit(record.id, nameEl);
                return;
            }
            // Fallback: open milestone form
            this.env.services.action.doAction({
                type: "ir.actions.act_window",
                res_model: "project.milestone",
                res_id: Math.abs(record.id),
                views: [[false, "form"]],
                target: "current",
            });
            return;
        }
        const nameEl = ev.target.closest(".o_gantt_task_name");
        if (!nameEl) return;
        ev.stopPropagation();
        this._startInlineEdit(record.id, nameEl, false);
    }

    /**
     * Inline rename for milestone records.
     * @param {number} negativeId - The milestone's negative ID
     * @param {HTMLElement} nameEl - The .o_gantt_milestone_name element
     * @param {boolean} isNew - If true, Escape/blur-with-empty deletes the milestone
     */
    _startMilestoneInlineEdit(negativeId, nameEl, isNew = false) {
        const record = this.props.model.data?.records.find(r => r.id === negativeId);
        if (!record) return;

        const oldText = isNew ? "" : (record.display_name || record.name || "");
        nameEl.contentEditable = true;
        nameEl.classList.add("o_gantt_inline_editing");
        nameEl.textContent = oldText;
        nameEl.focus();

        // Select all text
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        let isFinishing = false;
        const finish = async (cancelled) => {
            if (isFinishing) return;
            isFinishing = true;
            nameEl.contentEditable = false;
            nameEl.classList.remove("o_gantt_inline_editing");
            nameEl.removeEventListener("blur", onBlur);
            nameEl.removeEventListener("keydown", onKeyDown);

            const newName = (nameEl.textContent || "").trim();

            if (isNew) {
                if (!newName || cancelled) {
                    // Empty name or cancelled → delete newly created milestone
                    await this.props.model.deleteMilestone(negativeId);
                } else {
                    await this.props.model.renameMilestone(negativeId, newName);
                }
            } else {
                if (newName && newName !== oldText) {
                    await this.props.model.renameMilestone(negativeId, newName);
                } else {
                    nameEl.textContent = oldText;
                }
            }
        };

        const onBlur = () => finish(false);
        const onKeyDown = (e) => {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                nameEl.blur();
            } else if (e.key === "Escape") {
                if (isNew) {
                    nameEl.removeEventListener("blur", onBlur);
                    nameEl.contentEditable = false;
                    nameEl.classList.remove("o_gantt_inline_editing");
                    nameEl.removeEventListener("keydown", onKeyDown);
                    this.props.model.deleteMilestone(negativeId);
                } else {
                    nameEl.textContent = oldText;
                    nameEl.blur();
                }
            }
        };

        nameEl.addEventListener("blur", onBlur, { once: true });
        nameEl.addEventListener("keydown", onKeyDown);
    }

    /**
     * Shared inline edit logic for both double-click rename and new-task naming.
     * @param {number} recordId - The record being edited
     * @param {HTMLElement} nameEl - The .o_gantt_task_name element
     * @param {boolean} isNew - If true, Escape/blur-with-empty deletes the record
     */
    _startInlineEdit(recordId, nameEl, isNew) {
        const record = this.props.model.data?.records?.find(r => r.id === recordId);
        const origText = isNew ? "" : (record?.display_name || "");

        this._editingRecordId = recordId;
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

        let isFinishing = false;
        const finishEdit = async (cancelled) => {
            if (isFinishing) return;
            isFinishing = true;
            nameEl.removeAttribute("contenteditable");
            nameEl.classList.remove("o_gantt_inline_editing");
            nameEl.removeEventListener("blur", onBlur);
            nameEl.removeEventListener("keydown", onKeyDown);

            const newText = nameEl.textContent.trim();
            this._editingRecordId = null;

            if (isNew) {
                if (!newText || cancelled) {
                    // Empty name or cancelled → delete the newly created record
                    await this.props.model.deleteRecord(recordId);
                } else {
                    await this.props.model.renameRecord(recordId, newText);
                }
            } else {
                if (newText && newText !== origText) {
                    await this.props.model.renameRecord(recordId, newText);
                } else {
                    nameEl.textContent = origText;
                }
            }
        };

        const onBlur = () => finishEdit(false);
        const onKeyDown = (e) => {
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                nameEl.blur();
            } else if (e.key === "Escape") {
                if (isNew) {
                    // Prevent blur handler from running, then cancel
                    nameEl.removeEventListener("blur", onBlur);
                    nameEl.removeAttribute("contenteditable");
                    nameEl.classList.remove("o_gantt_inline_editing");
                    nameEl.removeEventListener("keydown", onKeyDown);
                    this._editingRecordId = null;
                    this.props.model.deleteRecord(recordId);
                } else {
                    nameEl.textContent = origText;
                    nameEl.blur();
                }
            }
        };

        nameEl.addEventListener("blur", onBlur, { once: true });
        nameEl.addEventListener("keydown", onKeyDown);
    }

    /**
     * Create a sibling task next to the reference task and start inline editing.
     * Called from controller's Enter key handler via rendererApi.
     */
    async createSiblingTask(referenceId) {
        const newId = await this.props.model.createSiblingRecord(referenceId);
        if (!newId) return;

        this.state.selectedRowId = newId;

        // Wait for OWL to render the new row (double rAF for safety)
        await new Promise(resolve => {
            requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
            });
        });

        const listRows = this.listRowsRef.el;
        const nameEl = listRows?.querySelector(
            `.o_gantt_list_row[data-record-id="${newId}"] .o_gantt_task_name`
        );
        if (nameEl) {
            this._startInlineEdit(newId, nameEl, true);
        }
    }

    // -------------------------------------------------------------------------
    // Indent / Outdent
    // -------------------------------------------------------------------------

    /**
     * Whether the record can be indented (has a previous sibling at same level).
     */
    canIndent(record) {
        if (record._isGroup) return false;
        const parentField = this.props.archInfo.parentId || "parent_id";
        const sortField = this.props.archInfo.sortingSeq || "sorting_seq";
        const parentId = record._parentId || 0;
        const recordSeq = record[sortField] || 0;

        // Find at least one sibling with lower seq
        const records = this.props.model.data?.records || [];
        return records.some(r => {
            const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
            return pid === parentId && r.id !== record.id && (r[sortField] || 0) < recordSeq;
        });
    }

    /**
     * Whether the record can be outdented (is not a root-level task).
     */
    canOutdent(record) {
        if (record._isGroup) return false;
        return (record._parentId || 0) !== 0;
    }

    async onIndentClick(record) {
        const success = await this.props.model.indentTask(record.id);
        if (success && this.props.onReload) {
            await this.props.onReload();
        }
    }

    async onOutdentClick(record) {
        const success = await this.props.model.outdentTask(record.id);
        if (success && this.props.onReload) {
            await this.props.onReload();
        }
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

    /**
     * Collect all descendant IDs recursively from local data.
     */
    _collectDescendantIds(recordId) {
        const records = this.props.model.data?.records || [];
        const ids = [];
        const stack = [recordId];
        while (stack.length) {
            const pid = stack.pop();
            for (const r of records) {
                if (r._parentId === pid) {
                    ids.push(r.id);
                    stack.push(r.id);
                }
            }
        }
        return ids;
    }

    onDeleteTaskClick(record) {
        const descendantIds = this._collectDescendantIds(record.id);
        const allIds = [record.id, ...descendantIds];
        const name = record.display_name || record.name || `\u4EFB\u52D9 #${record.id}`;

        let body;
        if (descendantIds.length > 0) {
            body = _t(
                "\u522A\u9664\u300C%(name)s\u300D\u53CA\u5176 %(count)s \u500B\u5B50\u4EFB\u52D9\uFF1F",
                { name, count: descendantIds.length }
            );
        } else {
            body = _t("\u522A\u9664\u300C%(name)s\u300D\uFF1F", { name });
        }

        this.displayDialog(ConfirmationDialog, {
            body,
            confirm: async () => {
                await this.props.model.deleteRecords(allIds);
                this.state.selectedRowId = null;
                this.state.selectedRowIds.clear();
                if (this.props.onReload) {
                    await this.props.onReload();
                }
            },
        });
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

    async onAddMilestoneToGroup(group) {
        const negativeId = await this.props.model.createMilestone(group.id);
        if (!negativeId) return;

        this.state.selectedRowId = negativeId;

        // Wait for OWL to render the new row
        await new Promise(resolve => {
            requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
            });
        });

        const listRows = this.listRowsRef.el;
        const nameEl = listRows?.querySelector(
            `.o_gantt_list_row[data-record-id="${negativeId}"] .o_gantt_milestone_name`
        );
        if (nameEl) {
            this._startMilestoneInlineEdit(negativeId, nameEl, true);
        }
    }

    onDeleteMilestoneClick(record) {
        const name = record.display_name || record.name || `里程碑 #${Math.abs(record.id)}`;
        this.displayDialog(ConfirmationDialog, {
            body: _t("確定要刪除里程碑 \"%s\" 嗎？", name),
            confirm: async () => {
                await this.props.model.deleteMilestone(record.id);
            },
        });
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
        if (!data?.timeStart || !data.timeStart.isValid || !ghostBar.dateStart) return "display: none;";

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
        if (!resourceId || !this._isValidDt(record._dateStart) || !this._isValidDt(record._dateEnd)) return [];

        // Find all other records that share same resource and overlap in time
        const records = this.props.model.data?.records || [];
        const conflicts = [];

        for (const other of records) {
            if (other.id === record.id) continue;
            const otherRes = other[resourceField];
            const otherId = Array.isArray(otherRes) ? otherRes[0] : otherRes;
            if (otherId !== resourceId) continue;
            if (!this._isValidDt(other._dateStart) || !this._isValidDt(other._dateEnd)) continue;

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
        const record = this.props.model.data?.records?.find(r => r.id === this.props.inspectorRecordId);
        // Return shallow copy so OWL detects prop changes after updateRecord
        return record ? { ...record } : null;
    }

    get inspectorPredecessors() {
        if (!this.props.inspectorRecordId) return [];
        const records = this.props.model.data?.records || [];
        const recordMap = new Map(records.map(r => [r.id, r]));
        const selectedId = this.props.inspectorRecordId;

        const LINK_LABELS = {
            FS: ["\u5B8C\u6210", "\u958B\u59CB"],  // 完成 → 開始
            SF: ["\u958B\u59CB", "\u5B8C\u6210"],  // 開始 → 完成
            SS: ["\u958B\u59CB", "\u958B\u59CB"],  // 開始 → 開始
            FF: ["\u5B8C\u6210", "\u5B8C\u6210"],  // 完成 → 完成
        };

        return (this.props.model.data?.predecessors || [])
            .filter(p => p.task_id === selectedId || p.parent_task_id === selectedId)
            .map(p => {
                const linkedId = p.task_id === selectedId ? p.parent_task_id : p.task_id;
                const linkedRecord = recordMap.get(linkedId);
                const typeKey = (p.type || "FS").toUpperCase();
                const labels = LINK_LABELS[typeKey] || LINK_LABELS.FS;
                return {
                    ...p,
                    _linkedName: linkedRecord ? linkedRecord.display_name : `#${linkedId}`,
                    _linkFrom: labels[0],
                    _linkTo: labels[1],
                    _predIdentifier: p.id || `arrow_${p.parent_task_id}_${p.task_id}`,
                };
            });
    }

    get inspectorMilestoneLinks() {
        if (!this.props.inspectorRecordId) return [];
        const record = this.inspectorRecord;
        if (!record || !record._isMilestoneRecord) return [];
        const milestoneNegId = record.id;
        const links = (this.props.model.data?.milestoneLinks || [])
            .filter(l => l.milestone_id === milestoneNegId);
        const records = this.props.model.data?.records || [];
        return links.map(l => {
            const task = records.find(r => r.id === l.task_id);
            return {
                task_id: l.task_id,
                task_name: task ? (task.display_name || task.name) : `#${l.task_id}`,
                task_wbs: task ? task._wbsNumber : "",
            };
        });
    }

    async onRemoveMilestoneLink(taskId) {
        const milestoneIdField = this.props.archInfo.milestoneId || "milestone_id";
        await this.props.model.updateRecord(taskId, { [milestoneIdField]: false });
        this.props.model._buildMilestoneLinks();
        this.props.model.notify();
    }

    async onDeletePredecessor(predIdentifier) {
        // Optimistic removal: immediately filter out from local data for instant UI feedback
        const preds = this.props.model.data?.predecessors;
        if (preds) {
            const numId = parseInt(predIdentifier, 10);
            const idx = preds.findIndex(p => p.id === numId);
            if (idx !== -1) preds.splice(idx, 1);
            this.props.model.notify();
        }
        const success = await this.props.model.deletePredecessor(predIdentifier);
        if (success && this.props.onReload) {
            await this.props.onReload();
        }
    }

    async onUpdatePredecessor(predId, values) {
        await this.props.model.updatePredecessor(predId, values);
        if (this.props.onReload) await this.props.onReload();
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
                    await model.toggleTaskFold(recordId);
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
            case "duplicate":
                this.props.onRecordClick({ id: recordId, action: "duplicate" });
                break;
            case "show_bar_label":
            case "hide_bar_label": {
                const onGanttField = this.props.archInfo.onGantt || "on_gantt";
                const showLabel = action === "show_bar_label";
                await model.updateRecord(recordId, { [onGanttField]: showLabel });
                if (this.props.onReload) await this.props.onReload();
                break;
            }
            // Milestone actions
            case "delete_milestone":
                await model.deleteMilestone(recordId);
                break;
            case "toggle_reached":
                await model.toggleMilestoneReached(recordId);
                break;
            case "open_milestone":
                this.env.services.action.doAction({
                    type: "ir.actions.act_window",
                    res_model: "project.milestone",
                    res_id: Math.abs(recordId),
                    views: [[false, "form"]],
                    target: "current",
                });
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Avatar helpers
    // -------------------------------------------------------------------------

    getUserAvatarUrl(record) {
        const userField = this.props.archInfo.userId;
        if (!userField) return null;
        const val = record[userField];
        if (!val || (Array.isArray(val) && val.length === 0)) return null;
        // M2M: array of IDs; M2O: [id, "Name"] or id
        const userId = Array.isArray(val) ? val[0] : val;
        if (!userId) return null;
        return `/web/image/res.users/${userId}/avatar_128`;
    }

    getExtraUserCount(record) {
        const userField = this.props.archInfo.userId;
        if (!userField) return 0;
        const val = record[userField];
        if (!Array.isArray(val)) return 0;
        return Math.max(val.length - 1, 0);
    }

    getGroupAvatarUrl(group) {
        if (!group._managerId) return null;
        return `/web/image/res.users/${group._managerId}/avatar_128`;
    }

    // -------------------------------------------------------------------------
    // Class / Style helpers
    // -------------------------------------------------------------------------

    getRowClass(row) {
        const classes = ["o_gantt_list_row", "p-2", "border-bottom"];
        if (row._isGroup) {
            classes.push("o_gantt_group_row");
        }
        if (!row._isGroup && row._isMilestoneRecord) {
            classes.push("o_gantt_milestone_row");
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
        if (!data?.timeStart || !data.timeStart.isValid) {
            return "display: none;";
        }

        // Use summary dates for parent tasks if available
        let dateStart = record._dateStart;
        let dateEnd = record._dateEnd;

        if (record._hasChildren) {
            dateStart = record._summaryDateStart || dateStart;
            dateEnd = record._summaryDateEnd || dateEnd;
        }

        if (!this._isValidDt(dateStart)) {
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

        if (record._isMilestoneRecord) {
            classes.push("o_gantt_milestone");
            if (record.is_reached) {
                classes.push("o_gantt_milestone_complete");
            }
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

        // Multi-select highlight
        if (this.state.selectedRowIds.has(record.id)) {
            classes.push("o_gantt_multi_selected");
        }

        // Phase 3D: Filter dimming
        if (this.isRowFiltered(record)) {
            classes.push("o_gantt_bar_filtered");
        }

        // Planning mode: virtual date bar style
        if (record._isVirtualDates) {
            classes.push("o_gantt_bar_virtual");
        }

        // Color index 0 = no color (white + border)
        const colorField = this.props.archInfo.colorGantt;
        if (colorField) {
            const idx = record[colorField] || 0;
            if (idx === 0) {
                classes.push("o_gantt_bar_no_color");
            }
        }

        return classes.join(" ");
    }

    getBarCustomStyle(record) {
        const colorField = this.props.archInfo.colorGantt;
        if (!colorField) return "";
        const idx = record[colorField] || 0;
        if (idx > 0 && idx < GANTT_COLORS.length) {
            return `background: ${GANTT_COLORS[idx]};`;
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
        const ds = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const de = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (!this._isValidDt(ds)) return "";
        const startStr = ds.toFormat("M/d");
        if (!this._isValidDt(de)) return startStr;
        const endStr = de.toFormat("M/d");
        return `${startStr} - ${endStr}`;
    }

    // -------------------------------------------------------------------------
    // Predecessor count (for tooltip)
    // -------------------------------------------------------------------------

    getPredecessorCount(recordId) {
        const preds = this.props.model.data?.predecessors || [];
        return preds.filter(p => p.task_id === recordId || p.parent_task_id === recordId).length;
    }

    // -------------------------------------------------------------------------
    // Quick create on empty timeline double-click
    // -------------------------------------------------------------------------

    onTimelineDataDblClick(ev) {
        // Only trigger on empty space (not on bars or other elements)
        if (ev.target.closest(".o_gantt_bar") || ev.target.closest(".o_gantt_ghost_bar") ||
            ev.target.closest(".o_gantt_load_bar") || ev.target.closest("svg")) {
            return;
        }

        const timelineData = this.timelineDataRef.el;
        if (!timelineData || !this.props.model.data?.timeStart) return;

        // Calculate the date from click position
        const rect = timelineData.getBoundingClientRect();
        const clickX = ev.clientX - rect.left + timelineData.scrollLeft;
        const cellWidth = this.cellWidth;
        const cellsDelta = Math.floor(clickX / cellWidth);
        const dur = cellsDeltaToDuration(cellsDelta, this.props.scale);
        const clickDate = (this._extendedTimeStart || this.props.model.data.timeStart).plus(dur);

        // Find which row was clicked to determine the group
        const row = ev.target.closest(".o_gantt_timeline_row");
        const defaults = {};
        const dateStartField = this.props.archInfo.dateStart || "date_start";
        defaults[`default_${dateStartField}`] = clickDate.toFormat("yyyy-MM-dd HH:mm:ss");

        if (this.props.onAddTask) {
            this.props.onAddTask(defaults);
        }
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
        if (!data?.timeStart || !data.timeStart.isValid || !this._isValidDt(record._dateDeadline)) return "display: none;";

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
        return record._dateDeadline.toFormat("yyyy/M/d");
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
        if (!data?.timeStart || !data.timeStart.isValid || !this._isValidDt(record._dateDone)) return "display: none;";
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

        // Horizontal scroll: center the bar in the visible area
        // (viewport minus inspector panel width)
        const barLeftPx = this._dateToPx(record._dateStart);
        const barRightPx = record._dateEnd ? this._dateToPx(record._dateEnd) : barLeftPx;
        const barCenter = (barLeftPx + barRightPx) / 2;
        const inspectorWidth = 320;
        const visibleWidth = timeline.clientWidth - inspectorWidth;
        timeline.scrollLeft = barCenter - visibleWidth / 2;

        // Vertical scroll: find the row in the timeline
        const timelineData = this.timelineDataRef.el;
        if (timelineData) {
            const barEl = timelineData.querySelector(`[data-record-id="${record.id}"]`);
            if (barEl) {
                const rowEl = barEl.closest(".o_gantt_timeline_row");
                if (rowEl) {
                    timeline.scrollTop = rowEl.offsetTop - timeline.clientHeight / 2;
                }
            }
        }

        // Select + open inspector
        this.state.selectedRowId = record.id;
        if (this.props.onInspectorOpen) {
            this.props.onInspectorOpen(record.id);
        }
    }

    // -------------------------------------------------------------------------
    // Info column helpers (duration + date range)
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Constraint date marker (visual indicator on timeline)
    // -------------------------------------------------------------------------

    hasConstraintDate(record) {
        const typeField = this.props.archInfo.constrainType || "constrain_type";
        const dateField = this.props.archInfo.constrainDate || "constrain_date";
        const type = record[typeField];
        if (!type || type === "asap" || type === "alap") return false;
        const dateVal = record[dateField];
        return !!dateVal;
    }

    getConstraintDateStyle(record) {
        const data = this.props.model.data;
        const dateField = this.props.archInfo.constrainDate || "constrain_date";
        const dateVal = record[dateField];
        if (!data?.timeStart || !data.timeStart.isValid || !dateVal) return "display: none;";
        const dt = typeof dateVal === "string"
            ? DateTime.fromSQL(dateVal.replace("T", " "))
            : dateVal;
        if (!dt || !dt.isValid) return "display: none;";
        const left = this._dateToPx(dt);
        return `left: ${left}px;`;
    }

    getConstraintDateTitle(record) {
        const typeField = this.props.archInfo.constrainType || "constrain_type";
        const dateField = this.props.archInfo.constrainDate || "constrain_date";
        const type = record[typeField];
        const dateVal = record[dateField];
        const labels = {
            snet: "\u4E0D\u65E9\u65BC\u958B\u59CB", snlt: "\u4E0D\u665A\u65BC\u958B\u59CB",
            fnet: "\u4E0D\u65E9\u65BC\u5B8C\u6210", fnlt: "\u4E0D\u665A\u65BC\u5B8C\u6210",
            mso: "\u5FC5\u9808\u958B\u59CB\u65BC", mfo: "\u5FC5\u9808\u5B8C\u6210\u65BC",
        };
        const typeLabel = labels[type] || (type || "").toUpperCase();
        let dateStr = "";
        if (dateVal) {
            const dt = typeof dateVal === "string"
                ? DateTime.fromSQL(dateVal.replace("T", " "))
                : dateVal;
            if (dt && dt.isValid) dateStr = dt.toFormat("M/d HH:mm");
        }
        return `${typeLabel}: ${dateStr}`;
    }

    /**
     * Check if a value is a valid Luxon DateTime.
     */
    _isValidDt(dt) {
        return dt && typeof dt === "object" && dt.isValid !== false && typeof dt.toFormat === "function";
    }

    getInfoDuration(record) {
        // Use summary dates for parent tasks
        const dateStart = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const dateEnd = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (this._isValidDt(dateStart) && this._isValidDt(dateEnd)
            && !record._isVirtualDates) {
            const days = dateEnd.diff(dateStart, "days").days;
            if (Number.isFinite(days)) return this._humanizeDuration(days);
        }
        // Fallback: plan_duration (planning mode or no actual dates)
        if (record._planDuration && record._planDuration > 0) {
            return this.formatDurationChinese(record._planDuration);
        }
        return "";
    }

    getInfoDateRange(record) {
        // Use summary dates for parent tasks
        const ds = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const de = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (!this._isValidDt(ds)) return "";
        const start = ds.toFormat("M/d");
        if (!this._isValidDt(de)) return start;
        const end = de.toFormat("M/d");
        return `${start}-${end}`;
    }

    getInfoStartDate(record) {
        const dt = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        if (!this._isValidDt(dt)) return "";
        return dt.toFormat("M/d");
    }

    getInfoEndDate(record) {
        const dt = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (!this._isValidDt(dt)) return "";
        return dt.toFormat("M/d");
    }

    _humanizeDuration(days) {
        if (!Number.isFinite(days) || days <= 0) return "0\u5929";
        if (days < 1) {
            const hours = Math.round(days * 24);
            return `${hours}\u6642`;
        }
        if (days < 7) {
            return `${Math.round(days * 10) / 10}\u5929`;
        }
        if (days < 30) {
            const weeks = Math.floor(days / 7);
            const remain = Math.round(days % 7);
            return remain > 0 ? `${weeks}\u9031${remain}\u5929` : `${weeks}\u9031`;
        }
        const months = Math.floor(days / 30);
        const remainDays = Math.round(days % 30);
        return remainDays > 0 ? `${months}\u6708${remainDays}\u5929` : `${months}\u6708`;
    }

    // -------------------------------------------------------------------------
    // Planning Mode: Duration formatting & editing
    // -------------------------------------------------------------------------

    formatDurationChinese(hours) {
        if (!hours || hours <= 0) return "";
        const d = Math.floor(hours / 24);
        const h = Math.floor(hours % 24);
        const m = Math.round((hours % 1) * 60) % 60;
        const parts = [];
        if (d > 0) parts.push(`${d}\u5929`);
        if (h > 0) parts.push(`${h}\u5c0f\u6642`);
        if (m > 0) parts.push(`${m}\u5206\u9418`);
        return parts.join("") || "0\u5c0f\u6642";
    }

    _hoursToInputFormat(hours) {
        if (!hours) return "";
        const d = Math.floor(hours / 24);
        const h = Math.floor(hours % 24);
        const m = Math.round((hours % 1) * 60) % 60;
        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        return parts.join("") || "0d";
    }

    parseDurationInput(text) {
        const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/gi;
        let totalHours = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const val = parseFloat(match[1]);
            switch (match[2].toLowerCase()) {
                case "d": totalHours += val * 24; break;
                case "h": totalHours += val; break;
                case "m": totalHours += val / 60; break;
                case "s": totalHours += val / 3600; break;
            }
        }
        return totalHours;
    }

    onDurationClick(record, ev) {
        const infoEl = ev.target.closest(".o_gantt_duration_cell") || ev.target.closest(".o_gantt_task_info");
        if (!infoEl) return;
        ev.stopPropagation();
        this._startDurationEdit(record.id, infoEl);
    }

    _startDurationEdit(recordId, el) {
        const record = this.props.model.data?.records?.find(r => r.id === recordId);
        const currentHours = record?._planDuration || 0;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "o_gantt_duration_input";
        input.placeholder = "1d3h30m";
        input.value = this._hoursToInputFormat(currentHours);
        const rect = el.getBoundingClientRect();
        input.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
            `width:${Math.max(rect.width, 80)}px;height:${rect.height}px;z-index:1000;`;
        document.body.appendChild(input);
        input.focus();
        input.select();

        const finish = async (save) => {
            if (save) {
                const hours = this.parseDurationInput(input.value);
                if (hours > 0 && hours !== currentHours) {
                    await this.props.model.updatePlanDuration(recordId, hours);
                    if (this.props.onReload) await this.props.onReload();
                }
            }
            input.remove();
        };
        input.addEventListener("blur", () => finish(true), { once: true });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); input.blur(); }
            if (e.key === "Escape") {
                input.removeEventListener("blur", () => {});
                finish(false);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Planning Mode: Clear schedule (back to planning mode)
    // -------------------------------------------------------------------------

    async onClearScheduleClick(group, ev) {
        ev.stopPropagation();
        const clearTasks = confirm(
            "是否同步清除所有任務日期？\n" +
            "確定 = 清除任務日期（回到計劃模式）\n" +
            "取消 = 僅清除專案日期"
        );
        // Clear schedule dates (schedule_start/schedule_end)
        await this.props.model.clearProjectScheduleDates(group.id, clearTasks);
        // Also clear planned dates (date_start/date)
        const groupModel = this.props.archInfo.mainGroupModel;
        if (groupModel) {
            await this.props.model.orm.write(groupModel, [group.id], {
                date_start: false,
                date: false,
            });
            group._projectDateStart = false;
            group._projectDateEnd = false;
        }
        if (this.props.onReload) await this.props.onReload();
    }

    /**
     * Check if a group (project) is in planning mode.
     */
    isGroupPlanningMode(group) {
        return group._isPlanningMode === true;
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
        const colorIdx = loadBar.color || 0;
        if (colorIdx > 0 && colorIdx < GANTT_COLORS.length) {
            bg = `background: ${GANTT_COLORS[colorIdx]};`;
        }

        return `left: ${left}px; width: ${width}px; ${bg}`;
    }

    // -------------------------------------------------------------------------
    // Round 3 Feature 13: Column header hints
    // -------------------------------------------------------------------------

    getColumnHint(column) {
        const scale = this.props.scale;
        if (scale === "day") {
            return column.date.toFormat("yyyy/M/d");
        }
        if (scale === "week") {
            const end = column.date.endOf("week");
            return `${column.date.toFormat("M/d")} - ${end.toFormat("M/d")}`;
        }
        if (scale === "month" || scale === "quarter") {
            return column.date.toFormat("yyyy\u5E74M\u6708");
        }
        // Sub-day scales
        return column.date.toFormat("M/d HH:mm");
    }

    // -------------------------------------------------------------------------
    // Round 3 Feature 15: Project bar indicators
    // -------------------------------------------------------------------------

    getGroupProgress(group) {
        if (!group.records || group.records.length === 0) return 0;
        let total = 0;
        let count = 0;
        for (const record of group.records) {
            // Only count top-level tasks to avoid double-counting
            if (record._parentId && group.records.some(r => r.id === record._parentId)) continue;
            if (record._isMilestoneRecord) continue;
            const p = record._hasChildren
                ? (record._summaryProgress ?? 0)
                : (record._progress ?? 0);
            total += p;
            count++;
        }
        return count > 0 ? Math.round(total / count) : 0;
    }

    getGroupProgressStyle(group) {
        const progress = this.getGroupProgress(group);
        return `width: ${Math.min(progress, 100)}%;`;
    }

    getGroupDateRange(group) {
        const start = group._projectDateStart;
        const end = group._projectDateEnd;
        if (!start && !end) return "";
        // date_start / date are Date strings "YYYY-MM-DD"
        const fmtDate = (d) => {
            if (!d) return "";
            const parts = d.split("-");
            return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
        };
        const s = fmtDate(start);
        const e = fmtDate(end);
        if (s && e) return `${s} - ${e}`;
        return s || e;
    }

    onGroupDateRangeClick(group, ev) {
        ev.stopPropagation();
        const start = group._projectDateStart;
        const end = group._projectDateEnd;
        // Parse "YYYY-MM-DD" strings to Luxon DateTime (or null)
        const startDt = start ? DateTime.fromISO(start) : DateTime.now();
        const endDt = end ? DateTime.fromISO(end) : startDt.plus({ months: 1 });
        this._datePickerGroup = group;
        this._datePickerProps.value = markRaw([startDt, endDt]);
        this._datePickerProps.focusedDateIndex = 0;
        this.dateRangePopover.open(ev.currentTarget, {
            pickerProps: this._datePickerProps,
        });
    }

    async _onDateRangePopoverClose() {
        const group = this._datePickerGroup;
        if (!group) return;
        this._datePickerGroup = null;
        let [startDt, endDt] = this._datePickerProps.value || [false, false];
        // Ensure start <= end
        if (startDt && endDt && startDt > endDt) {
            [startDt, endDt] = [endDt, startDt];
        }
        // Format back to "YYYY-MM-DD" for Odoo Date field
        const startStr = startDt && startDt.isValid ? startDt.toFormat("yyyy-MM-dd") : false;
        const endStr = endDt && endDt.isValid ? endDt.toFormat("yyyy-MM-dd") : false;
        // Skip if unchanged
        if (startStr === (group._projectDateStart || false) &&
            endStr === (group._projectDateEnd || false)) {
            return;
        }
        const groupModel = this.props.archInfo.mainGroupModel;
        if (!groupModel) return;
        // Write planned dates (date_start / date)
        await this.props.model.orm.write(groupModel, [group.id], {
            date_start: startStr,
            date: endStr,
        });
        // Update local state
        group._projectDateStart = startStr;
        group._projectDateEnd = endStr;
        // Trigger auto-scheduler: set schedule_start to kick off forward scheduling
        if (startStr) {
            await this.props.model.setProjectScheduleStart(group.id, startStr);
        }
        if (this.props.onReload) await this.props.onReload();
    }

    getGroupBarStyle(group) {
        const data = this.props.model.data;
        if (!data?.timeStart || !data.timeStart.isValid || !group.records?.length) return "display: none;";

        let minDate = null;
        let maxDate = null;
        for (const record of group.records) {
            if (this._isValidDt(record._dateStart) && (!minDate || record._dateStart < minDate)) {
                minDate = record._dateStart;
            }
            if (this._isValidDt(record._dateEnd) && (!maxDate || record._dateEnd > maxDate)) {
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
            .filter(r => this._isValidDt(r._dateStart) && this._isValidDt(r._dateEnd))
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
        const colorField = this.props.archInfo.colorGantt;
        if (colorField) {
            const idx = record[colorField] || 0;
            if (idx > 0 && idx < GANTT_COLORS.length) {
                return GANTT_COLORS[idx];
            }
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

        // Group by date (day), sum duration — prefer date_aggr over dateStart
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
            let dt = DateTime.fromSQL(dateStr);
            if (!dt.isValid) dt = DateTime.fromISO(dateStr);
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
        const ds = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const de = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (!ds || !de) return "";
        const diff = de.diff(ds, ["days", "hours"]);
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
