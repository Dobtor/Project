/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount } from "@odoo/owl";

const { DateTime } = luxon;

/**
 * Tooltip component that shows task details on bar hover.
 * Positioned near the mouse pointer, auto-adjusts to stay in viewport.
 */
export class GanttTooltip extends Component {
    static template = "dobtor_project.GanttTooltip";

    static props = {
        archInfo: Object,
        getRecord: Function,
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

    get tooltipData() {
        const record = this.state.record;
        if (!record) return null;

        const archInfo = this.props.archInfo;
        const data = {
            name: record.display_name || "",
        };

        // Dates
        if (record._dateStart) {
            data.dateStart = record._dateStart.toFormat("MMM d, yyyy");
        }
        if (record._dateEnd) {
            data.dateEnd = record._dateEnd.toFormat("MMM d, yyyy");
        }

        // Duration
        if (record._dateStart && record._dateEnd) {
            const days = record._dateEnd.diff(record._dateStart, "days").days;
            data.duration = `${Math.round(days * 10) / 10} days`;
        }

        // Progress
        if (record._progress != null) {
            data.progress = `${Math.round(record._progress)}%`;
        }

        // Schedule mode
        if (record._scheduleMode) {
            data.scheduleMode = record._scheduleMode === "auto" ? "Auto" : "Manual";
        }

        // Deadline
        if (record._dateDeadline) {
            data.deadline = record._dateDeadline.toFormat("MMM d, yyyy");
            // Check if overdue
            if (record._dateEnd && record._dateEnd > record._dateDeadline) {
                data.deadlineOverdue = true;
            }
        }

        // Constraint
        const constrainField = archInfo.constrainType;
        if (constrainField && record[constrainField] &&
            record[constrainField] !== "asap") {
            data.constraint = record[constrainField].toUpperCase();
        }

        // Critical path
        const criticalField = archInfo.criticalPath;
        if (criticalField && record[criticalField]) {
            data.isCritical = true;
        }

        // Milestone
        if (record._isMilestone) {
            data.isMilestone = true;
        }

        return data;
    }
}
