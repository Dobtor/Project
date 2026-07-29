/** @odoo-module **/

import { useGanttBarDrag } from "./gantt_bar_drag_hook";
import { useGanttBarResize } from "./gantt_bar_resize_hook";
import { useGanttDeadlineDrag } from "./gantt_deadline_drag_hook";
import { useGanttProgressDrag } from "./gantt_progress_drag_hook";
import { useGanttMarquee } from "./gantt_marquee_hook";
import { useGanttTreeDrag } from "./gantt_tree_drag_hook";
import { useGanttArrowDraw } from "./gantt_arrow_draw_hook";
import { useGanttGutter } from "./gantt_gutter_hook";
import { cellsDeltaToDuration, PLANNING_T0 } from "./gantt_utils";

/**
 * Pointer gestures — what a drag, a resize, a marquee or a drawn dependency
 * DOES once the hook that tracks the pointer says it happened.
 *
 * Mixed into GanttRenderer's prototype (see the bottom of gantt_renderer.js).
 * The hooks themselves live one file further out (gantt_*_hook.js) and only
 * care about pointer mechanics; everything here is this module's semantics:
 * which record moved, what the axis says the new date is, which FS boundary
 * clamps it, and which server call commits it.
 *
 * It is one method rather than eight parameter builders because the hooks
 * install OWL lifecycle callbacks — they may only be called from setup(), and
 * keeping them in one place makes that requirement obvious.
 */
export const GanttGesturesMixin = {
    /** Install every pointer gesture. MUST be called from setup(). */
    _setupGestures() {
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
            shiftDate: (dt, cellsDelta) => this._shiftByCells(dt, cellsDelta),
            // Hours of WORK between two instants — what the server will
            // store as the task's scheduled hours, so the live hint shows
            // the number the gesture actually produces (a window spanning
            // a lunch break is not 9 hours of work).
            getWorkHours: (from, to) => this._useWorkTimeAxis
                ? this._workingHoursBetween(from, to)
                : to.diff(from, "hours").hours,
            // Hints read the PROJECT's clock: a bar dropped at 09:00 of the
            // project's day must say 09:00, whatever zone the viewer is in.
            formatDate: (dt, fmt) => this._zoned(dt).toFormat(fmt),
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

                // --- Parent task: move with all descendants ---
                if (record._hasChildren) {
                    const summaryStart = record._summaryDateStart || record._dateStart;
                    if (!summaryStart) return;
                    let newStart = this._shiftByCells(summaryStart, cellsDelta);
                    // Clamp to FS predecessor constraints (own + all descendants)
                    const minStart = this.props.model.getMinStartForParentDrag(recordId);
                    if (minStart && newStart < minStart) {
                        newStart = minStart;
                    }
                    let shiftHours = newStart.diff(summaryStart, "hours").hours;
                    // Virtual timeline hours must be converted to working hours for the backend
                    if (record._isVirtualDates) {
                        // The summary dates of a planning subtree are already in
                        // working hours; the difference needs no conversion.
                    }
                    if (Math.abs(shiftHours) < 0.01) return;
                    await this.props.model.moveAndCascade(recordId, null, shiftHours);
                    return;
                }

                // --- Milestone: update deadline_datetime ---
                if (record._isMilestoneRecord) {
                    let newDate = record._dateStart
                        ? this._shiftByCells(record._dateStart, cellsDelta) : null;
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
                    // Planning mode: a cell IS a unit of planned work, so the
                    // drag delta converts straight to working hours.
                    const shiftWorkingHours = cellsDelta * this._planCellHours;
                    let newOffset = Math.max(0, (record._planOffset || 0) + shiftWorkingHours);
                    // Clamp to FS predecessor end
                    if (minStart) {
                        const minOffset = minStart.diff(PLANNING_T0, "hours").hours;
                        if (newOffset < minOffset) newOffset = minOffset;
                    }
                    const planOffsetField = this.props.archInfo.planOffset || "plan_offset";
                    await this.props.model.moveAndCascade(recordId, { [planOffsetField]: newOffset });
                } else if (record._scheduleMode === "auto") {
                    // Auto mode: convert drag to SNET constraint instead of overwriting dates
                    let newStart = record._dateStart
                        ? this._shiftByCells(record._dateStart, cellsDelta) : null;
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
                    let newStart = record._dateStart
                        ? this._shiftByCells(record._dateStart, cellsDelta) : null;
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
                    // ONE shift for the whole selection, measured on the axis the
                    // bars were dragged along: a cell is a working day, not 24
                    // clock hours. The first selected row is the reference; rows
                    // that cross a weekend land slightly differently, and the
                    // server re-derives every moved leaf from its scheduled hours
                    // afterwards, so they still end inside working time.
                    const ref = recordIds
                        .map(id => this.props.model.getRecord(id))
                        .find(r => r && r._dateStart);
                    let shiftHours;
                    if (ref && ref._isVirtualDates) {
                        shiftHours = cellsDelta * this._planCellHours;
                    } else if (ref) {
                        shiftHours = this._shiftByCells(ref._dateStart, cellsDelta)
                            .diff(ref._dateStart, "hours").hours;
                    } else {
                        const d = cellsDeltaToDuration(cellsDelta, this.props.scale);
                        shiftHours = (d.hours || 0) + (d.days || 0) * 24
                            + (d.weeks || 0) * 168 + (d.months || 0) * 720;
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
            shiftDate: (dt, cellsDelta) => this._shiftByCells(dt, cellsDelta),
            // Hours of WORK between two instants — what the server will
            // store as the task's scheduled hours, so the live hint shows
            // the number the gesture actually produces (a window spanning
            // a lunch break is not 9 hours of work).
            getWorkHours: (from, to) => this._useWorkTimeAxis
                ? this._workingHoursBetween(from, to)
                : to.diff(from, "hours").hours,
            // Hints read the PROJECT's clock: a bar dropped at 09:00 of the
            // project's day must say 09:00, whatever zone the viewer is in.
            formatDate: (dt, fmt) => this._zoned(dt).toFormat(fmt),
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
                    // Planning mode: a cell IS a unit of planned work, so the
                    // resize delta converts straight to working hours.
                    const minDuration = this._calHpd; // Minimum 1 working day
                    const shiftWorkingHours = cellsDelta * this._planCellHours;
                    if (side === "right") {
                        let newDuration = Math.max(minDuration, (record._planDuration || this._calHpd) + shiftWorkingHours);
                        // Clamp to FF/SF predecessor min end
                        if (minEnd) {
                            const minEndWorking = minEnd.diff(PLANNING_T0, "hours").hours;
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
                            const minOffsetWorking = minStart.diff(PLANNING_T0, "hours").hours;
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
                    let newEnd = this._shiftByCells(record._dateEnd, cellsDelta);
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
                    const values = {};
                    if (side === "left" && record._dateStart) {
                        let newStart = this._shiftByCells(record._dateStart, cellsDelta);
                        // Clamp to FS predecessor end
                        if (minStart && newStart < minStart) {
                            newStart = minStart;
                        }
                        values[dateStartField] = newStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                    } else if (side === "right" && record._dateEnd) {
                        let newEnd = this._shiftByCells(record._dateEnd, cellsDelta);
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
                const newDeadline = this._shiftByCells(record._dateDeadline, cellsDelta);
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
    },
};
