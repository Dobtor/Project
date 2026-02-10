/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";

/**
 * Custom OWL hook for bar resize via left/right handles.
 *
 * @param {Object} params
 * @param {Function} params.getTimelineEl - returns the timeline data DOM element
 * @param {Function} params.getCellWidth - returns current cell width in px
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onResizeEnd - (recordId, side, daysDelta) => Promise
 * @param {Function} [params.onConstraintSet] - (recordId, constrainType, constrainDate) => Promise
 */
export function useGanttBarResize(params) {
    let isResizing = false;
    let isConstraintMode = false;
    let resizeBar = null;
    let recordId = null;
    let side = null; // "left" or "right"
    let startX = 0;
    let originalLeft = 0;
    let originalWidth = 0;
    let hintEl = null;

    const onMove = useThrottleForAnimation((ev) => {
        if (!isResizing || !resizeBar) return;

        const deltaX = ev.clientX - startX;
        const cellWidth = params.getCellWidth();
        const minWidth = cellWidth; // 1 day minimum

        if (side === "left") {
            // Adjusting start date: move left edge, adjust width inversely
            const newLeft = originalLeft + deltaX;
            const newWidth = originalWidth - deltaX;
            if (newWidth >= minWidth) {
                resizeBar.style.left = `${newLeft}px`;
                resizeBar.style.width = `${newWidth}px`;
            }
        } else {
            // Adjusting end date: only change width
            const newWidth = originalWidth + deltaX;
            if (newWidth >= minWidth) {
                resizeBar.style.width = `${newWidth}px`;
            }
        }

        _updateHint(deltaX);
    });

    function onPointerDown(ev) {
        const handle = ev.target.closest(".o_gantt_bar_resize_handle");
        if (!handle) return;

        const bar = handle.closest(".o_gantt_bar");
        if (!bar) return;

        // Skip summary bars
        if (bar.classList.contains("o_gantt_summary")) return;

        const rid = parseInt(bar.dataset.recordId, 10);
        if (!rid) return;

        // Check if Shift key is held for constraint mode
        const shiftHeld = ev.shiftKey;

        // Skip auto-scheduled tasks UNLESS Shift is held (constraint mode)
        const record = params.getRecord(rid);
        if (record && record._scheduleMode === "auto" && !shiftHeld) return;

        ev.preventDefault();
        ev.stopPropagation(); // Prevent drag hook from triggering

        isResizing = true;
        isConstraintMode = shiftHeld;
        resizeBar = bar;
        recordId = rid;
        side = handle.classList.contains("o_gantt_bar_resize_left") ? "left" : "right";
        startX = ev.clientX;
        originalLeft = parseFloat(bar.style.left) || 0;
        originalWidth = parseFloat(bar.style.width) || 0;

        bar.classList.add("o_gantt_bar_dragging");
        if (isConstraintMode) {
            bar.classList.add("o_gantt_bar_constraint_mode");
        }
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        _showHint();

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });
    }

    function onPointerUp(ev) {
        document.removeEventListener("pointermove", onMove);

        if (!isResizing || !resizeBar) {
            _cleanup();
            return;
        }

        const deltaX = ev.clientX - startX;
        const cellWidth = params.getCellWidth();
        const daysDelta = Math.round(deltaX / cellWidth);

        resizeBar.classList.remove("o_gantt_bar_dragging");
        resizeBar.classList.remove("o_gantt_bar_constraint_mode");
        _removeHint();

        if (isConstraintMode && daysDelta !== 0 && params.onConstraintSet) {
            // Constraint mode: set constraint instead of modifying dates
            const record = params.getRecord(recordId);
            if (record) {
                const constrainType = side === "left" ? "snet" : "fnet";
                const targetDate = side === "left"
                    ? record._dateStart.plus({ days: daysDelta })
                    : record._dateEnd.plus({ days: daysDelta });
                params.onConstraintSet(recordId, constrainType, targetDate.toISO());
            }
        } else if (daysDelta !== 0) {
            // Normal resize mode
            // Validate: for left resize, check that start stays before end
            const record = params.getRecord(recordId);
            if (record && record._dateStart && record._dateEnd) {
                let valid = true;
                if (side === "left") {
                    const newStart = record._dateStart.plus({ days: daysDelta });
                    if (newStart >= record._dateEnd) valid = false;
                } else {
                    const newEnd = record._dateEnd.plus({ days: daysDelta });
                    if (newEnd <= record._dateStart) valid = false;
                }
                if (valid) {
                    params.onResizeEnd(recordId, side, daysDelta);
                } else {
                    // Snap back
                    resizeBar.style.left = `${originalLeft}px`;
                    resizeBar.style.width = `${originalWidth}px`;
                }
            } else {
                params.onResizeEnd(recordId, side, daysDelta);
            }
        } else {
            // Snap back
            resizeBar.style.left = `${originalLeft}px`;
            resizeBar.style.width = `${originalWidth}px`;
        }

        _cleanup();
    }

    // --- Hint helpers ---

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
        if (!hintEl || !resizeBar) return;

        const cellWidth = params.getCellWidth();
        const daysDelta = Math.round(deltaX / cellWidth);
        const record = params.getRecord(recordId);

        if (isConstraintMode && record && record._dateStart && record._dateEnd) {
            // Constraint mode: show constraint type and target date
            const constraintType = side === "left" ? "SNET" : "FNET";
            const targetDate = side === "left"
                ? record._dateStart.plus({ days: daysDelta })
                : record._dateEnd.plus({ days: daysDelta });
            hintEl.innerHTML =
                `<div class="o_gantt_hint_row o_gantt_hint_constraint">` +
                `<span class="o_gantt_hint_label">${constraintType}</span> ` +
                `${targetDate.toFormat("MMM d, yyyy")}` +
                `</div>`;
        } else if (record && record._dateStart && record._dateEnd) {
            const newStart = side === "left"
                ? record._dateStart.plus({ days: daysDelta })
                : record._dateStart;
            const newEnd = side === "right"
                ? record._dateEnd.plus({ days: daysDelta })
                : record._dateEnd;

            const durationDays = Math.round(newEnd.diff(newStart, "days").days * 10) / 10;
            const durationStr = _humanizeDays(durationDays);

            const sideLabel = side === "left" ? "Start" : "End";
            const sign = daysDelta >= 0 ? "+" : "";

            const lines = [];
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">Start:</span> ${newStart.toFormat("MMM d, yyyy")}</div>`);
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">End:</span> ${newEnd.toFormat("MMM d, yyyy")}</div>`);
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">Duration:</span> ${durationStr}</div>`);
            lines.push(`<div class="o_gantt_hint_delta">${sideLabel} ${sign}${daysDelta}d</div>`);
            hintEl.innerHTML = lines.join("");
        } else {
            const sign = daysDelta >= 0 ? "+" : "";
            hintEl.textContent = `${sign}${daysDelta}d`;
        }

        // Position near the resize handle
        const rect = resizeBar.getBoundingClientRect();
        if (side === "left") {
            hintEl.style.left = `${rect.left}px`;
        } else {
            hintEl.style.left = `${rect.right}px`;
        }
        hintEl.style.top = `${rect.top - 60}px`;
        hintEl.style.transform = "translateX(-50%)";
    }

    function _humanizeDays(days) {
        if (days < 0) return "0d";
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
        isResizing = false;
        isConstraintMode = false;
        resizeBar = null;
        recordId = null;
        side = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
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
