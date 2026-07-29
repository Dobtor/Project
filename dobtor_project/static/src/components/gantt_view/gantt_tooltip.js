/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { PLANNING_T0 } from "./gantt_utils";

const { DateTime } = luxon;


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
        hoursPerDay: { type: Number, optional: true },
    };

    static defaultProps = {
        isPlanningMode: false,
        hoursPerDay: 8,  // Default 8 hours per working day
    };

    setup() {
        this.tooltipRef = useRef("tooltip");
        this.state = useState({
            visible: false,
            record: null,
        });

        this._onMouseOver = this._onMouseOver.bind(this);
        this._onMouseOut = this._onMouseOut.bind(this);
        this._hideTimeout = null;
        this._container = null;
        // Anchored to the timeline time header so the tooltip stays pinned to a
        // fixed top-right corner instead of following the cursor (which used to
        // cover the bar the user wants to click).
        this._anchorEl = null;

        onMounted(() => {
            const rootEl = this.tooltipRef.el?.closest(".o_gantt_content_wrapper");
            this._container = rootEl
                ? rootEl.querySelector(".o_gantt_timeline_data")
                : null;
            this._anchorEl = rootEl
                ? (rootEl.querySelector(".o_gantt_timeline_header")
                   || rootEl.querySelector(".o_gantt_timeline"))
                : null;
            if (this._container) {
                this._container.addEventListener("mouseover", this._onMouseOver);
                this._container.addEventListener("mouseout", this._onMouseOut);
            }
        });

        onWillUnmount(() => {
            if (this._container) {
                this._container.removeEventListener("mouseover", this._onMouseOver);
                this._container.removeEventListener("mouseout", this._onMouseOut);
            }
            this._container = null;
            this._anchorEl = null;
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

    /**
     * Fixed position: top-right corner of the timeline time header, using a
     * right/top offset so the tooltip width never matters and it never moves
     * with the pointer.
     */
    get tooltipStyle() {
        const anchor = this._anchorEl;
        if (!anchor) return "right: 16px; top: 64px;";
        const rect = anchor.getBoundingClientRect();
        const GAP = 8;
        const right = Math.max(GAP, window.innerWidth - rect.right + GAP);
        const top = rect.top + GAP;
        return `right: ${right}px; top: ${top}px;`;
    }

    /**
     * Convert a DateTime to a planning-mode relative day label.
     * e.g., PLANNING_T0 + 3 days → "T+3"
     */
    _toPlanningDay(dt) {
        if (!dt || !dt.isValid) return "";
        // A planning "date" is T0 + PLANNED HOURS (unscaled), so a working day
        // is hours_per_day of it — not 24.
        const hpd = this.props.hoursPerDay || 8;
        const dayOffset = Math.round(dt.diff(PLANNING_T0, "hours").hours / hpd);
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

        // Duration - show working days in planning mode
        if (inPlanning && record._planDuration > 0) {
            // Planning mode: use plan_duration and convert to working days
            // Use project calendar hours_per_day (default 8 hours per working day)
            const hoursPerDay = this.props.hoursPerDay || 8;
            const workingDays = record._planDuration / hoursPerDay;
            data.duration = _t("%(n)s天", { n: Math.round(workingDays * 10) / 10 });
        } else if (dateStart && dateEnd) {
            const days = dateEnd.diff(dateStart, "days").days;
            data.duration = _t("%(n)s天", { n: Math.round(days * 10) / 10 });
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
            data.scheduleMode = record._scheduleMode === "auto" ? _t("自動") : _t("手動");
        }

        // Fixed calc type (固定工期/固定工時)
        const fixedCalcField = archInfo.fixedCalcType;
        if (fixedCalcField && record[fixedCalcField]) {
            const calcLabels = { duration: _t("固定工期"), work: _t("固定工時") };
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
                let constraintLabel = record[constrainField].toUpperCase();
                if (record._constrainDate) {
                    constraintLabel += " " + record._constrainDate.toFormat("yyyy-MM-dd HH:mm");
                }
                data.constraint = constraintLabel;
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
