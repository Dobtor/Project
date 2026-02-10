/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";

/**
 * Custom OWL hook for dragging the progress handle on Gantt bars.
 * Allows users to visually drag progress from 0-100%.
 *
 * @param {Object} params
 * @param {Function} params.getTimelineEl - returns the timeline data DOM element
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onProgressEnd - (recordId, newProgress) => Promise
 */
export function useGanttProgressDrag(params) {
    let isDragging = false;
    let dragBar = null;
    let progressFill = null;
    let progressHandle = null;
    let recordId = null;
    let barWidth = 0;
    let startX = 0;
    let startProgress = 0;
    let dragThresholdMet = false;
    let hintEl = null;

    const THRESHOLD = 3; // px before drag starts

    const onMove = useThrottleForAnimation((ev) => {
        if (!dragBar) return;

        const deltaX = ev.clientX - startX;

        if (!dragThresholdMet) {
            if (Math.abs(deltaX) < THRESHOLD) return;
            dragThresholdMet = true;
            dragBar.classList.add("o_gantt_bar_progress_dragging");
            _showHint();
        }

        const deltaPercent = (deltaX / barWidth) * 100;
        const newProgress = Math.max(0, Math.min(100, startProgress + deltaPercent));

        // Update visual in real-time
        if (progressFill) {
            progressFill.style.width = `${newProgress}%`;
        }
        if (progressHandle) {
            progressHandle.style.left = `${newProgress}%`;
        }

        _updateHint(newProgress, ev);
    });

    function onPointerDown(ev) {
        const handle = ev.target.closest(".o_gantt_bar_progress_handle");
        if (!handle) return;

        const bar = handle.closest(".o_gantt_bar");
        if (!bar) return;

        // Skip summary/parent bars
        if (bar.classList.contains("o_gantt_summary")) return;

        // Skip auto-scheduled tasks
        if (bar.classList.contains("o_gantt_bar_auto")) return;

        const rid = parseInt(bar.dataset.recordId, 10);
        if (!rid) return;

        const record = params.getRecord(rid);
        if (!record) return;

        // Prevent bar drag from interfering
        ev.stopPropagation();
        ev.preventDefault();

        isDragging = true;
        dragBar = bar;
        recordId = rid;
        startX = ev.clientX;
        barWidth = bar.offsetWidth;
        startProgress = record._progress || 0;
        dragThresholdMet = false;

        progressFill = bar.querySelector(".o_gantt_bar_progress");
        progressHandle = handle;

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
        const deltaPercent = (deltaX / barWidth) * 100;
        const newProgress = Math.max(0, Math.min(100, startProgress + deltaPercent));
        const rounded = Math.round(newProgress);

        dragBar.classList.remove("o_gantt_bar_progress_dragging");
        _removeHint();

        if (rounded !== Math.round(startProgress)) {
            params.onProgressEnd(recordId, rounded);
        } else {
            // Snap back
            if (progressFill) {
                progressFill.style.width = `${startProgress}%`;
            }
            if (progressHandle) {
                progressHandle.style.left = `${startProgress}%`;
            }
        }

        _cleanup();
    }

    function _showHint() {
        hintEl = document.createElement("div");
        hintEl.className = "o_gantt_drag_hint";
        hintEl.style.cssText =
            "position:fixed;z-index:1000;padding:4px 10px;background:var(--gantt-surface-elevated);" +
            "border-radius:var(--gantt-radius-sm);box-shadow:var(--gantt-shadow-md);" +
            "font-size:12px;font-weight:600;color:var(--gantt-label-primary);pointer-events:none;" +
            "white-space:nowrap;";
        document.body.appendChild(hintEl);
    }

    function _updateHint(progress, ev) {
        if (!hintEl || !dragBar) return;

        const rounded = Math.round(progress);
        hintEl.textContent = `${rounded}%`;

        // Position near cursor
        const rect = dragBar.getBoundingClientRect();
        hintEl.style.left = `${ev.clientX}px`;
        hintEl.style.top = `${rect.top - 32}px`;
        hintEl.style.transform = "translateX(-50%)";
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
        progressFill = null;
        progressHandle = null;
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
