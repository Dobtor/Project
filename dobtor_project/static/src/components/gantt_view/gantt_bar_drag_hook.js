/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";

const { DateTime } = luxon;

/**
 * Custom OWL hook for horizontal bar dragging.
 * Drags a task bar left/right to change its start/end dates.
 *
 * @param {Object} params
 * @param {Function} params.getTimelineEl - returns the timeline data DOM element
 * @param {Function} params.getCellWidth - returns current cell width in px
 * @param {Function} params.getTimeStart - returns Luxon DateTime for timeline start
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onDragEnd - (recordId, daysDelta) => Promise
 * @param {Function} params.isSummary - (record) => boolean, skip summary bars
 */
export function useGanttBarDrag(params) {
    let isDragging = false;
    let dragBar = null;
    let recordId = null;
    let startX = 0;
    let originalLeft = 0;
    let dragThresholdMet = false;
    let hintEl = null;

    const THRESHOLD = 3; // px before drag starts

    const onMove = useThrottleForAnimation((ev) => {
        if (!dragBar) return;

        const deltaX = ev.clientX - startX;

        if (!dragThresholdMet) {
            if (Math.abs(deltaX) < THRESHOLD) return;
            dragThresholdMet = true;
            dragBar.classList.add("o_gantt_bar_dragging");
            _showHint();
        }

        dragBar.style.left = `${originalLeft + deltaX}px`;
        _updateHint(deltaX);
    });

    function onPointerDown(ev) {
        const bar = ev.target.closest(".o_gantt_bar");
        if (!bar) return;

        // Skip resize handles and progress handle
        if (ev.target.closest(".o_gantt_bar_resize_handle")) return;
        if (ev.target.closest(".o_gantt_bar_progress_handle")) return;

        // Skip summary/parent bars
        if (bar.classList.contains("o_gantt_summary")) return;

        const rid = parseInt(bar.dataset.recordId, 10);
        if (!rid) return;

        const record = params.getRecord(rid);
        if (!record) return;
        if (params.isSummary && params.isSummary(record)) return;

        // Skip auto-scheduled tasks (dates are computed by scheduler)
        if (record._scheduleMode === "auto") return;

        ev.preventDefault();
        isDragging = true;
        dragBar = bar;
        recordId = rid;
        startX = ev.clientX;
        originalLeft = parseFloat(bar.style.left) || 0;
        dragThresholdMet = false;

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });
    }

    function onPointerUp(ev) {
        document.removeEventListener("pointermove", onMove);

        if (!dragBar || !dragThresholdMet) {
            _cleanup();
            return;
        }

        const deltaX = ev.clientX - startX;
        const cellWidth = params.getCellWidth();
        const daysDelta = Math.round(deltaX / cellWidth);

        dragBar.classList.remove("o_gantt_bar_dragging");
        _removeHint();

        if (daysDelta !== 0) {
            params.onDragEnd(recordId, daysDelta);
        } else {
            // Snap back
            dragBar.style.left = `${originalLeft}px`;
        }

        _cleanup();
    }

    function _showHint() {
        hintEl = document.createElement("div");
        hintEl.className = "o_gantt_drag_hint o_gantt_drag_hint_structured";
        hintEl.style.cssText =
            "position:fixed;z-index:1000;padding:6px 12px;background:var(--gantt-surface-elevated);" +
            "border-radius:var(--gantt-radius-sm);box-shadow:var(--gantt-shadow-md);" +
            "font-size:12px;font-weight:500;color:var(--gantt-label-primary);pointer-events:none;" +
            "white-space:nowrap;";
        document.body.appendChild(hintEl);
    }

    function _updateHint(deltaX) {
        if (!hintEl || !dragBar) return;

        const cellWidth = params.getCellWidth();
        const daysDelta = Math.round(deltaX / cellWidth);
        const record = params.getRecord(recordId);

        if (record && record._dateStart) {
            const newStart = record._dateStart.plus({ days: daysDelta });
            const newEnd = record._dateEnd ? record._dateEnd.plus({ days: daysDelta }) : null;

            let durationStr = "";
            if (newEnd) {
                const days = Math.round(newEnd.diff(newStart, "days").days * 10) / 10;
                durationStr = _humanizeDays(days);
            }

            const lines = [];
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">Start:</span> ${newStart.toFormat("MMM d, yyyy")}</div>`);
            if (newEnd) {
                lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">End:</span> ${newEnd.toFormat("MMM d, yyyy")}</div>`);
            }
            if (durationStr) {
                lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">Duration:</span> ${durationStr}</div>`);
            }
            const sign = daysDelta >= 0 ? "+" : "";
            lines.push(`<div class="o_gantt_hint_delta">${sign}${daysDelta}d</div>`);
            hintEl.innerHTML = lines.join("");
        } else {
            const sign = daysDelta >= 0 ? "+" : "";
            hintEl.textContent = `${sign}${daysDelta}d`;
        }

        // Position near cursor
        const rect = dragBar.getBoundingClientRect();
        hintEl.style.left = `${rect.left + rect.width / 2}px`;
        hintEl.style.top = `${rect.top - 60}px`;
        hintEl.style.transform = "translateX(-50%)";
    }

    function _humanizeDays(days) {
        if (days < 1) {
            const hours = Math.round(days * 24);
            return `${hours}h`;
        }
        if (days < 7) {
            return `${days}d`;
        }
        const weeks = Math.floor(days / 7);
        const remainDays = Math.round(days % 7);
        if (remainDays === 0) return `${weeks}w`;
        return `${weeks}w ${remainDays}d`;
    }

    function _removeHint() {
        if (hintEl && hintEl.parentNode) {
            hintEl.parentNode.removeChild(hintEl);
        }
        hintEl = null;
    }

    function _cleanup() {
        isDragging = false;
        dragBar = null;
        recordId = null;
        dragThresholdMet = false;
        _removeHint();
    }

    onMounted(() => {
        const el = params.getTimelineEl();
        if (el) {
            el.addEventListener("pointerdown", onPointerDown);
        }
    });

    onWillUnmount(() => {
        const el = params.getTimelineEl();
        if (el) {
            el.removeEventListener("pointerdown", onPointerDown);
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onPointerUp);
        _cleanup();
    });
}
