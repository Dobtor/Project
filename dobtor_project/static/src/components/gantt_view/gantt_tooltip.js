/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount } from "@odoo/owl";

const { DateTime } = luxon;

const PLANNING_T0 = DateTime.fromObject({ year: 2000, month: 1, day: 1 });

/**
 * Format a planning-mode relative label.
 * n > 0 → "T+3", n === 0 → "T0", n < 0 → "T-2"
 */
function planningLabel(prefix, n) {
    return `${prefix}${n > 0 ? "+" : ""}${n}`;
}

/**
 * Tooltip component that shows task details on bar hover.
 * Positioned near the mouse pointer, auto-adjusts to stay in viewport.
 */
export class GanttTooltip extends Component {
    static template = "dobtor_project.GanttTooltip";

    static props = {
        archInfo: Object,
        getRecord: Function,
        getPredecessorCount: { type: Function, optional: true },
        isPlanningMode: { type: Boolean, optional: true },
    };

    static defaultProps = {
        isPlanningMode: false,
    };

    setup() {
        this.tooltipRef = useRef("tooltip");
        this.state = useState({
            visible: false,
            x: 0,
            y: 0,
            record: null,
        });

        this._onMouseOver = this._onMouseOver.bind(this);
        this._onMouseOut = this._onMouseOut.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._hideTimeout = null;

        onMounted(() => {
            const container = document.querySelector(".o_gantt_timeline_data");
            if (container) {
                container.addEventListener("mouseover", this._onMouseOver);
                container.addEventListener("mouseout", this._onMouseOut);
                container.addEventListener("mousemove", this._onMouseMove);
            }
        });

        onWillUnmount(() => {
            const container = document.querySelector(".o_gantt_timeline_data");
            if (container) {
                container.removeEventListener("mouseover", this._onMouseOver);
                container.removeEventListener("mouseout", this._onMouseOut);
                container.removeEventListener("mousemove", this._onMouseMove);
            }
            clearTimeout(this._hideTimeout);
        });
    }

    _onMouseOver(ev) {
        const bar = ev.target.closest(".o_gantt_bar");
        if (!bar) return;

        clearTimeout(this._hideTimeout);

        const recordId = parseInt(bar.dataset.recordId, 10);
        if (!recordId) return;

        const record = this.props.getRecord(recordId);
        if (!record) return;

        this.state.record = record;
        this.state.visible = true;
        this._positionTooltip(ev);
    }

    _onMouseOut(ev) {
        const bar = ev.target.closest(".o_gantt_bar");
        if (!bar) return;

        // Delay hide to prevent flickering
        this._hideTimeout = setTimeout(() => {
            this.state.visible = false;
            this.state.record = null;
        }, 100);
    }

    _onMouseMove(ev) {
        if (!this.state.visible) return;
        this._positionTooltip(ev);
    }

    _positionTooltip(ev) {
        const OFFSET_X = 16;
        const OFFSET_Y = 16;
        let x = ev.clientX + OFFSET_X;
        let y = ev.clientY + OFFSET_Y;

        // Keep tooltip in viewport
        const el = this.tooltipRef.el;
        if (el) {
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            if (x + rect.width > vw - 10) {
                x = ev.clientX - rect.width - OFFSET_X;
            }
            if (y + rect.height > vh - 10) {
                y = ev.clientY - rect.height - OFFSET_Y;
            }
        }

        this.state.x = x;
        this.state.y = y;
    }

    /**
     * Convert a DateTime to a planning-mode relative day label.
     * e.g., PLANNING_T0 + 3 days → "T+3"
     */
    _toPlanningDay(dt) {
        if (!dt || !dt.isValid) return "";
        const dayOffset = Math.round(dt.diff(PLANNING_T0, "days").days);
        return planningLabel("T", dayOffset);
    }

    get tooltipData() {
        const record = this.state.record;
        if (!record) return null;

        const archInfo = this.props.archInfo;
        const inPlanning = this.props.isPlanningMode;
        const data = {
            name: record.display_name || "",
        };

        // Dates (use summary dates for parent tasks)
        const dateStart = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const dateEnd = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        if (dateStart) {
            data.dateStart = inPlanning
                ? this._toPlanningDay(dateStart)
                : dateStart.toFormat("yyyy/M/d");
        }
        if (dateEnd) {
            data.dateEnd = inPlanning
                ? this._toPlanningDay(dateEnd)
                : dateEnd.toFormat("yyyy/M/d");
        }

        // Duration
        if (dateStart && dateEnd) {
            const days = dateEnd.diff(dateStart, "days").days;
            data.duration = `${Math.round(days * 10) / 10} \u5929`;
        }

        // Progress (use summary progress for parent tasks)
        const progressVal = (record._hasChildren && record._summaryProgress != null)
            ? record._summaryProgress
            : record._progress;
        if (progressVal != null) {
            data.progress = `${Math.round(progressVal)}%`;
            data.progressPct = Math.min(Math.round(progressVal), 100);
        }

        // Schedule mode
        if (record._scheduleMode) {
            data.scheduleMode = record._scheduleMode === "auto" ? "\u81EA\u52D5" : "\u624B\u52D5";
        }

        // Fixed calc type (固定工期/固定工時)
        const fixedCalcField = archInfo.fixedCalcType;
        if (fixedCalcField && record[fixedCalcField]) {
            const calcLabels = { duration: "\u56FA\u5B9A\u5DE5\u671F", work: "\u56FA\u5B9A\u5DE5\u6642" };
            data.fixedCalcType = calcLabels[record[fixedCalcField]] || record[fixedCalcField];
        }

        // Deadline — hide in planning mode (no real dates)
        if (!inPlanning && record._dateDeadline) {
            data.deadline = record._dateDeadline.toFormat("yyyy/M/d");
            // Check if overdue
            if (record._dateEnd && record._dateEnd > record._dateDeadline) {
                data.deadlineOverdue = true;
            }
        }

        // Constraint — hide in planning mode (no real date constraints)
        if (!inPlanning) {
            const constrainField = archInfo.constrainType;
            if (constrainField && record[constrainField] &&
                record[constrainField] !== "asap") {
                data.constraint = record[constrainField].toUpperCase();
            }
        }

        // Critical path
        const criticalField = archInfo.criticalPath;
        if (criticalField && record[criticalField]) {
            data.isCritical = true;
        }

        // Milestone
        if (record._isMilestoneRecord) {
            data.isMilestone = true;
        }

        // Resource / Assignee
        const resourceField = archInfo.resourceField;
        if (resourceField && record[resourceField]) {
            const resVal = record[resourceField];
            data.resource = Array.isArray(resVal) ? resVal[1] : resVal;
        }

        // Predecessor count
        if (this.props.getPredecessorCount) {
            const count = this.props.getPredecessorCount(record.id);
            if (count > 0) {
                data.predecessorCount = count;
            }
        }

        return data;
    }
}
