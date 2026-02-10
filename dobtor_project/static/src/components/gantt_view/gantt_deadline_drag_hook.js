/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";

const { DateTime } = luxon;

/**
 * Custom OWL hook for horizontal deadline marker dragging.
 * Drags the deadline diamond to change the deadline date.
 *
 * @param {Object} params
 * @param {Function} params.getTimelineEl - returns the timeline data DOM element
 * @param {Function} params.getCellWidth - returns current cell width in px
 * @param {Function} params.getTimeStart - returns Luxon DateTime for timeline start
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onDragEnd - (recordId, cellsDelta) => Promise
 */
export function useGanttDeadlineDrag(params) {
    let isDragging = false;
    let marker = null;
    let recordId = null;
    let startX = 0;
    let originalLeft = 0;
    let dragThresholdMet = false;
    let hintEl = null;

    const THRESHOLD = 3;

    const onMove = useThrottleForAnimation((ev) => {
        if (!marker) return;

        const deltaX = ev.clientX - startX;

        if (!dragThresholdMet) {
            if (Math.abs(deltaX) < THRESHOLD) return;
            dragThresholdMet = true;
            marker.classList.add("o_gantt_deadline_dragging");
            _showHint();
        }

        marker.style.left = `${originalLeft + deltaX}px`;
        _updateHint(deltaX);
    });

    function onPointerDown(ev) {
        const el = ev.target.closest(".o_gantt_deadline_marker");
        if (!el) return;

        // Find the parent timeline row to get the record id
        const row = el.closest(".o_gantt_timeline_row");
        if (!row) return;

        // Get record id from the bar in the same row
        const bar = row.querySelector(".o_gantt_bar");
        if (!bar) return;

        const rid = parseInt(bar.dataset.recordId, 10);
        if (!rid) return;

        const record = params.getRecord(rid);
        if (!record || !record._dateDeadline) return;

        // Skip auto-scheduled tasks (dates are computed by scheduler)
        if (record._scheduleMode === "auto") return;

        ev.preventDefault();
        ev.stopPropagation();

        isDragging = true;
        marker = el;
        recordId = rid;
        startX = ev.clientX;
        originalLeft = parseFloat(el.style.left) || 0;
        dragThresholdMet = false;

        // Make marker interactive during drag
        marker.style.pointerEvents = "auto";
        marker.style.zIndex = "100";

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });
    }

    function onPointerUp(ev) {
        document.removeEventListener("pointermove", onMove);

        if (!marker || !dragThresholdMet) {
            _cleanup();
            return;
        }

        const deltaX = ev.clientX - startX;
        const cellWidth = params.getCellWidth();
        const cellsDelta = Math.round(deltaX / cellWidth);

        marker.classList.remove("o_gantt_deadline_dragging");
        _removeHint();

        if (cellsDelta !== 0) {
            params.onDragEnd(recordId, cellsDelta);
        } else {
            marker.style.left = `${originalLeft}px`;
        }

        _cleanup();
    }

    function _showHint() {
        hintEl = document.createElement("div");
        hintEl.className = "o_gantt_drag_hint";
        hintEl.style.cssText =
            "position:fixed;z-index:1000;padding:4px 10px;background:var(--gantt-surface-elevated);" +
            "border-radius:var(--gantt-radius-sm);box-shadow:var(--gantt-shadow-md);" +
            "font-size:12px;font-weight:500;color:var(--gantt-accent-orange);pointer-events:none;" +
            "white-space:nowrap;";
        document.body.appendChild(hintEl);
    }

    function _updateHint(deltaX) {
        if (!hintEl || !marker) return;

        const cellWidth = params.getCellWidth();
        const cellsDelta = Math.round(deltaX / cellWidth);
        const record = params.getRecord(recordId);

        if (record && record._dateDeadline) {
            const newDeadline = record._dateDeadline.plus({ days: cellsDelta });
            hintEl.textContent = `Deadline: ${newDeadline.toFormat("MMM d, yyyy")}`;
        }

        const rect = marker.getBoundingClientRect();
        hintEl.style.left = `${rect.left}px`;
        hintEl.style.top = `${rect.top - 28}px`;
        hintEl.style.transform = "translateX(-50%)";
    }

    function _removeHint() {
        if (hintEl && hintEl.parentNode) {
            hintEl.parentNode.removeChild(hintEl);
        }
        hintEl = null;
    }

    function _cleanup() {
        if (marker) {
            marker.style.pointerEvents = "";
            marker.style.zIndex = "";
        }
        isDragging = false;
        marker = null;
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
