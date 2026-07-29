/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount, onPatched, onWillPatch, onWillRender, markRaw, reactive } from "@odoo/owl";
import { useOwnedDialogs, useService } from "@web/core/utils/hooks";
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
import { useGanttMarquee } from "./gantt_marquee_hook";
import { cellsDeltaToDuration, toOdooDatetime, humanizeHours } from "./gantt_utils";
import { GanttArrows } from "./gantt_arrows";
import { GanttTooltip } from "./gantt_tooltip";
import { GanttContextMenu } from "./gantt_context_menu";
import { GanttScrollMap } from "./gantt_scrollmap";
import { GanttInspector, GANTT_COLORS } from "./gantt_inspector";
import { GanttAltView } from "./gantt_alt_views";
import { ActivityListPopover } from "@mail/core/web/activity_list_popover";

const { DateTime } = luxon;

/** Fixed reference date for planning mode virtual timeline (T+0). */
const PLANNING_T0 = DateTime.fromObject({ year: 2000, month: 1, day: 1 });

export class GanttRenderer extends Component {
    static template = "dobtor_project.GanttRenderer";
    static components = { GanttArrows, GanttTooltip, GanttContextMenu, GanttScrollMap, GanttInspector, GanttAltView };

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
        // Calendar
        hideNonWorkingDays: { type: Boolean, optional: true },
    };

    // Minimum visible bar width in px (clamp for sub-cell durations) and the
    // fallback width for tasks without an end date. Shared by _computeBarGeometry
    // so the rendered bar and the dependency arrows agree on the visual edges.
    // Minimum painted width for a task bar.
    //
    // Every pixel a short bar is widened by is a pixel its right edge overshoots
    // the task's real end — and that edge is where its FS successor's connector
    // has to leave from. At 20px a 4–5 hour task on the day scale (6.7–8.3px of
    // real width) overshot its successor's start by ~12px, which left the
    // connector no forward room at all and collapsed the 45° exit into a plain
    // vertical (6 of this project's 28 links). 12px is the largest value that
    // keeps every link's chamfer drawable; the resize handles stay usable via
    // their max-width rule, which never lets them eat the whole bar.
    static MIN_BAR_W = 12;
    static NO_END_BAR_W = 50;
    // Minimum width for secondary mini-bars (ghost / load / intersection) that
    // are not arrow targets and may legitimately be narrower than a task bar.
    static MIN_MINIBAR_W = 4;

    setup() {
        this.displayDialog = useOwnedDialogs();
        // Cache services once (adds the component-destroyed guard vs. reaching
        // into this.env.services.* on every call).
        this.notification = useService("notification");
        this.actionService = useService("action");
        // Stable bound reference so child components (tooltip / context menu)
        // receive the same getRecord function every render (preserves their
        // props memoization) and use the model's O(1) lookup instead of an
        // O(n) .find() over the records array.
        this.getModelRecord = (id) => this.props.model.getRecord(id);
        // Stable reference so GanttArrows props keep their identity across
        // renders (otherwise a fresh arrow fn every render defeats memoization).
        this._boundDateToPx = (dt) => this._dateToPx(dt);
        // Single source of truth for bar edges, shared with GanttArrows so arrow
        // endpoints attach to the bar's *visual* edge (post clamp/fallback/drag).
        this._boundBarGeom = (record) => this._computeBarGeometry(record);

        // Publish the canonical task colour palette (JS GANTT_COLORS, the single
        // source of truth) as CSS variables so the SCSS swatches (.o_gantt_color_N)
        // no longer hard-code their own copy.
        const _root = document.documentElement;
        GANTT_COLORS.forEach((c, i) => {
            if (i > 0 && c) _root.style.setProperty(`--gantt-palette-${i}`, c);
        });
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
                    clearMultiSelect: () => { this.state.selectedRowIds = {}; },
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

        // Activity popover (for activity_ids clock button)
        this.activityPopover = usePopover(ActivityListPopover, { position: "bottom-start" });

        // Restore gutter widths from localStorage
        const savedGutterWidth = parseInt(localStorage.getItem("gantt_gutter_width"), 10);
        const savedDurationWidth = parseInt(localStorage.getItem("gantt_duration_width"), 10);

        // Optional outline columns the user can show/hide (OmniPlan-style column
        // chooser). Persisted per browser.
        this.OPTIONAL_COLUMNS = [
            { key: "duration", label: _t("工期") },
            { key: "progress", label: _t("進度") },
            { key: "resource", label: _t("資源") },
        ];
        let savedCols = [];
        try {
            savedCols = JSON.parse(localStorage.getItem("gantt_optional_cols") || "[]");
            if (!Array.isArray(savedCols)) savedCols = [];
        } catch (_e) {
            savedCols = [];
        }

        this.state = useState({
            gutterWidth: (savedGutterWidth > 0) ? savedGutterWidth : 300,
            durationWidth: (savedDurationWidth > 0) ? savedDurationWidth : 80,
            selectedRowId: null,
            selectedRowIds: {},
            stateMenuRecordId: null,
            constraintTooltipId: null,
            constraintTooltipStyle: "",
            optionalCols: savedCols,
            showColMenu: false,
            viewMode: "gantt",  // "gantt" | "resource" | "network" | "calendar"
        });

        // Reactive drag state for live arrow updates via OWL re-render
        // Live gesture state shared by BOTH the bar rendering (getBarStyle) and
        // the dependency arrows, so a re-render mid-drag/resize never desyncs
        // them. ids: {id: true} of bars being moved; deltaLeft/deltaRight: px
        // offsets applied to each bar's left/right edge (drag moves both edges
        // equally, left-resize moves only left, right-resize only right).
        this._dragState = useState({ ids: {}, deltaLeft: 0, deltaRight: 0 });

        // Cell width per column unit for each scale
        this.cellWidths = {
            "1h": 60,      // px per 1-hour column
            "2h": 60,      // px per 2-hour column
            "4h": 60,      // px per 4-hour column
            "8h": 60,      // px per 8-hour column
            day: 40,        // px per day column
            week: 120,      // px per week column
            month: 180,     // px per month column
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
            getRecord: (id) => this.props.model.getRecord(id),
            getCalHpd: () => this._calHpd,
            getCalDpw: () => this._calDpw,
            // Shift a date by cellsDelta, respecting working days/hours
            shiftDate: (dt, cellsDelta) => {
                if (this._isHidingNonWorking()) {
                    return this._addWorkingUnits(dt, cellsDelta);
                }
                return dt.plus(cellsDeltaToDuration(cellsDelta, this.props.scale));
            },
            getMinStart: (id) => {
                const rec = this.props.model.getRecord(id);
                if (rec && rec._hasChildren) {
                    return this.props.model.getMinStartForParentDrag(id);
                }
                return this.props.model.getMinStartForRecord(id);
            },
            getMinMilestoneDate: (id) => this.props.model.getMinDateForMilestone(id),
            onBoundaryHit: (id) => {
                const info = this.props.model.getBlockingFsInfo(id);
                if (info) {
                    this.notification.add(info.message, {
                        type: "warning",
                        sticky: false,
                    });
                }
            },
            // Live update during drag — drives both the bar and its arrows.
            onDragMove: (recordId, deltaX) => {
                // Multi-select drag moves every selected bar together.
                const sel = this.state.selectedRowIds || {};
                const selIds = Object.keys(sel).filter(k => sel[k]).map(Number);
                const ids = {};
                if (sel[recordId] && selIds.length > 1) {
                    for (const id of selIds) ids[id] = true;
                } else {
                    ids[recordId] = true;
                }
                this._dragState.ids = ids;
                this._dragState.deltaLeft = deltaX;
                this._dragState.deltaRight = deltaX;
            },
            // Non-committing exit (snap-back / cancel): drop the live offset.
            onGestureCancel: () => this._clearGesture(),
            onDragEnd: async (recordId, cellsDelta) => {
              // Keep the live offset applied through the (awaited) server move so
              // the bar doesn't flash back to its pre-drag position; clear it in
              // finally once the new dates are in.
              try {
                const record = this.props.model.getRecord(recordId);
                if (!record) return;

                const useWorkingMove = this._isHidingNonWorking();
                const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);

                // --- Parent task: move with all descendants ---
                if (record._hasChildren) {
                    const summaryStart = record._summaryDateStart || record._dateStart;
                    if (!summaryStart) return;
                    let newStart = useWorkingMove
                        ? this._addWorkingUnits(summaryStart, cellsDelta)
                        : summaryStart.plus(shiftDur);
                    // Clamp to FS predecessor constraints (own + all descendants)
                    const minStart = this.props.model.getMinStartForParentDrag(recordId);
                    if (minStart && newStart < minStart) {
                        newStart = minStart;
                    }
                    let shiftHours = newStart.diff(summaryStart, "hours").hours;
                    // Virtual timeline hours must be converted to working hours for the backend
                    if (record._isVirtualDates) {
                        const scaleFactor = this._scaleFactor;
                        shiftHours = shiftHours / scaleFactor;
                    }
                    if (Math.abs(shiftHours) < 0.01) return;
                    await this.props.model.moveAndCascade(recordId, null, shiftHours);
                    return;
                }

                // --- Milestone: update deadline_datetime ---
                if (record._isMilestoneRecord) {
                    let newDate = useWorkingMove && record._dateStart
                        ? this._addWorkingUnits(record._dateStart, cellsDelta)
                        : (record._dateStart ? record._dateStart.plus(shiftDur) : null);
                    // Clamp to linked tasks' end dates
                    const minDate = this.props.model.getMinDateForMilestone(recordId);
                    if (minDate && newDate && newDate < minDate) {
                        newDate = minDate;
                    }
                    if (newDate) {
                        await this.props.model.updateRecord(recordId, {
                            deadline_datetime: newDate.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss"),
                        });
                    }
                    if (this.props.onReload) await this.props.onReload();
                    return;
                }

                // --- Leaf task: existing logic ---
                // Clamp: start never before predecessor's end or parent's start
                const minStart = this.props.model.getMinStartForRecord(recordId);

                if (record._isVirtualDates) {
                    // Planning mode: drag delta is in virtual timeline units,
                    // divide by scaleFactor to convert back to working hours
                    const scaleFactor = this._scaleFactor;
                    // Convert duration to hours directly (avoid epoch-based month inaccuracy)
                    const shiftHours = (shiftDur.hours || 0) + (shiftDur.days || 0) * 24
                        + (shiftDur.weeks || 0) * 168 + (shiftDur.months || 0) * 720;
                    const shiftWorkingHours = shiftHours / scaleFactor;
                    let newOffset = Math.max(0, (record._planOffset || 0) + shiftWorkingHours);
                    // Clamp to FS predecessor end
                    if (minStart) {
                        const T0 = PLANNING_T0;
                        const minVirtualHours = minStart.diff(T0, "hours").hours;
                        const minOffsetWorking = minVirtualHours / scaleFactor;
                        if (newOffset < minOffsetWorking) newOffset = minOffsetWorking;
                    }
                    const planOffsetField = this.props.archInfo.planOffset || "plan_offset";
                    await this.props.model.moveAndCascade(recordId, { [planOffsetField]: newOffset });
                } else if (record._scheduleMode === "auto") {
                    // Auto mode: convert drag to SNET constraint instead of overwriting dates
                    let newStart = useWorkingMove && record._dateStart
                        ? this._addWorkingUnits(record._dateStart, cellsDelta)
                        : (record._dateStart ? record._dateStart.plus(shiftDur) : null);
                    if (minStart && newStart && newStart < minStart) {
                        newStart = minStart;
                    }
                    if (newStart) {
                        const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
                        const constrainDateField = this.props.archInfo.constrainDate || "constrain_date";
                        await this.props.model.updateRecord(recordId, {
                            [constrainTypeField]: "snet",
                            [constrainDateField]: newStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss"),
                        });
                    }
                } else {
                    // Manual mode: update actual dates
                    const dateStartField = this.props.archInfo.dateStart || "date_start";
                    const dateStopField = this.props.archInfo.dateStop || "date_end";
                    if (this._isFieldReadonly(dateStartField) || this._isFieldReadonly(dateStopField)) {
                        this.notification.add(
                            _t("無法修改：日期欄位為唯讀"),
                            { type: "warning" }
                        );
                        return;
                    }
                    let newStart = useWorkingMove && record._dateStart
                        ? this._addWorkingUnits(record._dateStart, cellsDelta)
                        : (record._dateStart ? record._dateStart.plus(shiftDur) : null);
                    // Clamp to FS predecessor end
                    if (minStart && newStart && newStart < minStart) {
                        newStart = minStart;
                    }
                    const values = {};
                    if (newStart) {
                        values[dateStartField] = newStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    if (record._dateEnd && record._dateStart) {
                        const duration = record._dateEnd.diff(record._dateStart);
                        values[dateStopField] = (newStart || record._dateStart).plus(duration).setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    await this.props.model.moveAndCascade(recordId, values, null);
                }
              } finally {
                this._clearGesture();
              }
            },
            // Lag preview: compute FS predecessor lag changes during drag
            getPredLagPreview: (recId, cellsDelta) => {
                return this._computePredLagPreview(recId, cellsDelta, "both");
            },
            // Vertical reorder: drag bar up/down to reorder tasks
            onVerticalReorder: async (recordId, targetId, position) => {
                await this.props.model.reorderRecord(recordId, targetId, position);
                // No reload — model handles optimistic local update internally
            },
            // Item 10: Multi-select drag callbacks
            getSelectedIds: () => {
                const ids = this.state.selectedRowIds || {};
                return Object.keys(ids).filter(k => ids[k]).map(Number);
            },
            onMultiDragEnd: async (recordIds, cellsDelta) => {
                // Keep the live offset through the awaited move, clear in finally
                // so the bars settle on their new dates (not a stale _dragState).
                try {
                    const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
                    // Convert duration to hours
                    let shiftHours = (shiftDur.hours || 0) + (shiftDur.days || 0) * 24
                        + (shiftDur.weeks || 0) * 168 + (shiftDur.months || 0) * 720;
                    // If hiding non-working days, use working-hour conversion
                    if (this._isHidingNonWorking()) {
                        const scaleFactor = this._scaleFactor;
                        shiftHours = shiftHours / scaleFactor;
                    }
                    await this.props.model.moveMultipleRecords(recordIds, shiftHours);
                } finally {
                    this._clearGesture();
                }
            },
            getFlattenedRows: () => this.flattenedRows,
            getListEl: () => this.listRowsRef.el,
        });

        // --- Hook: Bar resize ---
        useGanttBarResize({
            getTimelineEl: () => this.timelineDataRef.el,
            getCellWidth: () => this.cellWidth,
            getScale: () => this.props.scale,
            getRecord: (id) => this.props.model.getRecord(id),
            getCalHpd: () => this._calHpd,
            getCalDpw: () => this._calDpw,
            getMinEnd: (id) => this.props.model.getMinEndForRecord(id),
            shiftDate: (dt, cellsDelta) => {
                if (this._isHidingNonWorking()) {
                    return this._addWorkingUnits(dt, cellsDelta);
                }
                return dt.plus(cellsDeltaToDuration(cellsDelta, this.props.scale));
            },
            // Live update during resize — moves only the dragged edge so the
            // arrows attached to that edge track it in real time.
            onResizeMove: (recordId, side, delta) => {
                this._dragState.ids = { [recordId]: true };
                this._dragState.deltaLeft = side === "left" ? delta : 0;
                this._dragState.deltaRight = side === "right" ? delta : 0;
            },
            // Non-committing exit (snap-back / cancel): drop the live offset so
            // OWL re-renders the bar (and its arrows) back to the record dates.
            onGestureCancel: () => this._clearGesture(),
            onResizeEnd: async (recordId, side, cellsDelta) => {
              // Keep the live offset through the awaited server resize, clear in
              // finally so the bar doesn't flash back to its pre-resize size.
              try {
                const record = this.props.model.getRecord(recordId);
                if (!record) return;

                // Constraint for left-side resize: FS/SS/FF/SF predecessors
                const minStart = (side === "left")
                    ? this.props.model.getMinStartForRecord(recordId)
                    : null;
                // Constraint for right-side resize: FF/SF predecessors
                const minEnd = (side === "right")
                    ? this.props.model.getMinEndForRecord(recordId)
                    : null;

                if (record._isVirtualDates) {
                    // Planning mode: resize delta is in virtual timeline units,
                    // divide by scaleFactor to convert back to working hours
                    const scaleFactor = this._scaleFactor;
                    const minDuration = this._calHpd; // Minimum 1 working day
                    const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
                    // Convert duration to hours directly (avoid epoch-based month inaccuracy)
                    const shiftHours = (shiftDur.hours || 0) + (shiftDur.days || 0) * 24
                        + (shiftDur.weeks || 0) * 168 + (shiftDur.months || 0) * 720;
                    const shiftWorkingHours = shiftHours / scaleFactor;
                    if (side === "right") {
                        let newDuration = Math.max(minDuration, (record._planDuration || this._calHpd) + shiftWorkingHours);
                        // Clamp to FF/SF predecessor min end
                        if (minEnd) {
                            const T0 = PLANNING_T0;
                            const minEndVirtualHours = minEnd.diff(T0, "hours").hours;
                            const minEndWorking = minEndVirtualHours / scaleFactor;
                            const currentOffset = record._planOffset || 0;
                            const minDur = Math.max(minDuration, minEndWorking - currentOffset);
                            if (newDuration < minDur) {
                                newDuration = minDur;
                            }
                        }
                        const planDurField = this.props.archInfo.planDuration || "plan_duration";
                        await this.props.model.moveAndCascade(recordId, { [planDurField]: newDuration });
                    } else {
                        // Left resize: adjust both offset and duration
                        let newOffset = Math.max(0, (record._planOffset || 0) + shiftWorkingHours);
                        let newDuration = Math.max(minDuration, (record._planDuration || this._calHpd) - shiftWorkingHours);
                        // Clamp to FS predecessor end
                        if (minStart) {
                            const T0 = PLANNING_T0;
                            const minVirtualHours = minStart.diff(T0, "hours").hours;
                            const minOffsetWorking = minVirtualHours / scaleFactor;
                            if (newOffset < minOffsetWorking) {
                                newDuration = Math.max(minDuration, newDuration - (minOffsetWorking - newOffset));
                                newOffset = minOffsetWorking;
                            }
                        }
                        const planDurationField = this.props.archInfo.planDuration || "plan_duration";
                        const planOffsetField = this.props.archInfo.planOffset || "plan_offset";
                        await this.props.model.moveAndCascade(recordId, {
                            [planOffsetField]: newOffset,
                            [planDurationField]: newDuration,
                        });
                    }
                } else if (record._scheduleMode === "auto" && side === "right") {
                    // Auto mode + right resize: modify plan_duration (duration change only)
                    const useWorkingMove = this._isHidingNonWorking();
                    const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
                    let newEnd = useWorkingMove
                        ? this._addWorkingUnits(record._dateEnd, cellsDelta)
                        : record._dateEnd.plus(shiftDur);
                    // Clamp to FF/SF predecessor min end
                    if (minEnd && newEnd < minEnd) {
                        newEnd = minEnd;
                    }
                    if (!newEnd || !record._dateStart || newEnd <= record._dateStart) return;
                    const newDurationHours = newEnd.diff(record._dateStart, "hours").hours;
                    const planDurField = this.props.archInfo.planDuration || "plan_duration";
                    await this.props.model.moveAndCascade(recordId, { [planDurField]: newDurationHours });
                } else {
                    // Normal mode: update actual dates
                    const dateStartField = this.props.archInfo.dateStart || "date_start";
                    const dateStopField = this.props.archInfo.dateStop || "date_end";
                    const checkField = side === "left" ? dateStartField : dateStopField;
                    if (this._isFieldReadonly(checkField)) {
                        this.notification.add(
                            _t("無法修改：日期欄位為唯讀"),
                            { type: "warning" }
                        );
                        return;
                    }
                    const useWorkingMove = this._isHidingNonWorking();
                    const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
                    const values = {};
                    if (side === "left" && record._dateStart) {
                        let newStart = useWorkingMove
                            ? this._addWorkingUnits(record._dateStart, cellsDelta)
                            : record._dateStart.plus(shiftDur);
                        // Clamp to FS predecessor end
                        if (minStart && newStart < minStart) {
                            newStart = minStart;
                        }
                        values[dateStartField] = newStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    } else if (side === "right" && record._dateEnd) {
                        let newEnd = useWorkingMove
                            ? this._addWorkingUnits(record._dateEnd, cellsDelta)
                            : record._dateEnd.plus(shiftDur);
                        // Clamp to FF/SF predecessor min end
                        if (minEnd && newEnd < minEnd) {
                            newEnd = minEnd;
                        }
                        values[dateStopField] = newEnd.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    await this.props.model.moveAndCascade(recordId, values, null);
                }
              } finally {
                this._clearGesture();
              }
            },
            // Lag preview: compute FS predecessor lag changes during resize
            getPredLagPreview: (recId, cellsDelta, resizeSide) => {
                return this._computePredLagPreview(recId, cellsDelta, resizeSide === "left" ? "incoming" : "outgoing");
            },
            onConstraintSet: async (recordId, constrainType, constrainDate) => {
                // Constraint mode doesn't move the bar — drop the live offset so
                // the bar snaps back to its date-derived position (and isn't left
                // shifted by a stale _dragState after reload).
                try {
                    const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
                    const constrainDateField = this.props.archInfo.constrainDate || "constrain_date";
                    await this.props.model.updateRecord(recordId, {
                        [constrainTypeField]: constrainType,
                        [constrainDateField]: constrainDate,
                    });
                    if (this.props.onReload) await this.props.onReload();
                } finally {
                    this._clearGesture();
                }
            },
        });

        // --- Hook: Deadline drag ---
        useGanttDeadlineDrag({
            getTimelineEl: () => this.timelineDataRef.el,
            getCellWidth: () => this.cellWidth,
            getScale: () => this.props.scale,
            getTimeStart: () => this.props.model.data?.timeStart,
            getRecord: (id) => this.props.model.getRecord(id),
            onDragEnd: async (recordId, cellsDelta) => {
                const record = this.props.model.getRecord(recordId);
                if (!record || !record._dateDeadline) return;
                const deadlineField = this.props.archInfo.dateDeadline;
                if (!deadlineField) return;
                if (this._isFieldReadonly(deadlineField)) {
                    this.notification.add(
                        _t("無法修改：截止日欄位為唯讀"),
                        { type: "warning" }
                    );
                    return;
                }
                const useWorkingMove = this._isHidingNonWorking();
                const newDeadline = useWorkingMove
                    ? this._addWorkingUnits(record._dateDeadline, cellsDelta)
                    : record._dateDeadline.plus(cellsDeltaToDuration(cellsDelta, this.props.scale));
                await this.props.model.updateRecord(recordId, {
                    [deadlineField]: newDeadline.toFormat("yyyy-MM-dd"),
                });
                // Recompute milestone positions (deadline may affect visual positioning)
                if (this.props.model._recomputeMilestonePositions) {
                    this.props.model._recomputeMilestonePositions();
                }
            },
        });

        // --- Hook: Tree drag-drop reordering ---
        useGanttTreeDrag({
            getListEl: () => this.listRowsRef.el,
            getRecord: (id) => this.props.model.getRecord(id),
            onReorder: async (recordId, targetId, position) => {
                await this.props.model.reorderRecord(recordId, targetId, position);
                // No reload — model handles optimistic local update internally
            },
        });

        // --- Hook: Arrow draw (create/delete predecessor links) ---
        useGanttArrowDraw({
            getTimelineEl: () => this.timelineDataRef.el,
            getRecord: (id) => this.props.model.getRecord(id),
            onLinkCreated: async (fromId, toId, type) => {
                if (toId < 0) {
                    // Target is a milestone (negative ID)
                    await this.props.model.linkTaskToMilestone(fromId, toId);
                } else if (fromId < 0) {
                    // Source is a milestone — not allowed
                    return;
                } else {
                    // Block links between ancestor-descendant tasks
                    const isAncestor = (aId, dId) => {
                        let r = this.props.model.getRecord(dId);
                        while (r && r._parentId) {
                            if (r._parentId === aId) return true;
                            r = this.props.model.getRecord(r._parentId);
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
            deleteLinkLabel: _t("刪除連結"),
        });

        // --- Hook: Progress drag ---
        useGanttProgressDrag({
            getTimelineEl: () => this.timelineDataRef.el,
            getRecord: (id) => this.props.model.getRecord(id),
            onProgressEnd: async (recordId, newProgress) => {
                const progressField = this.props.archInfo.progress;
                if (!progressField) return;
                if (this._isFieldReadonly(progressField)) {
                    this.notification.add(
                        _t("無法修改：進度欄位為唯讀"),
                        { type: "warning" }
                    );
                    return;
                }
                await this.props.model.updateRecord(recordId, { [progressField]: newProgress });
            },
        });

        // Rubber-band (marquee) selection over empty timeline space.
        useGanttMarquee({
            getTimelineEl: () => this.timelineDataRef.el,
            setSelection: (ids, additive) => this.setSelection(ids, additive),
        });

        // Anchor row for Shift+click range selection.
        this._selectionAnchorId = null;

        // Inline rename state
        this._editingRecordId = null;

        // Scroll position (non-reactive — avoids OWL re-render on every scroll frame)
        this._scrollPos = { scrollLeft: 0, scrollTop: 0, viewportWidth: 0, viewportHeight: 0, totalHeight: 0 };
        // Only the visible range is reactive (triggers re-render when rows enter/leave viewport)
        this._visibleRangeState = useState({ start: 0, end: 0 });

        // Hover tracking via direct DOM manipulation (no OWL re-render)
        this._hoveredId = null;

        // Scroll listener cleanup registry
        this._scrollCleanups = [];

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

        this._lastPanelCount = 0;

        // Track the timeline left-padding (in columns) actually used by each
        // render. extraPaddingCols depends on the measured viewport width, which
        // is 0 on the very first render (→ fallback) and only becomes real after
        // mount. When it later changes, the dateToPx origin (_extendedTimeStart,
        // used by BOTH bars/arrows and the grid) shifts — without this guard the
        // whole timeline lurches sideways on the first drag. We capture the value
        // per render and compensate scrollLeft in onPatched so the view stays put.
        this._renderedExtraPad = null;
        this._prevRenderedExtraPad = null;

        onMounted(() => {
            this._syncScroll();
            this._initScrollTracking();
            document.addEventListener("keydown", this._onRendererKeyDown);
        });

        onWillRender(() => {
            this._prevRenderedExtraPad = this._renderedExtraPad;
            this._renderedExtraPad = this.extraPaddingCols;
            // Start every render from a clean dateToPx cache, and eagerly rebuild
            // the column layout (which also rebuilds _workingDayIndex /
            // _workingHourIndex / _coarseColumns that _dateToPx maps through in
            // hide-non-working-days mode). Doing this BEFORE the template runs
            // guarantees bars, the GanttArrows child and the grid all read the
            // SAME, current index — otherwise, after a layout change, the arrows
            // could pick up a freshly-rebuilt index while the bars kept positions
            // from a stale one, drifting the dependency lines off the bars.
            this._dateToPxCache = null;
            this._barGeomCache = null;
            void this.timelineColumns;
        });

        onWillPatch(() => {
            // Clear per-render caches before each render pass
            this._dateToPxCache = null;
            this._barGeomCache = null;
            this._ghostBarsByTask = null;
            this._loadBarsByTask = null;
            this._recordsByResource = null;
        });

        onPatched(() => {
            // Keep the view visually stable when the timeline left-padding
            // changes (e.g. the first re-render after mount, once the real
            // viewport width is known, or on resize). The padding shifts the
            // dateToPx origin for every bar/arrow/column by the same amount, so
            // we counter it with an equal scrollLeft adjustment — otherwise the
            // whole chart jumps sideways (most visibly on the first drag).
            if (this._prevRenderedExtraPad != null
                && this._renderedExtraPad !== this._prevRenderedExtraPad) {
                const tl = this.timelineRef.el;
                const cw = this.cellWidth;
                if (tl && cw > 0) {
                    const deltaCols = this._renderedExtraPad - this._prevRenderedExtraPad;
                    tl.scrollLeft += deltaCols * cw;
                }
                // Avoid re-triggering on the next, unrelated patch.
                this._prevRenderedExtraPad = this._renderedExtraPad;
            }

            // Re-init scroll sync + tracking when panels are toggled
            const panels = [this.timelineRef.el, this.listRowsRef.el, this.durationRowsRef?.el].filter(Boolean);
            if (panels.length !== this._lastPanelCount) {
                for (const cleanup of this._scrollCleanups) cleanup();
                this._scrollCleanups = [];
                if (this._resizeObserver) {
                    this._resizeObserver.disconnect();
                    this._resizeObserver = null;
                }
                this._syncScroll();
                this._initScrollTracking();
            }
        });

        onWillUnmount(() => {
            document.removeEventListener("keydown", this._onRendererKeyDown);
            for (const cleanup of this._scrollCleanups) cleanup();
            this._scrollCleanups = [];
            if (this._resizeObserver) {
                this._resizeObserver.disconnect();
                this._resizeObserver = null;
            }
            if (this._activeDurationInput) {
                this._activeDurationInput.remove();
                this._activeDurationInput = null;
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
        this._lastPanelCount = panels.length;

        const syncScroll = (source) => {
            if (isSyncing) return;
            isSyncing = true;
            for (const panel of panels) {
                if (panel !== source) {
                    panel.scrollTop = source.scrollTop;
                }
            }
            requestAnimationFrame(() => { isSyncing = false; });
        };

        for (const panel of panels) {
            const handler = () => syncScroll(panel);
            panel.addEventListener("scroll", handler, { passive: true });
            this._scrollCleanups.push(() => panel.removeEventListener("scroll", handler));
        }
    }

    _initScrollTracking() {
        const timeline = this.timelineRef.el;
        if (!timeline) return;

        const updateScroll = () => {
            const prevWidth = this._scrollPos.viewportWidth;
            this._scrollPos.scrollLeft = timeline.scrollLeft;
            this._scrollPos.scrollTop = timeline.scrollTop;
            this._scrollPos.viewportWidth = timeline.clientWidth;
            this._scrollPos.viewportHeight = timeline.clientHeight;
            this._scrollPos.totalHeight = timeline.scrollHeight;
            this._updateVisibleRange();
            // The viewport width drives extraPaddingCols, which is the dateToPx
            // ORIGIN for bars, arrows AND the grid. _scrollPos is non-reactive and
            // starts at 0, so the first render uses a fallback width; once the real
            // width is known (mount) or it changes (resize) we MUST force a full
            // re-render so every element re-lays-out on the same origin together.
            // Without this, only the parts that happen to re-render later (e.g. the
            // arrows on the first drag) pick up the new origin, leaving the
            // dependency lines offset from their bars by extraPaddingCols × cw.
            // (Plain scroll keeps the same width, so this only fires on real
            // width changes — onPatched compensates scrollLeft to avoid a jump.)
            if (timeline.clientWidth !== prevWidth) {
                this.render();
            }
        };

        timeline.addEventListener("scroll", updateScroll, { passive: true });
        this._scrollCleanups.push(() => timeline.removeEventListener("scroll", updateScroll));
        updateScroll();

        if (typeof ResizeObserver !== "undefined") {
            this._resizeObserver = new ResizeObserver(updateScroll);
            this._resizeObserver.observe(timeline);
        }
    }

    // ============================================
    // Virtual Scrolling
    // ============================================
    
    /**
     * Configuration for virtual scrolling
     */
    get _virtualScrollConfig() {
        return {
            rowHeight: 44,        // Height of each row in pixels
            bufferRows: 10,       // Number of extra rows to render above/below viewport
            maxVisibleRows: 100,  // Maximum rows to render (safety limit)
        };
    }

    /**
     * Update the visible row range based on current scroll position.
     * Only triggers OWL re-render when the range actually changes.
     */
    _updateVisibleRange() {
        const allRows = this.flattenedRows;
        const totalRows = allRows.length;

        if (totalRows === 0) {
            if (this._visibleRangeState.start !== 0 || this._visibleRangeState.end !== 0) {
                this._visibleRangeState.start = 0;
                this._visibleRangeState.end = 0;
            }
            return;
        }

        const { rowHeight, bufferRows, maxVisibleRows } = this._virtualScrollConfig;
        const scrollTop = this._scrollPos.scrollTop;
        const viewportHeight = this._scrollPos.viewportHeight || 600;

        let startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - bufferRows);
        const visibleCount = Math.ceil(viewportHeight / rowHeight) + (bufferRows * 2);
        let endIdx = Math.min(totalRows, startIdx + visibleCount);

        if (endIdx - startIdx > maxVisibleRows) {
            endIdx = startIdx + maxVisibleRows;
        }

        // Only update reactive state when range actually changes (avoids unnecessary re-render)
        if (startIdx !== this._visibleRangeState.start || endIdx !== this._visibleRangeState.end) {
            this._visibleRangeState.start = startIdx;
            this._visibleRangeState.end = endIdx;
        }
    }

    /**
     * Get only the rows that should be visible (for virtual scrolling)
     */
    get visibleRows() {
        const allRows = this.flattenedRows;
        const { start, end } = this._visibleRangeState;
        if (end <= start) return allRows;
        return allRows.slice(start, end);
    }

    /**
     * Get the offset style for the first visible row (to maintain scroll position)
     */
    get _virtualScrollOffsetStyle() {
        const { start, end } = this._visibleRangeState;
        // When visibleRows fallback returns all rows (end <= start), no padding needed
        if (end <= start) return "";
        const { rowHeight } = this._virtualScrollConfig;
        const allRows = this.flattenedRows;
        const visibleCount = end - start;
        const bottomPad = Math.max(0, (allRows.length - start - visibleCount) * rowHeight);
        return `padding-top: ${start * rowHeight}px; padding-bottom: ${bottomPad}px;`;
    }

    /**
     * Get the total height style for the scroll container (no-op, height is driven by padding)
     */
    get _virtualScrollTotalHeightStyle() {
        return "";
    }

    /**
     * Check if virtual scrolling should be enabled
     */
    get _shouldUseVirtualScroll() {
        return this.flattenedRows.length > 50;
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

    get _allColumns() {
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

    get timelineColumns() {
        const cols = this._allColumns;
        if (this.props.hideNonWorkingDays && this.props.model.data?.calendarInfo
            && !this.isPlanningMode) {
            const scale = this.props.scale;
            if (scale === "day") {
                const filtered = cols.filter(c => !c.isNonWorking);
                this._rebuildWorkingDayIndex(filtered);
                this._workingHourIndex = null;
                this._workingHourCols = null;
                this._coarseColumns = null;
                return filtered;
            }
            if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
                const filtered = cols.filter(c => !c.isNonWorking);
                this._rebuildWorkingHourIndex(filtered);
                this._workingDayIndex = null;
                this._coarseColumns = null;
                return filtered;
            }
        }
        this._workingDayIndex = null;
        this._workingHourIndex = null;
        this._workingHourCols = null;
        // Cache for week/month column-index-based _dateToPx
        const scale = this.props.scale;
        if (scale === "week" || scale === "month") {
            this._coarseColumns = cols;
        } else {
            this._coarseColumns = null;
        }
        return cols;
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
        // Helper: format planning mode label with correct sign (T+1, T0, T-1)
        const _pl = (prefix, n) => `${prefix}${n > 0 ? "+" : ""}${n}`;

        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            const hours = parseInt(scale);
            let current = start.startOf("hour");
            // Align to hour boundary
            const h = current.hour;
            current = current.set({ hour: h - (h % hours) });
            const inPlanningMode = this.isPlanningMode;
            const T0 = PLANNING_T0;
            while (current <= end) {
                if (inPlanningMode) {
                    const hourOffset = Math.round(current.diff(T0, "hours").hours);
                    const dayOffset = Math.round(current.diff(T0, "days").days);
                    columns.push({
                        date: current,
                        label: _pl("H", hourOffset),
                        weekday: _pl("T", dayOffset),
                        month: "T-hour",
                        isWeekend: false,
                        isToday: false,
                    });
                } else {
                    // Calendar-aware: check if this hour column is non-working
                    const calendarInfo = this.props.model.data?.calendarInfo;
                    const weekdayMap = calendarInfo?._weekdayMap;
                    const leaveDays = calendarInfo?._leaveDays;
                    // Luxon weekday 1=Mon → calendar dayofweek '0'=Mon
                    const calDow = String(current.weekday - 1);
                    const dayAtts = weekdayMap?.[calDow] || [];
                    const colStart = current.hour + current.minute / 60;
                    const colEnd = colStart + hours;
                    // Column overlaps with any work interval?
                    const isInWorkHour = dayAtts.some(
                        att => colStart < att.to && colEnd > att.from
                    );
                    const isLeaveDay = leaveDays?.has(current.toISODate());
                    const isNonWorking = weekdayMap
                        ? (!isInWorkHour || isLeaveDay)
                        : false;
                    columns.push({
                        date: current,
                        label: current.toFormat("HH:mm"),
                        weekday: current.toFormat("M/d"),
                        month: current.toFormat("M/d (EEE)"),
                        isWeekend: current.weekday === 6 || current.weekday === 7,
                        isNonWorking,
                        isToday: current.hasSame(now, "hour") ||
                            (now >= current && now < current.plus({ hours })),
                    });
                }
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
                        label: _pl("T", dayOffset),
                        weekday: "",
                        month: "T-day",
                        isWeekend: false,
                        isToday: false,
                    });
                } else {
                    // Luxon weekday: 1=Mon..7=Sun
                    const isWeekend = current.weekday === 6 || current.weekday === 7;
                    // Calendar-aware: check if this day is a non-working day
                    const calendarInfo = this.props.model.data?.calendarInfo;
                    const workingWeekdays = calendarInfo?._workingWeekdays;
                    const leaveDays = calendarInfo?._leaveDays;
                    const isNonWorking = workingWeekdays
                        ? (!workingWeekdays.has(current.weekday) || (leaveDays && leaveDays.has(current.toISODate())))
                        : false;
                    columns.push({
                        date: current,
                        label: current.toFormat("d"),
                        weekday: current.toFormat("EEE"),
                        month: current.toFormat("yyyy/MM"),
                        isWeekend,
                        isNonWorking,
                        isToday: current.hasSame(now, "day"),
                    });
                }
                current = current.plus({ days: 1 });
            }
        } else if (scale === "week") {
            const inPlanningMode = this.isPlanningMode;
            const T0 = PLANNING_T0;
            if (inPlanningMode) {
                let current = start.startOf("week");
                while (current <= end) {
                    const weekOffset = Math.round(current.diff(T0, "weeks").weeks);
                    columns.push({
                        date: current,
                        label: _pl("W", weekOffset),
                        weekday: "",
                        month: "T-week",
                        isWeekend: false,
                        isToday: false,
                    });
                    current = current.plus({ weeks: 1 });
                }
            } else {
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
                            month: current.toFormat("yyyy/MM"),
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
                            month: current.toFormat("yyyy/MM"),
                            isWeekend: false,
                            isToday: now >= current && now <= weekEnd,
                        });
                        current = current.plus({ weeks: 1 });
                    }
                }
            }
        } else if (scale === "month") {
            const inPlanningMode = this.isPlanningMode;
            const T0 = PLANNING_T0;
            let current = start.startOf("month");
            while (current <= end) {
                if (inPlanningMode) {
                    const monthOffset = (current.year - T0.year) * 12 + (current.month - T0.month);
                    columns.push({
                        date: current,
                        label: _pl("M", monthOffset),
                        weekday: "",
                        month: "T-month",
                        isWeekend: false,
                        isToday: false,
                    });
                } else {
                    columns.push({
                        date: current,
                        label: current.toFormat("MMM"),
                        weekday: current.toFormat("yyyy"),
                        month: current.toFormat("yyyy"),
                        isWeekend: false,
                        isToday: current.hasSame(now, "month"),
                    });
                }
                current = current.plus({ months: 1 });
            }
        }

        return columns;
    }

    /**
     * Convert a DateTime to pixel position relative to timeline start.
     * - Sub-day: uniform px/ms (or working-hour index when hiding non-working).
     * - Day: px/day (or working-day index when hiding non-working).
     * - Week/month: column-index-based (variable column widths).
     */
    _dateToPx(dt) {
        const data = this.props.model.data;
        if (!data?.timeStart || !dt) return 0;
        if (!data.timeStart.isValid || (dt.isValid !== undefined && !dt.isValid)) return 0;
        // Render-cycle cache: same dt → same px within one render pass
        if (!this._dateToPxCache) this._dateToPxCache = new Map();
        const cacheKey = dt.toMillis();
        const cached = this._dateToPxCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const result = this._dateToPxUncached(dt);
        this._dateToPxCache.set(cacheKey, result);
        return result;
    }

    _dateToPxUncached(dt) {
        const data = this.props.model.data;

        const scale = this.props.scale;
        const cw = this.cellWidth;
        const start = this._extendedTimeStart || data.timeStart;

        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            const hours = parseInt(scale);
            const msPerCol = hours * 3600 * 1000;

            // When hiding non-working hours, use index-based mapping
            if (this._workingHourIndex && this.props.hideNonWorkingDays) {
                // Align dt to column boundary
                const dtHour = dt.hour + dt.minute / 60;
                const aligned = dt.startOf("hour").set({ hour: Math.floor(dtHour) - (Math.floor(dtHour) % hours) });
                const key = aligned.toISO();
                const idx = this._workingHourIndex.get(key);
                if (idx !== undefined) {
                    const frac = (dt.toMillis() - aligned.toMillis()) / msPerCol;
                    return (idx + frac) * cw;
                }
                return this._dateToPxHourFallback(dt, cw);
            }

            const diffMs = dt.toMillis() - start.toMillis();
            return (diffMs / msPerCol) * cw;
        }

        // When hiding non-working days, use index-based mapping
        if (this._workingDayIndex && this.props.hideNonWorkingDays) {
            const dayKey = dt.startOf("day").toISODate();
            const idx = this._workingDayIndex.get(dayKey);
            if (idx !== undefined) {
                // Day fraction: portion of the day elapsed
                const dayFrac = (dt.hour + dt.minute / 60) / 24;
                return (idx + dayFrac) * cw;
            }
            // dt is on a non-working day: find nearest working day boundary
            return this._dateToPxFallback(dt, cw);
        }

        // Week, month: column-index-based mapping
        // Each column spans a variable duration (weeks=7d, months=28-31d),
        // so we find which column dt falls into and compute fractional position.
        if (scale === "week" || scale === "month") {
            const cols = this._coarseColumns;
            if (cols && cols.length > 0) {
                const step = scale === "week" ? { weeks: 1 } : { months: 1 };
                const dtMs = dt.toMillis();
                // Binary search for the column containing dtMs
                let lo = 0, hi = cols.length - 1, i = -1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    const colStartMs = cols[mid].date.toMillis();
                    if (dtMs < colStartMs) {
                        hi = mid - 1;
                    } else {
                        i = mid;
                        lo = mid + 1;
                    }
                }
                if (i >= 0 && i < cols.length) {
                    const colStartMs = cols[i].date.toMillis();
                    const colEndMs = (i + 1 < cols.length)
                        ? cols[i + 1].date.toMillis()
                        : cols[i].date.plus(step).toMillis();
                    const totalMs = colEndMs - colStartMs;
                    const frac = totalMs > 0 ? (dtMs - colStartMs) / totalMs : 0;
                    return (i + frac) * cw;
                }
                // Extrapolate: dt is outside column range
                const firstMs = cols[0].date.toMillis();
                if (dtMs < firstMs) {
                    const colEndMs = cols.length > 1
                        ? cols[1].date.toMillis()
                        : cols[0].date.plus(step).toMillis();
                    const totalMs = colEndMs - firstMs;
                    const frac = totalMs > 0 ? (dtMs - firstMs) / totalMs : 0;
                    return frac * cw;
                }
                const lastIdx = cols.length - 1;
                const lastMs = cols[lastIdx].date.toMillis();
                const lastEndMs = cols[lastIdx].date.plus(step).toMillis();
                const totalMs = lastEndMs - lastMs;
                const frac = totalMs > 0 ? (dtMs - lastMs) / totalMs : 0;
                return (lastIdx + frac) * cw;
            }
        }

        // Day: use days diff (cw = px per day, start is midnight-aligned)
        return dt.diff(start, "days").days * cw;
    }

    /**
     * Build a Map from ISO date string → column index for working days.
     */
    _rebuildWorkingDayIndex(cols) {
        this._workingDayIndex = new Map();
        for (let i = 0; i < cols.length; i++) {
            this._workingDayIndex.set(cols[i].date.toISODate(), i);
        }
    }

    /**
     * Build a Map from ISO datetime string → column index for working hours.
     * Also stores the column array reference for _addWorkingColumns lookup.
     */
    _rebuildWorkingHourIndex(cols) {
        this._workingHourIndex = new Map();
        this._workingHourCols = cols;
        for (let i = 0; i < cols.length; i++) {
            this._workingHourIndex.set(cols[i].date.toISO(), i);
        }
    }

    /**
     * Fallback for _dateToPx when dt falls on a non-working hour.
     * Scans backward through visible columns to find the nearest edge.
     */
    _dateToPxHourFallback(dt, cw) {
        const cols = this._workingHourCols;
        if (!cols || !cols.length) return 0;
        // Find nearest preceding working column
        let bestIdx = -1;
        for (let i = cols.length - 1; i >= 0; i--) {
            if (cols[i].date <= dt) {
                bestIdx = i;
                break;
            }
        }
        if (bestIdx >= 0) {
            return (bestIdx + 1) * cw; // right edge of that column
        }
        // dt is before all visible columns
        return 0;
    }

    /**
     * Fallback for _dateToPx when dt falls on a non-working day.
     * Returns the right edge (end) of the nearest preceding working day.
     */
    _dateToPxFallback(dt, cw) {
        const cols = this.timelineColumns;
        if (!cols.length) return 0;
        let cursor = dt.startOf("day").minus({ days: 1 });
        const earliest = cols[0]?.date;
        while (cursor >= earliest) {
            const key = cursor.toISODate();
            const idx = this._workingDayIndex.get(key);
            if (idx !== undefined) {
                return (idx + 1) * cw; // right edge of that working day
            }
            cursor = cursor.minus({ days: 1 });
        }
        return 0;
    }

    /**
     * Add working days to a DateTime, skipping non-working days.
     * Used by drag/resize when hideNonWorkingDays is active.
     */
    _addWorkingDays(dt, days) {
        days = Math.round(days); // Ensure integer days
        const calendarInfo = this.props.model.data?.calendarInfo;
        if (!calendarInfo) return dt.plus({ days });
        const workingWeekdays = calendarInfo._workingWeekdays;
        if (!workingWeekdays || workingWeekdays.size === 0) return dt.plus({ days });
        const leaveDays = calendarInfo._leaveDays;
        let cursor = dt;
        let remaining = Math.abs(days);
        const direction = days >= 0 ? 1 : -1;
        while (remaining > 0) {
            cursor = cursor.plus({ days: direction });
            if (workingWeekdays.has(cursor.weekday) && !(leaveDays && leaveDays.has(cursor.toISODate()))) {
                remaining--;
            }
        }
        return cursor;
    }

    /**
     * Check if currently hiding non-working periods (days or hours).
     */
    _isHidingNonWorking() {
        if (!this.props.hideNonWorkingDays || !this.props.model.data?.calendarInfo
            || this.isPlanningMode) {
            return false;
        }
        const scale = this.props.scale;
        if (scale === "day") return !!this._workingDayIndex;
        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            return !!this._workingHourIndex;
        }
        return false;
    }

    /**
     * Add working time units (days or hour-columns) to a datetime,
     * skipping non-working periods. Dispatches to day or hour logic.
     */
    _addWorkingUnits(dt, cellsDelta) {
        const scale = this.props.scale;
        if (scale === "day") {
            return this._addWorkingDays(dt, cellsDelta);
        }
        return this._addWorkingColumns(dt, cellsDelta);
    }

    /**
     * Add working-hour columns to a datetime using column-index lookup.
     * Finds dt's position in the visible (filtered) column array, offsets
     * by cellsDelta columns, and returns the target datetime preserving
     * the fractional position within the column.
     */
    _addWorkingColumns(dt, cellsDelta) {
        const cols = this._workingHourCols;
        if (!cols || !cols.length) {
            return dt.plus(cellsDeltaToDuration(cellsDelta, this.props.scale));
        }

        const hours = parseInt(this.props.scale);
        const msPerCol = hours * 3600 * 1000;

        // Find the column whose time range contains dt.
        // Try fast Map lookup first, then fallback to linear scan.
        let srcIdx = -1;
        if (this._workingHourIndex) {
            const dtHour = dt.hour + dt.minute / 60;
            const aligned = dt.startOf("hour").set({ hour: Math.floor(dtHour) - (Math.floor(dtHour) % hours) });
            const idx = this._workingHourIndex.get(aligned.toISO());
            if (idx !== undefined) {
                srcIdx = idx;
            }
        }
        if (srcIdx < 0) {
            // Fallback: linear scan for the column whose time range contains dt
            for (let i = 0; i < cols.length; i++) {
                const colMs = cols[i].date.toMillis();
                if (dt.toMillis() >= colMs && dt.toMillis() < colMs + msPerCol) {
                    srcIdx = i;
                    break;
                }
            }
        }
        if (srcIdx < 0) {
            // dt outside visible range — find nearest column
            let bestDist = Infinity;
            for (let i = 0; i < cols.length; i++) {
                const d = Math.abs(dt.toMillis() - cols[i].date.toMillis());
                if (d < bestDist) { bestDist = d; srcIdx = i; }
            }
        }

        // Fractional offset within source column (ms)
        const fracMs = dt.toMillis() - cols[srcIdx].date.toMillis();

        // Target column = source + rounded delta
        const delta = Math.round(cellsDelta);
        const targetIdx = Math.max(0, Math.min(cols.length - 1, srcIdx + delta));

        // Reconstruct: target column date + same fractional offset (clamped)
        const clampedFrac = Math.max(0, Math.min(msPerCol - 1, fracMs));
        return cols[targetIdx].date.plus({ milliseconds: clampedFrac });
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
        if (scale === "month") return cw / 30;
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
            group._rowKey = `g_${group.id}`;
            rows.push(group);
            if (!group.fold) {
                const records = group._treeRecords || group.records || [];
                for (const record of records) {
                    record._rowKey = `t_${record.id}`;
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
        const vw = this._scrollPos.viewportWidth;
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
        return date.plus({ months: n }); // month
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

    /** Hours per working day from the project's calendar.
     *  In planning mode default to 8 (working day); otherwise 24 (calendar day). */
    get _calHpd() {
        const hpd = this.props.model.data?.calendarInfo?.hours_per_day;
        if (hpd) return hpd;
        return this.isPlanningMode ? 8 : 24;
    }

    /** Working days per week from the project's calendar (default 7). */
    get _calDpw() {
        const ws = this.props.model.data?.calendarInfo?._workingWeekdays;
        return (ws && ws.size > 0) ? ws.size : 7;
    }

    /**
     * Virtual-timeline scale factor (24/hpd) used to convert between calendar
     * columns and working-hour offsets when non-working time is collapsed.
     * Single definition so the rule lives in one place.
     */
    get _scaleFactor() {
        return (this._calHpd < 24) ? (24 / this._calHpd) : 1;
    }

    get arrowProps() {
        const data = this.props.model.data;
        
        // Build visible row IDs set for virtual scroll optimization
        const visibleRowIds = new Set();
        if (this._shouldUseVirtualScroll) {
            const allRows = this.flattenedRows;
            const { start, end } = this._visibleRangeState;
            for (let i = start; i < end && i < allRows.length; i++) {
                const row = allRows[i];
                if (row.id) {
                    visibleRowIds.add(row.id);
                }
            }
        }
        
        return {
            predecessors: data?.predecessors || [],
            milestoneLinks: data?.milestoneLinks || [],
            records: data?.records || [],
            flattenedRows: this.flattenedRows,
            visibleRowIds: visibleRowIds.size > 0 ? visibleRowIds : undefined,
            dateToPx: this._boundDateToPx,
            // Authoritative bar-edge geometry (clamp + fallback + live drag baked
            // in). Arrows use this for task endpoints so they never detach.
            barGeom: this._boundBarGeom,
            rowHeight: 44,
            selectedRowId: this.state.selectedRowId,
            criticalField: this.props.archInfo.criticalPath || "",
            hpd: this._calHpd,
            dpw: this._calDpw,
            dragState: this._dragState,
        };
    }

    /**
     * Compute lag preview for FS predecessors/successors during drag or resize.
     *
     * @param {number} recId - the dragged/resized record id
     * @param {number} cellsDelta - fractional cells moved
     * @param {string} mode - "both" (drag: both ends move), "incoming" (left resize: start moves),
     *                        "outgoing" (right resize: end moves)
     * @returns {Array<{type: string, sourceName: string, currentLag: string, newLag: string}>}
     */
    _computePredLagPreview(recId, cellsDelta, mode) {
        const model = this.props.model;
        const preds = model.data?.predecessors;
        if (!preds || preds.length === 0) return [];

        const hpd = this._calHpd;
        const dpw = this._calDpw;
        const scale = this.props.scale;
        const shiftDur = cellsDeltaToDuration(cellsDelta, scale);
        const shiftHours = (shiftDur.hours || 0) + (shiftDur.days || 0) * 24
            + (shiftDur.weeks || 0) * 168 + (shiftDur.months || 0) * 720;

        const record = model.getRecord(recId);
        if (!record) return [];

        const results = [];

        // Incoming FS: this task is the child (task_id), lag = childStart - sourceEnd
        // Affected by drag (both ends move) or left-resize (start moves)
        if (mode === "both" || mode === "incoming") {
            const incomingFs = preds.filter(p =>
                p.task_id === recId && (p.type || "FS").toUpperCase() === "FS"
            );
            for (const pred of incomingFs) {
                const source = model.getRecord(pred.parent_task_id);
                if (!source) continue;
                const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
                const childStart = (record._hasChildren && record._summaryDateStart) || record._dateStart;
                if (!sourceEnd || !childStart) continue;

                const currentLagHours = childStart.diff(sourceEnd, "hours").hours;
                const newLagHours = currentLagHours + shiftHours;

                results.push({
                    type: "FS",
                    sourceName: source.display_name || String(pred.parent_task_id),
                    currentLag: humanizeHours(currentLagHours, hpd, dpw),
                    newLag: humanizeHours(newLagHours, hpd, dpw),
                });
            }
        }

        // Outgoing FS: this task is the parent (parent_task_id), lag = childStart - sourceEnd
        // Affected by drag (both ends move) or right-resize (end moves)
        if (mode === "both" || mode === "outgoing") {
            const outgoingFs = preds.filter(p =>
                p.parent_task_id === recId && (p.type || "FS").toUpperCase() === "FS"
            );
            for (const pred of outgoingFs) {
                const child = model.getRecord(pred.task_id);
                if (!child) continue;
                const sourceEnd = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
                const childStart = (child._hasChildren && child._summaryDateStart) || child._dateStart;
                if (!sourceEnd || !childStart) continue;

                const currentLagHours = childStart.diff(sourceEnd, "hours").hours;
                const newLagHours = currentLagHours - shiftHours;

                results.push({
                    type: "FS",
                    sourceName: child.display_name || String(pred.task_id),
                    currentLag: humanizeHours(currentLagHours, hpd, dpw),
                    newLag: humanizeHours(newLagHours, hpd, dpw),
                });
            }
        }

        return results;
    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------

    /**
     * Handle group toggle (expand/collapse) - only toggles fold state
     */
    onGroupToggle(group) {
        if (this.props.model.toggleGroup) {
            this.props.model.toggleGroup(group.id);
        }
    }

    /**
     * Handle click on any row (task or group) - sets selection
     */
    /**
     * Unified selection-click logic shared by row / bar / task clicks.
     *  - Ctrl/Cmd : toggle this id in/out of the selection
     *  - Shift    : select the contiguous range from the anchor to this id
     *               (in flattenedRows order)
     *  - plain    : single-select and set a new anchor
     */
    _applySelectionClick(id, ev) {
        if (ev && (ev.ctrlKey || ev.metaKey)) {
            if (this.state.selectedRowIds[id]) {
                const { [id]: _omit, ...rest } = this.state.selectedRowIds;
                this.state.selectedRowIds = rest;
            } else {
                this.state.selectedRowIds = { ...this.state.selectedRowIds, [id]: true };
            }
            this._selectionAnchorId = id;
        } else if (ev && ev.shiftKey && this._selectionAnchorId != null) {
            this._selectRange(this._selectionAnchorId, id);
        } else {
            this.state.selectedRowIds = { [id]: true };
            this._selectionAnchorId = id;
        }
        this.state.selectedRowId = id;
    }

    /** Select every row between two ids inclusive, by flattenedRows order. */
    _selectRange(fromId, toId) {
        const rows = this.flattenedRows;
        const a = rows.findIndex(r => r.id === fromId);
        const b = rows.findIndex(r => r.id === toId);
        if (a === -1 || b === -1) {
            this.state.selectedRowIds = { [toId]: true };
            return;
        }
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const sel = {};
        for (let i = lo; i <= hi; i++) sel[rows[i].id] = true;
        this.state.selectedRowIds = sel;
    }

    // -------------------------------------------------------------------------
    // View mode (gantt / resource / network / calendar)
    // -------------------------------------------------------------------------

    setViewMode(mode) {
        this.state.viewMode = mode;
    }

    // -------------------------------------------------------------------------
    // Optional columns (column chooser)
    // -------------------------------------------------------------------------

    /** Column defs currently selected for display, in canonical order. */
    get activeOptionalColumns() {
        const sel = this.state.optionalCols || [];
        return this.OPTIONAL_COLUMNS.filter(c => sel.includes(c.key));
    }

    isColumnActive(key) {
        return (this.state.optionalCols || []).includes(key);
    }

    toggleColMenu() {
        this.state.showColMenu = !this.state.showColMenu;
    }

    toggleOptionalColumn(key) {
        const cur = this.state.optionalCols || [];
        const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key];
        this.state.optionalCols = next;
        try {
            localStorage.setItem("gantt_optional_cols", JSON.stringify(next));
        } catch (_e) { /* ignore quota errors */ }
    }

    /** Value of an optional column for a task row (string). */
    getOptionalColumnValue(row, key) {
        if (row._isGroup) return "";
        switch (key) {
            case "duration":
                return this.getInfoDuration(row) || "";
            case "progress":
                return row._isMilestoneRecord ? "" : `${Math.round(row._progress || 0)}%`;
            case "resource": {
                const field = this.props.archInfo.resourceField;
                if (!field) return "";
                const v = row[field];
                if (!v) return "";
                return Array.isArray(v) ? (v[1] || "") : String(v);
            }
            default:
                return "";
        }
    }

    /** Apply a marquee result. additive keeps the existing selection. */
    setSelection(ids, additive) {
        const sel = additive ? { ...this.state.selectedRowIds } : {};
        for (const id of ids) sel[id] = true;
        this.state.selectedRowIds = sel;
        if (ids.length) {
            this.state.selectedRowId = ids[ids.length - 1];
            this._selectionAnchorId = ids[0];
        }
    }

    onRowClick(row, ev) {
        // Close state menu on any row click
        this.state.stateMenuRecordId = null;
        this._applySelectionClick(row.id, ev);
    }

    onRecordClick(record) {
        this.state.selectedRowId = record.id;
    }

    onBarClick(record, ev) {
        this._applySelectionClick(record.id, ev);
    }

    onTaskSelect(record, ev) {
        this._applySelectionClick(record.id, ev);
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
        if (this._hoveredId === rowId) return;
        // Direct DOM manipulation — no OWL re-render
        const root = this.timelineRef.el?.closest(".o_gantt_container");
        if (!root) return;
        for (const el of root.querySelectorAll(".o_gantt_row_hover")) {
            el.classList.remove("o_gantt_row_hover");
        }
        if (rowId != null) {
            for (const el of root.querySelectorAll(`[data-row-id="${rowId}"]`)) {
                el.classList.add("o_gantt_row_hover");
            }
        }
        this._hoveredId = rowId;
    }

    onRowLeave() {
        if (this._hoveredId == null) return;
        const root = this.timelineRef.el?.closest(".o_gantt_container");
        if (root) {
            for (const el of root.querySelectorAll(".o_gantt_row_hover")) {
                el.classList.remove("o_gantt_row_hover");
            }
        }
        this._hoveredId = null;
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
            this.actionService.doAction({
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
        const record = this.props.model.getRecord(negativeId);
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
                    this.props.model.deleteMilestone(negativeId).catch((e) => {
                        console.warn("Failed to delete milestone:", e);
                    });
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
        const record = this.props.model.getRecord(recordId);
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
                    this.props.model.deleteRecord(recordId).catch((e) => {
                        console.warn("Failed to delete record:", e);
                    });
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
        await this.props.model.indentTask(record.id);
    }

    async onOutdentClick(record) {
        await this.props.model.outdentTask(record.id);
    }

    // -------------------------------------------------------------------------
    // Activity button
    // -------------------------------------------------------------------------

    /**
     * Return FA icon classes matching the official mail.ActivityButton logic.
     * Combines state color + icon (exception icon / activity type icon / clock).
     */
    getActivityButtonClass(record) {
        const classes = [];
        // --- State color ---
        switch (record.activity_state) {
            case "overdue":
                classes.push("text-danger");
                break;
            case "today":
                classes.push("text-warning");
                break;
            case "planned":
                classes.push("text-success");
                break;
            // ListActivityButton: no color when no activity
        }
        // --- Icon (exception > type icon > clock) ---
        switch (record.activity_exception_decoration) {
            case "warning":
                classes.push("text-warning", record.activity_exception_icon || "fa-clock-o");
                break;
            case "danger":
                classes.push("text-danger", record.activity_exception_icon || "fa-clock-o");
                break;
            default: {
                const ids = record.activity_ids;
                if (ids && ids.length) {
                    classes.push(record.activity_type_icon || "fa-tasks");
                } else {
                    classes.push("fa-clock-o");
                }
                break;
            }
        }
        return classes.join(" ");
    }

    /**
     * Open the activity popover for a task row.
     */
    onActivityClick(record, ev) {
        const btnEl = ev.currentTarget;
        if (this.activityPopover.isOpen) {
            this.activityPopover.close();
            return;
        }
        this.activityPopover.open(btnEl, {
            activityIds: record.activity_ids || [],
            onActivityChanged: () => {
                this.activityPopover.close();
                if (this.props.onReload) {
                    this.props.onReload();
                }
            },
            resId: record.id,
            resModel: this.props.model.resModel,
        });
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

        // Planning mode: align new subtask after the last child of this parent
        const group = this.props.model._groupMap.get(projectId);
        if (group && group._isPlanningMode) {
            const offset = this._getNextPlanOffset(group, parentRecord.id);
            if (offset > 0) {
                defaults.default_plan_offset = offset;
            }
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
        const name = record.display_name || record.name || _t("任務 #%(id)s", { id: record.id });

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
                this.state.selectedRowIds = {};
                if (this.props.onReload) {
                    await this.props.onReload();
                }
            },
            dismiss: () => {},
        });
    }

    onAddTaskToGroup(group) {
        const groupField = this.props.archInfo.mainGroupIdName || "project_id";
        const defaults = {
            [`default_${groupField}`]: group.id,
        };

        // Planning mode: align new task after the last root-level task
        if (group._isPlanningMode) {
            const offset = this._getNextPlanOffset(group, 0);
            if (offset > 0) {
                defaults.default_plan_offset = offset;
            }
        }

        if (this.props.onAddTask) {
            this.props.onAddTask(defaults);
        }
    }

    /**
     * Find the plan_offset for a new child task — align to parent's start.
     * @param {Object} group - project group
     * @param {number} parentId - parent task id (0 for root level)
     * @returns {number} plan_offset in hours
     */
    _getNextPlanOffset(group, parentId) {
        if (!parentId) return 0;
        // Place new child at the parent's own start position
        const parent = this.props.model.getRecord(parentId);
        return parent ? (parent._planOffset || 0) : 0;
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
        const name = record.display_name || record.name || _t("里程碑 #%(id)s", { id: Math.abs(record.id) });
        this.displayDialog(ConfirmationDialog, {
            body: _t("確定要刪除里程碑「%(name)s」嗎？", { name }),
            confirm: async () => {
                await this.props.model.deleteMilestone(record.id);
            },
            dismiss: () => {},
        });
    }

    // -------------------------------------------------------------------------
    // Ghost/Baseline bars
    // -------------------------------------------------------------------------

    getGhostBars(record) {
        // Build a taskId → ghostBars map once per render instead of filtering
        // the full array for every row (was O(rows × ghostBars)).
        if (!this._ghostBarsByTask) {
            this._ghostBarsByTask = new Map();
            for (const gb of this.props.model.data?.ghostBars || []) {
                let list = this._ghostBarsByTask.get(gb.taskId);
                if (!list) {
                    list = [];
                    this._ghostBarsByTask.set(gb.taskId, list);
                }
                list.push(gb);
            }
        }
        return this._ghostBarsByTask.get(record.id) || [];
    }

    getGhostBarStyle(ghostBar) {
        const data = this.props.model.data;
        if (!data?.timeStart || !data.timeStart.isValid || !ghostBar.dateStart) return "display: none;";

        const left = this._dateToPx(ghostBar.dateStart);
        let width = GanttRenderer.MIN_BAR_W;
        if (ghostBar.dateEnd) {
            const right = this._dateToPx(ghostBar.dateEnd);
            width = Math.max(right - left, GanttRenderer.MIN_MINIBAR_W);
        }
        return `left: ${left}px; width: ${width}px;`;
    }

    /**
     * Get CSS class for group bar (parent task bar)
     * @param {Object} group - Group row data
     * @returns {String} CSS classes
     */
    getGroupBarClass(group) {
        const classes = ["o_gantt_group_bar"];
        if (this.state.selectedRowId === group.id) {
            classes.push("o_gantt_group_bar_selected");
        }
        return classes.join(" ");
    }

    /**
     * Handle group bar click to select the parent task
     * @param {Object} group - Group row data
     * @param {Event} ev - Click event
     */
    onGroupBarClick(group, ev) {
        // Stop propagation to prevent row click handler from firing
        ev.stopPropagation();
        // Reuse the unified selection logic (ctrl/shift/plain) instead of a
        // separate hand-rolled copy that mutated state in place.
        this._applySelectionClick(group.id, ev);
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

        // Use a resourceId → records index built once per render so each row
        // only scans tasks sharing its resource, not the whole project.
        // hasResourceConflict() calls this per row, so the naive full scan was
        // O(rows²).
        const sameResource = this._getRecordsByResource(resourceField).get(resourceId) || [];
        const conflicts = [];
        for (const other of sameResource) {
            if (other.id === record.id) continue;
            // Time overlap (both already validated when indexed).
            if (record._dateStart < other._dateEnd && record._dateEnd > other._dateStart) {
                conflicts.push(other);
            }
        }
        return conflicts;
    }

    _getRecordsByResource(resourceField) {
        if (!this._recordsByResource) {
            const index = new Map();
            for (const rec of this.props.model.data?.records || []) {
                const val = rec[resourceField];
                if (!val) continue;
                const id = Array.isArray(val) ? val[0] : val;
                if (!id) continue;
                if (!this._isValidDt(rec._dateStart) || !this._isValidDt(rec._dateEnd)) continue;
                let list = index.get(id);
                if (!list) {
                    list = [];
                    index.set(id, list);
                }
                list.push(rec);
            }
            this._recordsByResource = index;
        }
        return this._recordsByResource;
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
            viewportWidth: this._scrollPos.viewportWidth || 800,
            scrollLeft: this._scrollPos.scrollLeft || 0,
            rowCount: this.flattenedRows.length,
            viewportHeight: this._scrollPos.viewportHeight || 400,
            scrollTop: this._scrollPos.scrollTop || 0,
            totalHeight: this._scrollPos.totalHeight || 400,
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
        const record = this.props.model.getRecord(this.props.inspectorRecordId);
        // Return shallow copy so OWL detects prop changes after updateRecord
        return record ? { ...record } : null;
    }

    get inspectorPredecessors() {
        if (!this.props.inspectorRecordId) return [];
        const records = this.props.model.data?.records || [];
        const recordMap = new Map(records.map(r => [r.id, r]));
        const selectedId = this.props.inspectorRecordId;

        const LINK_LABELS = {
            FS: [_t("完成"), _t("開始")],
            SF: [_t("開始"), _t("完成")],
            SS: [_t("開始"), _t("開始")],
            FF: [_t("完成"), _t("完成")],
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
        return links.map(l => {
            const task = this.props.model.getRecord(l.task_id);
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
        let removed = null;
        let removedIdx = -1;
        if (preds) {
            const numId = parseInt(predIdentifier, 10);
            removedIdx = preds.findIndex(p => p.id === numId);
            if (removedIdx !== -1) {
                removed = preds.splice(removedIdx, 1)[0];
                this.props.model.notify();
            }
        }
        try {
            await this.props.model.deletePredecessor(predIdentifier);
        } catch (e) {
            // Rollback on failure
            if (removed && preds && removedIdx !== -1) {
                preds.splice(removedIdx, 0, removed);
                this.props.model.notify();
            }
        }
    }

    async onUpdatePredecessor(predId, values) {
        await this.props.model.updatePredecessor(predId, values);
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
                const record = model.getRecord(recordId);
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
                this.actionService.doAction({
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
    // Task State (unified blocking)
    // -------------------------------------------------------------------------

    getTaskStateIcon(record) {
        if (record._isGroup) return "";
        const state = record.state;
        switch (state) {
            case "1_done": return "fa fa-fw fa-check-circle";
            case "1_canceled": return "fa fa-fw fa-times-circle";
            case "04_waiting_normal": return "fa fa-fw fa-hourglass-o";
            case "03_approved": return "fa fa-fw fa-thumbs-up";
            case "02_changes_requested": return "fa fa-fw fa-adjust";
            default: return "fa fa-fw fa-circle-o";
        }
    }

    getTaskStateClass(record) {
        if (record._isGroup) return "d-none";
        const state = record.state;
        switch (state) {
            case "1_done": return "o_gantt_task_state text-success";
            case "1_canceled": return "o_gantt_task_state text-muted";
            case "04_waiting_normal": return "o_gantt_task_state text-info";
            case "03_approved": return "o_gantt_task_state text-success";
            case "02_changes_requested": return "o_gantt_task_state text-warning";
            default: return "o_gantt_task_state text-secondary";
        }
    }

    getTaskStateLabel(record) {
        if (record._isGroup) return "";
        const state = record.state;
        switch (state) {
            case "1_done": return "完成";
            case "1_canceled": return "已取消";
            case "04_waiting_normal": return "等待中（被前置任務阻擋）";
            case "03_approved": return "已核准";
            case "02_changes_requested": return "要求修改";
            default: return "進行中";
        }
    }

    onTaskStateClick(record, ev) {
        if (record._isGroup) return;
        // Toggle dropdown: open if closed, close if already open for this record
        if (this.state.stateMenuRecordId === record.id) {
            this.state.stateMenuRecordId = null;
        } else {
            this.state.stateMenuRecordId = record.id;
        }
    }

    getStateMenuItems(record) {
        const current = record.state;
        return [
            { value: "01_in_progress", label: _t("進行中"), icon: "fa fa-fw fa-circle-o text-secondary", active: current === "01_in_progress", disabled: false },
            { value: "02_changes_requested", label: _t("要求修改"), icon: "fa fa-fw fa-adjust text-warning", active: current === "02_changes_requested", disabled: false },
            { value: "03_approved", label: _t("已核准"), icon: "fa fa-fw fa-thumbs-up text-success", active: current === "03_approved", disabled: false },
            { value: "1_done", label: _t("完成"), icon: "fa fa-fw fa-check-circle text-success", active: current === "1_done", disabled: false },
            { value: "1_canceled", label: _t("已取消"), icon: "fa fa-fw fa-times-circle text-muted", active: current === "1_canceled", disabled: false },
        ];
    }

    async onStateMenuSelect(record, item) {
        this.state.stateMenuRecordId = null;
        if (item.active || item.disabled) return;
        try {
            await this.props.model.orm.write("project.task", [record.id], { state: item.value });
            await this.props.onReload();
        } catch (error) {
            this.notification.add(
                _t("狀態更新失敗"),
                { type: "danger" },
            );
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
        if (!row._isGroup && row._isMilestoneRecord) {
            classes.push("o_gantt_milestone_row");
        }
        // hover is now managed via direct DOM (onRowHover), not state
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
        if (this.state.selectedRowId === row.id) {
            classes.push("o_gantt_row_selected");
        }
        return classes.join(" ");
    }

    /** Clear the live drag/resize offset (called once dates have settled). */
    _clearGesture() {
        this._dragState.ids = {};
        this._dragState.deltaLeft = 0;
        this._dragState.deltaRight = 0;
    }

    /**
     * Single source of truth for a task bar's horizontal geometry.
     *
     * Returns the bar's *visual* edges in timeline pixels — already including:
     *   - summary dates for parent tasks,
     *   - the live drag/resize offset (_dragState),
     *   - the no-end fallback width,
     *   - the minimum-visible-width clamp (MIN_BAR_W).
     *
     * BOTH getBarStyle() (the rendered bar) and GanttArrows (dependency arrow
     * endpoints) must derive their X coordinates from this method so that an
     * arrow always attaches to the bar's real visual edge. Computing arrow
     * endpoints independently from raw dateToPx() makes them drift from the bar
     * whenever the clamp/fallback kicks in (e.g. a short task on a coarse scale,
     * or a bar resized down to a sub-cell duration) — which is the root cause of
     * the "resize → arrow detaches" bug.
     *
     * A summary bar is the union of its children's geometry — a child can never
     * be drawn outside its parent, not by the min-width clamp and not mid-drag.
     * Every bar otherwise sits exactly on its own dates.
     *
     * @param {Object} record
     * @param {Set} [_seen] cycle guard for the summary recursion
     * @returns {{left:number, right:number}|null} null when the bar is not drawable
     */
    _computeBarGeometry(record, _seen) {
        if (!record) return null;
        const data = this.props.model.data;
        if (!data?.timeStart || !data.timeStart.isValid) return null;

        // Memoised for the duration of one render (cleared alongside
        // _dateToPxCache in onWillRender/onWillPatch, so a drag still recomputes
        // every frame). Without it an outline costs O(rows × depth): each of the
        // three callers — the bar, the arrow layer, the milestone links — walks a
        // summary row's whole subtree again, and every ancestor level re-walks it
        // on top of that.
        if (!this._barGeomCache) this._barGeomCache = new Map();
        if (this._barGeomCache.has(record.id)) {
            return this._barGeomCache.get(record.id);
        }
        const geom = this._computeBarGeometryUncached(record, _seen);
        this._barGeomCache.set(record.id, geom);
        return geom;
    }

    /** @see _computeBarGeometry — the real computation, without the memo. */
    _computeBarGeometryUncached(record, _seen) {
        // A summary bar IS its children: first child's left edge → last child's
        // right edge, measured in PIXELS after every child-side adjustment
        // (min-width clamp, no-end fallback, live drag offset). Deriving it from
        // the summary dates instead would leave a child whose bar was widened by
        // the clamp sticking out past its parent — the parent must always
        // contain its descendants on screen.
        if (record._hasChildren && record._children && record._children.length) {
            const seen = _seen || new Set();
            if (!seen.has(record.id)) {
                seen.add(record.id);
                let left = null;
                let right = null;
                for (const child of record._children) {
                    if (child._isMilestoneRecord) continue;
                    const cg = this._computeBarGeometry(child, seen);
                    if (!cg) continue;
                    if (left === null || cg.left < left) left = cg.left;
                    if (right === null || cg.right > right) right = cg.right;
                }
                if (left !== null) {
                    const d = this._parentDragDelta(record);
                    return {
                        left: left + d,
                        right: left + d + Math.max(right - left, GanttRenderer.MIN_BAR_W),
                    };
                }
            }
        }

        // Use summary dates for parent tasks if available
        let dateStart = record._dateStart;
        let dateEnd = record._dateEnd;
        if (record._hasChildren) {
            dateStart = record._summaryDateStart || dateStart;
            dateEnd = record._summaryDateEnd || dateEnd;
        }

        if (!this._isValidDt(dateStart)) return null;

        let left = this._dateToPx(dateStart);
        let right = dateEnd ? this._dateToPx(dateEnd) : left + GanttRenderer.NO_END_BAR_W;

        // Apply the live drag/resize offset so a re-render mid-gesture keeps the
        // bar exactly where the pointer put it (and aligned with its arrows).
        const drag = this._dragState;
        if (drag.ids[record.id]) {
            left += drag.deltaLeft;
            right += drag.deltaRight;
        }

        // Clamp to a minimum visible width — and expose the *clamped* right edge
        // so arrows attach to what the user actually sees.
        const width = Math.max(right - left, GanttRenderer.MIN_BAR_W);
        return { left, right: left + width };
    }

    // The per-render "anti-backfold nudge" (_computeBarVisualOffsets) is gone.
    //
    // It shifted an FS successor's BAR right so its left edge met the
    // predecessor's MIN_BAR_W-widened right edge, purely so the connector would
    // not have to fold leftward. Two problems: a bar no longer sat on its own
    // dates (the timeline must read as the calendar span), and the shift had to
    // cascade down a chain, growing link by link until it was either wrong or
    // capped — capped is exactly when the backfold reappeared, which is why a
    // flush chain produced by 壓縮向左 showed a clean first link and folded on
    // every one after it.
    //
    // Backfolding is now impossible by construction in the connector itself:
    // GanttArrows._buildPath clamps the 45° leg to the distance actually
    // available, so the path's X only ever advances. Bars stay on their dates.

    /**
     * Live drag offset that applies to a SUMMARY bar built from its children.
     *
     * Dragging a parent moves only the parent's own bar during the gesture
     * (children snap into place on commit), so the parent's delta must be added
     * on top of the children's union. But in a multi-select drag where a child
     * is dragged too, the union already carries that movement — adding the
     * parent's delta again would double it.
     */
    _parentDragDelta(record) {
        const drag = this._dragState;
        if (!drag.ids[record.id]) return 0;
        for (const child of record._children || []) {
            if (drag.ids[child.id]) return 0;
        }
        return drag.deltaLeft;
    }

    getBarStyle(record) {
        const geom = this._computeBarGeometry(record);
        if (!geom) return "display: none;";
        return `left: ${geom.left}px; width: ${geom.right - geom.left}px;`;
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
        if (this.state.selectedRowIds[record.id]) {
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
        if (column.isNonWorking) {
            classes.push("o_gantt_nonworking");
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
        defaults[`default_${dateStartField}`] = clickDate.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");

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
        // taskId → loadBars map, built once per render (was O(rows × loadBars)).
        if (!this._loadBarsByTask) {
            this._loadBarsByTask = new Map();
            for (const lb of this.props.model.data?.loadBars || []) {
                let list = this._loadBarsByTask.get(lb.taskId);
                if (!list) {
                    list = [];
                    this._loadBarsByTask.set(lb.taskId, list);
                }
                list.push(lb);
            }
        }
        return this._loadBarsByTask.get(record.id) || [];
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
        // Use summary dates for parent tasks (same as getBarStyle)
        let dateStart = record._dateStart;
        if (record._hasChildren) {
            dateStart = record._summaryDateStart || dateStart;
        }
        if (!this._isValidDt(dateStart)) return;

        // Select row + open inspector first (state change triggers re-render)
        this.state.selectedRowId = record.id;
        if (this.props.onInspectorOpen) {
            if (!this.props.showInspectorPanel || this.props.inspectorRecordId !== record.id) {
                this.props.onInspectorOpen(record.id);
            }
        }

        // Defer scroll to next frame so inspector panel is rendered and
        // timeline dimensions are stable.
        requestAnimationFrame(() => {
            const timeline = this.timelineRef.el;
            if (!timeline) return;

            // Bar start pixel = the anchor point to center in visible area
            const barStartPx = this._dateToPx(dateStart);

            // Inspector panel (320px) overlays the right side of the timeline,
            // so the effective visible width is reduced.
            const inspectorW = this.props.showInspectorPanel ? 320 : 0;
            const visibleW = Math.max(timeline.clientWidth - inspectorW, 200);

            const targetLeft = Math.max(0, barStartPx - visibleW / 2);

            // Vertical target: center row in viewport
            let targetTop = timeline.scrollTop;
            const timelineData = this.timelineDataRef.el;
            const barEl = timelineData?.querySelector(`[data-record-id="${record.id}"]`);
            if (barEl) {
                const rowEl = barEl.closest(".o_gantt_timeline_row");
                if (rowEl) {
                    targetTop = Math.max(0, rowEl.offsetTop - timeline.clientHeight / 2 + 22);
                }
            }

            // Smooth animated scroll
            timeline.scrollTo({
                left: targetLeft,
                top: targetTop,
                behavior: "smooth",
            });

            // Highlight the bar with a pulse
            if (barEl) {
                barEl.classList.remove("o_gantt_bar_focus_pulse");
                void barEl.offsetWidth;
                barEl.classList.add("o_gantt_bar_focus_pulse");
                barEl.addEventListener("animationend", () => {
                    barEl.classList.remove("o_gantt_bar_focus_pulse");
                }, { once: true });
            }
        });
    }

    // -------------------------------------------------------------------------
    // Info column helpers (duration + date range)
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Constraint date marker (visual indicator on timeline)
    // -------------------------------------------------------------------------

    hasConstraintDate(record) {
        if (record._isGroup) return false;
        const typeField = this.props.archInfo.constrainType || "constrain_type";
        const type = record[typeField];
        if (!type || type === "asap" || type === "alap") return false;
        return !!record._constrainDate;
    }

    getConstraintInfo(record) {
        const typeField = this.props.archInfo.constrainType || "constrain_type";
        const type = record[typeField];
        const dt = record._constrainDate;
        const data = this.props.model.data;

        const labels = {
            snet: _t("開始不早於"), snlt: _t("開始不晚於"),
            fnet: _t("完成不早於"), fnlt: _t("完成不晚於"),
            mso: _t("必須開始於"), mfo: _t("必須完成於"),
        };
        const shortLabels = { snet: "S≥", snlt: "S≤", fnet: "F≥", fnlt: "F≤", mso: "S=", mfo: "F=" };
        const hard = type === "mso" || type === "mfo";
        const isStartType = ["snet", "snlt", "mso"].includes(type);

        // Position
        let style = "display: none;";
        let constraintPx = 0;
        if (data?.timeStart?.isValid && dt?.isValid) {
            constraintPx = this._dateToPx(dt);
            style = `left: ${constraintPx}px;`;
        }

        // Violation check
        let violated = false;
        if (dt?.isValid) {
            const ds = record._dateStart;
            const de = record._dateEnd;
            if (ds?.isValid && de?.isValid) {
                if (type === "snet" && ds < dt) violated = true;
                else if (type === "snlt" && ds > dt) violated = true;
                else if (type === "fnet" && de < dt) violated = true;
                else if (type === "fnlt" && de > dt) violated = true;
                else if (type === "mso" && Math.abs(ds.toMillis() - dt.toMillis()) > 60000) violated = true;
                else if (type === "mfo" && Math.abs(de.toMillis() - dt.toMillis()) > 60000) violated = true;
            }
        }

        // Current date label
        let currentLabel = "";
        if (isStartType && record._dateStart?.isValid) {
            currentLabel = _t("目前開始: ") + record._dateStart.toFormat("M/d HH:mm");
        } else if (!isStartType && record._dateEnd?.isValid) {
            currentLabel = _t("目前完成: ") + record._dateEnd.toFormat("M/d HH:mm");
        }

        // Connector line: horizontal link between constraint marker and task bar edge
        let connector = null;
        if (data?.timeStart?.isValid && dt?.isValid) {
            const ds = record._dateStart;
            const de = record._dateEnd;
            // For start-type: connect to bar start; for end-type: connect to bar end
            const targetDt = isStartType ? ds : de;
            if (targetDt?.isValid) {
                const targetPx = this._dateToPx(targetDt);
                const gap = targetPx - constraintPx;
                // Only show connector if there's meaningful distance (> 8px)
                if (Math.abs(gap) > 8) {
                    const left = Math.min(0, gap);
                    const width = Math.abs(gap);
                    // Direction: arrow points from constraint to task edge
                    const direction = gap > 0 ? "right" : "left";
                    connector = { left, width, direction };
                }
            }
        }

        return {
            style,
            label: shortLabels[type] || type?.toUpperCase() || "",
            typeLabel: labels[type] || (type || "").toUpperCase(),
            dateStr: dt?.isValid ? dt.toFormat("yyyy-MM-dd HH:mm") : "",
            hard,
            isStartType,
            violated,
            currentLabel,
            connector,
        };
    }

    onConstraintClick(record, ev) {
        if (this.props.onInspectorOpen) {
            this.props.onInspectorOpen(record.id);
        }
    }

    /**
     * Double-clicking a task bar opens the inspector for it — and closes it
     * again when that same task's inspector is already open (the controller's
     * onInspectorToggle owns that toggle).
     */
    onBarDblClick(record) {
        if (record._isGroup || !this.props.onInspectorOpen) return;
        // A double click also fires the two clicks that selected the row; make
        // sure the inspector shows the bar that was actually double-clicked.
        this.state.selectedRowId = record.id;
        this.props.onInspectorOpen(record.id);
    }

    onConstraintEnter(record, ev) {
        const el = ev.currentTarget;
        const rect = el.getBoundingClientRect();
        const x = rect.left;
        const y = rect.top - 8;
        this.state.constraintTooltipId = record.id;
        this.state.constraintTooltipStyle = `left: ${x}px; bottom: ${window.innerHeight - y}px;`;
    }

    onConstraintLeave() {
        this.state.constraintTooltipId = null;
    }

    /**
     * Check if a value is a valid Luxon DateTime.
     */
    _isValidDt(dt) {
        return dt && typeof dt === "object" && dt.isValid === true;
    }

    getInfoDuration(record) {
        // Determine hours per day:
        // - Planning mode (virtual dates): use project calendar hours_per_day (default 8)
        // - Normal mode: use calendarInfo hours_per_day (default 24 for continuous)
        const isPlanningMode = record._isVirtualDates;
        const calendarHpd = this.props.model.data?.calendarInfo?.hours_per_day;
        const hpd = isPlanningMode 
            ? (calendarHpd || 8)   // Planning mode: 8 hours/day default (working day)
            : (calendarHpd || 24); // Normal mode: 24 hours/day default (calendar day)

        // 1. Summary rows: the roll-up of their leaf descendants' scheduled
        //    hours (server-computed, never double-counting an intermediate
        //    level). This is a pure total — it is deliberately unrelated to the
        //    bar's length, because sibling tasks are not necessarily chained FS.
        const twhField = this.props.archInfo.totalWorkHours || "total_work_hours";
        if (record._hasChildren) {
            const total = record[twhField];
            return total > 0 ? this.formatDurationChinese(total, hpd) : "";
        }

        // 2. Leaf rows: the hours the user scheduled. plan_duration is the
        //    authoritative input — working_duration is only a cross-check of
        //    where the task currently sits, and must never override the input
        //    (that is what made the number jump on every cascade).
        if (record._planDuration && record._planDuration > 0) {
            return this.formatDurationChinese(record._planDuration, hpd);
        }

        // 3. Leaf with no scheduled hours yet: fall back to the calendar
        //    reading of its current window.
        const wdField = this.props.archInfo.workingDuration || "working_duration";
        const workingHours = record[wdField];
        if (workingHours && workingHours > 0) {
            return this.formatDurationChinese(workingHours, hpd);
        }
        return "";
    }

    getInfoDateRange(record) {
        // Use summary dates for parent tasks
        const ds = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const de = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (!this._isValidDt(ds)) return "";
        if (record._isVirtualDates) {
            const start = this._formatPlanningDay(ds);
            if (!this._isValidDt(de)) return start;
            return `${start}-${this._formatPlanningDay(de)}`;
        }
        const start = ds.toFormat("M/d");
        if (!this._isValidDt(de)) return start;
        const end = de.toFormat("M/d");
        return `${start}-${end}`;
    }

    getInfoStartDate(record) {
        const dt = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        if (!this._isValidDt(dt)) return "";
        if (record._isVirtualDates) return this._formatPlanningDay(dt);
        return dt.toFormat("M/d");
    }

    getInfoEndDate(record) {
        const dt = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (!this._isValidDt(dt)) return "";
        if (record._isVirtualDates) return this._formatPlanningDay(dt);
        return dt.toFormat("M/d");
    }

    /**
     * Convert a virtual DateTime to T+Xd label (working-day precision).
     * Reverses the scaleFactor applied by _rescaleVirtualDates to get
     * working hours, then divides by hpd to get working days.
     */
    _formatPlanningDay(dt) {
        const hpd = this.props.model.data?.calendarInfo?.hours_per_day || 8;
        const scaleFactor = hpd < 24 ? (24 / hpd) : 1;
        const virtualHours = dt.diff(PLANNING_T0, "hours").hours;
        const workingDays = virtualHours / scaleFactor / hpd;
        if (workingDays < 0.001) return "T";
        if (Math.abs(workingDays - Math.round(workingDays)) < 0.01) {
            return `T+${Math.round(workingDays)}d`;
        }
        // Sub-day: show 1 decimal
        return `T+${workingDays.toFixed(1)}d`;
    }

    // NOTE: the old _humanizeDuration() helper is gone. It existed only to turn
    // "calendar days × dpw/7" into a label for summary rows — an estimate that
    // matched neither the children's total hours nor the bar's real span.
    // Summary rows now show total_work_hours; bars show the real date span.

    // -------------------------------------------------------------------------
    // Planning Mode: Duration formatting & editing
    // -------------------------------------------------------------------------

    formatDurationChinese(hours, hpd) {
        if (!hours || hours <= 0) return "";
        hpd = hpd || this._calHpd || 24;
        const ws = this.props.model.data?.calendarInfo?._workingWeekdays;
        const dpw = (ws && ws.size > 0) ? ws.size : 7;
        return humanizeHours(hours, hpd, dpw);
    }

    _hoursToInputFormat(hours) {
        if (!hours) return "";
        const hpd = this._calHpd || 24;
        const totalMinutes = Math.round(hours * 60);
        const minutesPerDay = Math.round(hpd * 60);
        const d = Math.floor(totalMinutes / minutesPerDay);
        const remainMinutes = totalMinutes - d * minutesPerDay;
        const h = Math.floor(remainMinutes / 60);
        const m = remainMinutes % 60;
        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        return parts.join("") || "0d";
    }

    parseDurationInput(text) {
        const hpd = this._calHpd || 24;
        const dpw = this._calDpw || 7;
        const regex = /(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/gi;
        let totalHours = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const val = parseFloat(match[1]);
            switch (match[2].toLowerCase()) {
                case "w": totalHours += val * dpw * hpd; break;
                case "d": totalHours += val * hpd; break;
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
        // A summary row's hours are the sum of its leaves — not editable.
        if (record._hasChildren) return;
        this._startDurationEdit(record.id, infoEl);
    }

    _startDurationEdit(recordId, el) {
        const record = this.props.model.getRecord(recordId);
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
        this._activeDurationInput = input;
        input.focus();
        input.select();

        const finish = async (save) => {
            if (save) {
                const hours = this.parseDurationInput(input.value);
                if (hours > 0 && hours !== currentHours) {
                    await this.props.model.updatePlanDuration(recordId, hours);
                }
            }
            input.remove();
            if (this._activeDurationInput === input) {
                this._activeDurationInput = null;
            }
        };
        const onBlur = () => finish(true);
        input.addEventListener("blur", onBlur, { once: true });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); input.blur(); }
            if (e.key === "Escape") {
                input.removeEventListener("blur", onBlur);
                finish(false);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Planning Mode: Clear schedule (back to planning mode)
    // -------------------------------------------------------------------------

    async onClearScheduleClick(group, ev) {
        ev.stopPropagation();
        const clearTasks = await new Promise((resolve) => {
            this.displayDialog(ConfirmationDialog, {
                title: _t("清除排程日期"),
                body: _t("是否同步清除所有任務日期？"),
                confirmLabel: _t("清除任務日期（回到計劃模式）"),
                cancelLabel: _t("僅清除專案日期"),
                confirm: () => resolve(true),
                cancel: () => resolve(false),
                dismiss: () => resolve(false),
            });
        });
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
        let width = GanttRenderer.MIN_BAR_W;
        if (loadBar.dateEnd) {
            const right = this._dateToPx(loadBar.dateEnd);
            width = Math.max(right - left, GanttRenderer.MIN_MINIBAR_W);
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
        if (scale === "month") {
            return column.date.toFormat("yyyy/MM");
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
        const right = maxDate ? this._dateToPx(maxDate) : left + GanttRenderer.NO_END_BAR_W;
        const width = Math.max(right - left, GanttRenderer.MIN_BAR_W);
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
            const width = Math.max(right - left, GanttRenderer.MIN_MINIBAR_W);

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
        const record = this.props.model.getRecord(recordId);
        if (record) {
            this.onFocusClick(record);
            return;
        }
        // Fallback: direct bar scroll if record not found in data
        this.state.selectedRowId = recordId;
        if (this.props.onInspectorOpen) {
            if (!this.props.showInspectorPanel || this.props.inspectorRecordId !== recordId) {
                this.props.onInspectorOpen(recordId);
            }
        }
        requestAnimationFrame(() => {
            const bar = this.timelineDataRef.el?.querySelector(
                `.o_gantt_bar[data-record-id="${recordId}"]`
            );
            if (bar) {
                bar.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
                bar.classList.remove("o_gantt_bar_focus_pulse");
                void bar.offsetWidth;
                bar.classList.add("o_gantt_bar_focus_pulse");
                bar.addEventListener("animationend", () => {
                    bar.classList.remove("o_gantt_bar_focus_pulse");
                }, { once: true });
            }
        });
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
