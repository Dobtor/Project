/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useThrottleForAnimation } from "@web/core/utils/timing";
import { cellsDeltaToDuration, humanizeDays, formatDeltaLabel, escapeHtml } from "./gantt_utils";

function _scaleToMs(scale) {
    if (scale === "1h") return 3600000;
    if (scale === "2h") return 7200000;
    if (scale === "4h") return 14400000;
    if (scale === "8h") return 28800000;
    if (scale === "week") return 604800000;
    if (scale === "month") return 2592000000;
    return 86400000; // default: day
}

/**
 * Custom OWL hook for bar resize via left/right handles.
 *
 * @param {Object} params
 * @param {Function} params.getTimelineEl - returns the timeline data DOM element
 * @param {Function} params.getCellWidth - returns current cell width in px
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onResizeEnd - (recordId, side, cellsDelta) => Promise
 * @param {Function} [params.getScale] - () => current scale string (e.g. "day", "1h", "week")
 * @param {Function} [params.getMinEnd] - (recordId) => DateTime|null (FF/SF min end constraint)
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
    let minRightDeltaX = -Infinity; // FF/SF constraint for right-side resize
    let hintEl = null;

    const onMove = useThrottleForAnimation((ev) => {
        if (!isResizing || !resizeBar) return;

        const deltaX = ev.clientX - startX;
        const cellWidth = params.getCellWidth();
        if (!cellWidth) return;

        // Pixel-level resize (no grid snap) for minute-level precision.
        // The bar geometry itself is owned by OWL (getBarStyle reads _dragState
        // via onResizeMove); we only compute the reported delta and toggle the
        // boundary class here — no imperative style writes, so the bar and its
        // arrows can never disagree.
        let reportDelta = deltaX;
        if (side === "right") {
            // Clamp right-side shrink to FF/SF min-end boundary
            const hitBoundary = minRightDeltaX > -Infinity && deltaX < minRightDeltaX;
            if (hitBoundary) {
                reportDelta = minRightDeltaX;
                resizeBar.classList.add("o_gantt_bar_at_boundary");
            } else {
                resizeBar.classList.remove("o_gantt_bar_at_boundary");
            }
        }

        _updateHint(deltaX);
        // Live update so the bar's re-render and the dependency arrows follow
        // the resized edge instead of snapping back / detaching.
        if (params.onResizeMove) {
            params.onResizeMove(recordId, side, reportDelta);
        }
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
        // Exception: right-resize is allowed (modifies duration, not start date)
        const record = params.getRecord(rid);
        const isLeft = handle.classList.contains("o_gantt_bar_resize_left");
        if (record && record._scheduleMode === "auto" && !shiftHeld && isLeft) return;

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

        // Compute FF/SF min-end constraint for right-side resize
        minRightDeltaX = -Infinity;
        if (side === "right" && params.getMinEnd) {
            const minEnd = params.getMinEnd(rid);
            if (minEnd && record) {
                const currentEnd = record._dateEnd;
                if (currentEnd) {
                    const cellWidth2 = params.getCellWidth();
                    const scale2 = params.getScale ? params.getScale() : "day";
                    const diffMs = currentEnd.toMillis() - minEnd.toMillis();
                    const msPerCell = _scaleToMs(scale2);
                    const maxShrinkCells = diffMs / msPerCell;
                    minRightDeltaX = -(maxShrinkCells * cellWidth2);
                }
            }
        }

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
        if (!cellWidth) { _cleanup(); return; }
        // Fractional cell delta for sub-cell (minute-level) precision
        const cellsDelta = deltaX / cellWidth;

        resizeBar.classList.remove("o_gantt_bar_dragging");
        resizeBar.classList.remove("o_gantt_bar_constraint_mode");
        resizeBar.classList.remove("o_gantt_bar_at_boundary");
        _removeHint();

        const _scale = params.getScale ? params.getScale() : "day";
        const shiftDur = cellsDeltaToDuration(cellsDelta, _scale);

        if (isConstraintMode && Math.abs(cellsDelta) > 0.01 && params.onConstraintSet) {
            // Constraint mode: set constraint instead of modifying dates.
            // Guard the side-specific anchor date (left→start / right→end); a
            // date-less task can't anchor a constraint, so cancel the gesture.
            const record = params.getRecord(recordId);
            const anchorDate = record && (side === "left" ? record._dateStart : record._dateEnd);
            if (anchorDate) {
                const constrainType = side === "left" ? "snet" : "fnet";
                const targetDate = anchorDate.plus(shiftDur);
                // Odoo Datetime field expects UTC "yyyy-MM-dd HH:mm:ss" string format
                params.onConstraintSet(recordId, constrainType, targetDate.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss"));
            } else {
                params.onGestureCancel?.();
            }
        } else if (Math.abs(cellsDelta) > 0.01) {
            // Normal resize mode
            // Validate: for left resize, check that start stays before end
            const record = params.getRecord(recordId);
            if (record && record._dateStart && record._dateEnd) {
                let valid = true;
                if (side === "left") {
                    const newStart = record._dateStart.plus(shiftDur);
                    if (newStart >= record._dateEnd) valid = false;
                } else {
                    const newEnd = record._dateEnd.plus(shiftDur);
                    if (newEnd <= record._dateStart) valid = false;
                }
                if (valid) {
                    params.onResizeEnd(recordId, side, cellsDelta);
                } else {
                    // Snap back: drop the live offset, OWL restores the bar.
                    params.onGestureCancel?.();
                }
            } else {
                params.onResizeEnd(recordId, side, cellsDelta);
            }
        } else {
            // Snap back: drop the live offset, OWL restores the bar.
            params.onGestureCancel?.();
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
        if (!cellWidth) return;
        const cellsDelta = deltaX / cellWidth;
        const record = params.getRecord(recordId);
        const _scale = params.getScale ? params.getScale() : "day";

        const shiftDur = cellsDeltaToDuration(cellsDelta, _scale);

        if (isConstraintMode && record && record._dateStart && record._dateEnd) {
            const constraintType = side === "left" ? "SNET" : "FNET";
            const targetDate = side === "left"
                ? record._dateStart.plus(shiftDur)
                : record._dateEnd.plus(shiftDur);
            hintEl.innerHTML =
                `<div class="o_gantt_hint_row o_gantt_hint_constraint">` +
                `<span class="o_gantt_hint_label">${escapeHtml(constraintType)}</span> ` +
                `${escapeHtml(targetDate.toFormat("M/d HH:mm"))}` +
                `</div>`;
        } else if (record && record._dateStart && record._dateEnd) {
            const hpd = params.getCalHpd ? params.getCalHpd() : 24;
            const dpw = params.getCalDpw ? params.getCalDpw() : 7;
            // Use renderer's shiftDate for working-day-aware preview
            const newStart = side === "left"
                ? (params.shiftDate ? params.shiftDate(record._dateStart, cellsDelta) : record._dateStart.plus(shiftDur))
                : record._dateStart;
            const newEnd = side === "right"
                ? (params.shiftDate ? params.shiftDate(record._dateEnd, cellsDelta) : record._dateEnd.plus(shiftDur))
                : record._dateEnd;

            const diffHours = newEnd.diff(newStart, "hours").hours;
            const durationStr = humanizeDays(diffHours / hpd, dpw, hpd);

            const sideLabel = side === "left" ? _t("開始") : _t("結束");
            const deltaLabel = formatDeltaLabel(cellsDelta, _scale, hpd, dpw);

            const lines = [];
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">${escapeHtml(_t("開始"))}:</span> ${escapeHtml(newStart.toFormat("M/d HH:mm"))}</div>`);
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">${escapeHtml(_t("結束"))}:</span> ${escapeHtml(newEnd.toFormat("M/d HH:mm"))}</div>`);
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">${escapeHtml(_t("工期"))}:</span> ${escapeHtml(durationStr)}</div>`);
            lines.push(`<div class="o_gantt_hint_delta">${escapeHtml(sideLabel)} ${escapeHtml(deltaLabel)}</div>`);
            // Lag preview for FS predecessors
            if (params.getPredLagPreview) {
                const lagInfo = params.getPredLagPreview(recordId, cellsDelta, side);
                if (lagInfo && lagInfo.length > 0) {
                    for (const info of lagInfo) {
                        lines.push(`<div class="o_gantt_hint_row o_gantt_hint_lag"><span class="o_gantt_hint_label">${escapeHtml(info.type)} lag:</span> ${escapeHtml(info.currentLag)} → ${escapeHtml(info.newLag)}</div>`);
                    }
                }
            }
            hintEl.innerHTML = lines.join("");
        } else {
            const hpd = params.getCalHpd ? params.getCalHpd() : 24;
            const dpw2 = params.getCalDpw ? params.getCalDpw() : 7;
            hintEl.textContent = formatDeltaLabel(cellsDelta, _scale, hpd, dpw2);
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
        minRightDeltaX = -Infinity;
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
