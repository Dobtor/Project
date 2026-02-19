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
import { cellsDeltaToDuration, toOdooDatetime } from "./gantt_utils";
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
        // Calendar
        hideNonWorkingDays: { type: Boolean, optional: true },
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
            getCalHpd: () => this._calHpd,
            getCalDpw: () => this._calDpw,
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
                    let wasClamped = false;
                    if (minStart && newStart < minStart) {
                        newStart = minStart;
                        wasClamped = true;
                    }
                    const shiftHours = newStart.diff(summaryStart, "hours").hours;
                    if (Math.abs(shiftHours) < 0.01) return;
                    const moveOpts = wasClamped ? { context: { skip_date_snap: true } } : {};
                    await this.props.model.moveRecordWithChildren(recordId, shiftHours, moveOpts);
                    await this.props.model._pushFSSuccessors(recordId);
                    await this.props.model._pushAncestorFSSuccessors(recordId);
                    await this.props.model._recalcAndUpdateLags(recordId);
                    if (this.props.onReload) await this.props.onReload();
                    return;
                }

                // --- Milestone: update deadline_datetime ---
                if (record._isMilestoneRecord) {
                    let newDate = useWorkingMove && record._dateStart
                        ? this._addWorkingUnits(record._dateStart, cellsDelta)
                        : (record._dateStart ? record._dateStart.plus(shiftDur) : null);
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
                let wasClamped = false;

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
                        this.env.services.notification.add(
                            "\u7121\u6CD5\u4FEE\u6539\uFF1A\u65E5\u671F\u6B04\u4F4D\u70BA\u552F\u8B80",
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
                        wasClamped = true;
                    }
                    const values = {};
                    if (newStart) {
                        values[dateStartField] = newStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    if (record._dateEnd && record._dateStart) {
                        const duration = record._dateEnd.diff(record._dateStart);
                        values[dateStopField] = (newStart || record._dateStart).plus(duration).setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    const writeOpts = wasClamped ? { context: { skip_date_snap: true } } : {};
                    await this.props.model.updateRecord(recordId, values, writeOpts);
                }
                // Push FS successors if this task's end moved forward
                await this.props.model._pushFSSuccessors(recordId);
                await this.props.model._pushAncestorFSSuccessors(recordId);
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
            getCalHpd: () => this._calHpd,
            getCalDpw: () => this._calDpw,
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
                    const useWorkingMove = this._isHidingNonWorking();
                    const shiftDur = cellsDeltaToDuration(cellsDelta, this.props.scale);
                    const values = {};
                    let wasClamped = false;
                    if (side === "left" && record._dateStart) {
                        let newStart = useWorkingMove
                            ? this._addWorkingUnits(record._dateStart, cellsDelta)
                            : record._dateStart.plus(shiftDur);
                        // Clamp to FS predecessor end
                        if (minStart && newStart < minStart) {
                            newStart = minStart;
                            wasClamped = true;
                        }
                        values[dateStartField] = newStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    } else if (side === "right" && record._dateEnd) {
                        const newEnd = useWorkingMove
                            ? this._addWorkingUnits(record._dateEnd, cellsDelta)
                            : record._dateEnd.plus(shiftDur);
                        values[dateStopField] = newEnd.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    }
                    // Only skip snap when clamped to FS boundary; otherwise let
                    // Python directional snap handle non-work-hour positions.
                    const resizeOpts = wasClamped ? { context: { skip_date_snap: true } } : {};
                    await this.props.model.updateRecord(recordId, values, resizeOpts);
                }
                // Push FS successors if this task's end moved forward
                await this.props.model._pushFSSuccessors(recordId);
                await this.props.model._pushAncestorFSSuccessors(recordId);
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
                const useWorkingMove = this._isHidingNonWorking();
                const newDeadline = useWorkingMove
                    ? this._addWorkingUnits(record._dateDeadline, cellsDelta)
                    : record._dateDeadline.plus(cellsDeltaToDuration(cellsDelta, this.props.scale));
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
                        month: current.toFormat("yyyy\u5E74M\u6708"),
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
                        label: `${current.month}\u6708`,
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
        // Guard against invalid Luxon DateTimes
        if (!data.timeStart.isValid || (dt.isValid !== undefined && !dt.isValid)) return 0;

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
                for (let i = 0; i < cols.length; i++) {
                    const colStartMs = cols[i].date.toMillis();
                    const colEndMs = (i + 1 < cols.length)
                        ? cols[i + 1].date.toMillis()
                        : cols[i].date.plus(step).toMillis();
                    if (dtMs >= colStartMs && dtMs < colEndMs) {
                        const totalMs = colEndMs - colStartMs;
                        const frac = totalMs > 0 ? (dtMs - colStartMs) / totalMs : 0;
                        return (i + frac) * cw;
                    }
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
        const calendarInfo = this.props.model.data?.calendarInfo;
        if (!calendarInfo) return dt.plus({ days });
        const workingWeekdays = calendarInfo._workingWeekdays;
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

        // Find the column whose time range contains dt
        let srcIdx = -1;
        for (let i = 0; i < cols.length; i++) {
            const colMs = cols[i].date.toMillis();
            if (dt.toMillis() >= colMs && dt.toMillis() < colMs + msPerCol) {
                srcIdx = i;
                break;
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

    /** Hours per working day from the project's calendar (default 24). */
    get _calHpd() {
        return this.props.model.data?.calendarInfo?.hours_per_day || 24;
    }

    /** Working days per week from the project's calendar (default 7). */
    get _calDpw() {
        const ws = this.props.model.data?.calendarInfo?._workingWeekdays;
        return (ws && ws.size > 0) ? ws.size : 7;
    }

    get arrowProps() {
        const data = this.props.model.data;
        return {
            predecessors: data?.predecessors || [],
            milestoneLinks: data?.milestoneLinks || [],
            records: data?.records || [],
            flattenedRows: this.flattenedRows,
            dateToPx: (dt) => this._dateToPx(dt),
            rowHeight: 44,
            selectedRowId: this.state.selectedRowId,
            criticalField: this.props.archInfo.criticalPath || "",
            hpd: this._calHpd,
            dpw: this._calDpw,
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
        const hpd = this._calHpd;
        const dpw = this._calDpw;

        // 1. Server-calculated working hours (most accurate with calendar)
        const wdField = this.props.archInfo.workingDuration || "working_duration";
        const workingHours = record[wdField];
        if (workingHours && workingHours > 0 && !record._hasChildren) {
            return this.formatDurationChinese(workingHours, hpd);
        }

        // 2. plan_duration (user-specified working hours)
        if (record._planDuration && record._planDuration > 0 && !record._hasChildren) {
            return this.formatDurationChinese(record._planDuration, hpd);
        }

        // 3. Parent tasks: use summary date span
        const dateStart = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const dateEnd = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (this._isValidDt(dateStart) && this._isValidDt(dateEnd)
            && !record._isVirtualDates) {
            const calendarDays = dateEnd.diff(dateStart, "days").days;
            if (Number.isFinite(calendarDays)) {
                const workingDays = calendarDays * (dpw / 7);
                return this._humanizeDuration(workingDays, dpw);
            }
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

    _humanizeDuration(days, dpw = 7) {
        if (!Number.isFinite(days) || days <= 0) return "0\u5929";
        if (days < 1) {
            const hours = Math.round(days * (this._calHpd || 24));
            return `${hours}\u6642`;
        }
        if (days < dpw) {
            return `${Math.round(days * 10) / 10}\u5929`;
        }
        const weeks = Math.floor(days / dpw);
        const remain = Math.round(days % dpw);
        return remain > 0 ? `${weeks}\u9031${remain}\u5929` : `${weeks}\u9031`;
    }

    // -------------------------------------------------------------------------
    // Planning Mode: Duration formatting & editing
    // -------------------------------------------------------------------------

    formatDurationChinese(hours, hpd) {
        if (!hours || hours <= 0) return "";
        hpd = hpd || this._calHpd || 24;
        const d = Math.floor(hours / hpd);
        const remainH = hours - d * hpd;
        const h = Math.floor(remainH);
        const m = Math.round((remainH % 1) * 60) % 60;
        const parts = [];
        if (d > 0) parts.push(`${d}\u5929`);
        if (h > 0) parts.push(`${h}\u5c0f\u6642`);
        if (m > 0) parts.push(`${m}\u5206\u9418`);
        return parts.join("") || "0\u5c0f\u6642";
    }

    _hoursToInputFormat(hours) {
        if (!hours) return "";
        const hpd = this._calHpd || 24;
        const d = Math.floor(hours / hpd);
        const remainH = hours - d * hpd;
        const h = Math.floor(remainH);
        const m = Math.round((remainH % 1) * 60) % 60;
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
        if (scale === "month") {
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
        const record = this.props.model.data?.records?.find(r => r.id === recordId);
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
