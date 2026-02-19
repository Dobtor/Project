/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";
import { cellsDeltaToDuration, humanizeDays, formatDeltaLabel } from "./gantt_utils";

const { DateTime } = luxon;

/**
 * Convert a scale unit name to its duration in milliseconds.
 */
function _scaleToMs(scale) {
    if (scale === "1h") return 3600000;
    if (scale === "2h") return 7200000;
    if (scale === "4h") return 14400000;
    if (scale === "8h") return 28800000;
    if (scale === "week") return 604800000;
    if (scale === "month") return 2592000000;  // ~30 days
    return 86400000;  // default: day
}

/**
 * Custom OWL hook for bar dragging with direction detection.
 * - Horizontal drag (left/right): change start/end dates (original behavior)
 * - Vertical drag (up/down): reorder tasks (same as tree list drag)
 *
 * @param {Object} params
 * @param {Function} params.getTimelineEl - returns the timeline data DOM element
 * @param {Function} params.getCellWidth - returns current cell width in px
 * @param {Function} params.getTimeStart - returns Luxon DateTime for timeline start
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onDragEnd - (recordId, daysDelta) => Promise
 * @param {Function} [params.onVerticalReorder] - (recordId, targetId, position) => Promise
 * @param {Function} [params.getFlattenedRows] - () => array of row objects
 * @param {Function} [params.getListEl] - () => list rows DOM element
 */
export function useGanttBarDrag(params) {
    let isDragging = false;
    let dragBar = null;
    let recordId = null;
    let startX = 0;
    let startY = 0;
    let originalLeft = 0;
    let dragThresholdMet = false;
    let dragMode = null; // "horizontal" | "vertical"
    let hintEl = null;
    let minLeftDeltaX = -Infinity;  // Leftward pixel clamp from FS predecessor boundary

    // Vertical reorder state
    let reorderGhostEl = null;
    let reorderIndicatorTimeline = null;
    let reorderIndicatorList = null;
    let reorderTarget = null;
    let reorderPosition = "after";

    const THRESHOLD = 3; // px before drag starts
    const ROW_HEIGHT = 44;

    const onMove = useThrottleForAnimation((ev) => {
        if (!dragBar) return;

        const deltaX = ev.clientX - startX;
        const deltaY = ev.clientY - startY;

        if (!dragThresholdMet) {
            const absDx = Math.abs(deltaX);
            const absDy = Math.abs(deltaY);
            if (absDx < THRESHOLD && absDy < THRESHOLD) return;
            dragThresholdMet = true;

            if (absDy > absDx && params.onVerticalReorder) {
                // Vertical drag → reorder mode
                dragMode = "vertical";
                _createReorderGhost(ev);
                _createReorderIndicators();
                dragBar.classList.add("o_gantt_bar_dragging_vertical");
            } else {
                // Horizontal drag → date change mode
                dragMode = "horizontal";
                const record = params.getRecord(recordId);
                // Compute leftward clamp from FS predecessor boundary
                minLeftDeltaX = -Infinity;
                if (params.getMinStart) {
                    const minStart = params.getMinStart(recordId);
                    if (minStart) {
                        const currentStart = (record._hasChildren && record._summaryDateStart) || record._dateStart;
                        if (currentStart) {
                            const cellWidth = params.getCellWidth();
                            const scale = params.getScale ? params.getScale() : "day";
                            const diffMs = currentStart.toMillis() - minStart.toMillis();
                            const msPerCell = _scaleToMs(scale);
                            const maxLeftCells = diffMs / msPerCell;
                            minLeftDeltaX = -(maxLeftCells * cellWidth);
                        }
                    }
                }
                dragBar.classList.add("o_gantt_bar_dragging");
                _showHint();
            }
        }

        if (dragMode === "horizontal") {
            // Pixel-level drag with FS predecessor clamp
            let clampedDeltaX = deltaX;
            const hitBoundary = minLeftDeltaX > -Infinity && deltaX < minLeftDeltaX;
            if (hitBoundary) {
                clampedDeltaX = minLeftDeltaX;
            }
            // Visual feedback: red glow when hitting boundary
            if (hitBoundary) {
                dragBar.classList.add("o_gantt_bar_at_boundary");
            } else {
                dragBar.classList.remove("o_gantt_bar_at_boundary");
            }
            dragBar.style.left = `${originalLeft + clampedDeltaX}px`;
            _updateHint(clampedDeltaX);
        } else if (dragMode === "vertical") {
            // Move ghost near cursor
            if (reorderGhostEl) {
                reorderGhostEl.style.top = `${ev.clientY - 20}px`;
                reorderGhostEl.style.left = `${ev.clientX + 12}px`;
            }
            // Update drop target
            _updateReorderTarget(ev);
        }
    });

    function onPointerDown(ev) {
        const bar = ev.target.closest(".o_gantt_bar");
        if (!bar) return;

        // Skip resize handles, progress handle, and connector dots (arrow draw)
        if (ev.target.closest(".o_gantt_bar_resize_handle")) return;
        if (ev.target.closest(".o_gantt_bar_progress_handle")) return;
        if (ev.target.closest(".o_gantt_connector")) return;

        const rid = parseInt(bar.dataset.recordId, 10);
        if (!rid) return;

        const record = params.getRecord(rid);
        if (!record) return;

        // NOTE: Do NOT check auto-schedule here — vertical drag is allowed for all tasks.
        // Auto-schedule check is deferred to threshold stage (only for horizontal mode).

        ev.preventDefault();
        isDragging = true;
        dragBar = bar;
        recordId = rid;
        startX = ev.clientX;
        startY = ev.clientY;
        originalLeft = parseFloat(bar.style.left) || 0;
        dragThresholdMet = false;
        dragMode = null;

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });
    }

    function onPointerUp(ev) {
        document.removeEventListener("pointermove", onMove);

        if (!dragBar || !dragThresholdMet) {
            _cleanup();
            return;
        }

        if (dragMode === "horizontal") {
            let finalDeltaX = ev.clientX - startX;
            const wasClamped = minLeftDeltaX > -Infinity && finalDeltaX < minLeftDeltaX;
            if (wasClamped) {
                finalDeltaX = minLeftDeltaX;
            }
            const cellWidth = params.getCellWidth();
            // Fractional cell delta for sub-cell (minute-level) precision
            const cellsDelta = finalDeltaX / cellWidth;

            dragBar.classList.remove("o_gantt_bar_dragging");
            dragBar.classList.remove("o_gantt_bar_at_boundary");
            _removeHint();

            // Boundary hit: snap animation + notification
            if (wasClamped) {
                const barEl = dragBar; // capture ref before cleanup nulls dragBar
                barEl.classList.add("o_gantt_bar_boundary_snap");
                setTimeout(() => barEl.classList.remove("o_gantt_bar_boundary_snap"), 500);
                if (params.onBoundaryHit) {
                    params.onBoundaryHit(recordId);
                }
            }

            if (Math.abs(cellsDelta) > 0.01) {
                params.onDragEnd(recordId, cellsDelta);
            } else {
                // Snap back
                dragBar.style.left = `${originalLeft}px`;
            }
        } else if (dragMode === "vertical") {
            dragBar.classList.remove("o_gantt_bar_dragging_vertical");

            if (reorderTarget && reorderTarget.recordId !== recordId && params.onVerticalReorder) {
                params.onVerticalReorder(recordId, reorderTarget.recordId, reorderPosition);
            }
        }

        _cleanup();
    }

    // -------------------------------------------------------------------------
    // Horizontal drag helpers (hint tooltip)
    // -------------------------------------------------------------------------

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
        const cellsDelta = deltaX / cellWidth;
        const record = params.getRecord(recordId);
        const scale = params.getScale ? params.getScale() : "day";
        // Convert fractional cell delta to a Luxon-compatible duration
        const shiftDur = cellsDeltaToDuration(cellsDelta, scale);

        const hpd = params.getCalHpd ? params.getCalHpd() : 24;
        const dpw = params.getCalDpw ? params.getCalDpw() : 7;
        const ds = record && ((record._hasChildren && record._summaryDateStart) || record._dateStart);
        const de = record && ((record._hasChildren && record._summaryDateEnd) || record._dateEnd);
        if (record && ds) {
            const newStart = ds.plus(shiftDur);
            const newEnd = de ? de.plus(shiftDur) : null;

            let durationStr = "";
            if (newEnd) {
                const calDays = Math.round(newEnd.diff(newStart, "days").days * 10) / 10;
                const workDays = Math.round(calDays * (dpw / 7) * 10) / 10;
                durationStr = humanizeDays(workDays, dpw);
            }

            const lines = [];
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">\u958B\u59CB:</span> ${newStart.toFormat("M/d HH:mm")}</div>`);
            if (newEnd) {
                lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">\u7D50\u675F:</span> ${newEnd.toFormat("M/d HH:mm")}</div>`);
            }
            if (durationStr) {
                lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">\u5DE5\u671F:</span> ${durationStr}</div>`);
            }
            const deltaLabel = formatDeltaLabel(cellsDelta, scale, hpd);
            lines.push(`<div class="o_gantt_hint_delta">${deltaLabel}</div>`);
            hintEl.innerHTML = lines.join("");
        } else {
            const deltaLabel = formatDeltaLabel(cellsDelta, scale, hpd);
            hintEl.textContent = deltaLabel;
        }

        // Position near cursor
        const rect = dragBar.getBoundingClientRect();
        hintEl.style.left = `${rect.left + rect.width / 2}px`;
        hintEl.style.top = `${rect.top - 60}px`;
        hintEl.style.transform = "translateX(-50%)";
    }

    function _removeHint() {
        if (hintEl && hintEl.parentNode) {
            hintEl.parentNode.removeChild(hintEl);
        }
        hintEl = null;
    }

    // -------------------------------------------------------------------------
    // Vertical reorder helpers
    // -------------------------------------------------------------------------

    function _createReorderGhost(ev) {
        reorderGhostEl = document.createElement("div");
        reorderGhostEl.className = "o_gantt_vertical_reorder_ghost";
        const record = params.getRecord(recordId);
        reorderGhostEl.textContent = record?.display_name || "";
        reorderGhostEl.style.top = `${ev.clientY - 20}px`;
        reorderGhostEl.style.left = `${ev.clientX + 12}px`;
        document.body.appendChild(reorderGhostEl);
    }

    function _createReorderIndicators() {
        // Timeline indicator
        const timelineEl = params.getTimelineEl();
        if (timelineEl) {
            reorderIndicatorTimeline = document.createElement("div");
            reorderIndicatorTimeline.className = "o_gantt_vertical_drop_indicator";
            reorderIndicatorTimeline.style.display = "none";
            timelineEl.style.position = "relative";
            timelineEl.appendChild(reorderIndicatorTimeline);
        }

        // List indicator (synced)
        const listEl = params.getListEl ? params.getListEl() : null;
        if (listEl) {
            reorderIndicatorList = document.createElement("div");
            reorderIndicatorList.className = "o_gantt_vertical_drop_indicator";
            reorderIndicatorList.style.display = "none";
            listEl.style.position = "relative";
            listEl.appendChild(reorderIndicatorList);
        }
    }

    function _updateReorderTarget(ev) {
        const timelineEl = params.getTimelineEl();
        if (!timelineEl) return;

        const rows = params.getFlattenedRows ? params.getFlattenedRows() : [];
        const taskRows = rows.filter(r => !r._isGroup);
        if (taskRows.length === 0) return;

        // Find the timeline row elements to determine Y positions
        const timelineRows = timelineEl.querySelectorAll(".o_gantt_timeline_row:not(.o_gantt_group_row)");
        let closestRow = null;
        let closestDist = Infinity;
        let isAbove = false;
        let closestRowRect = null;

        for (const rowEl of timelineRows) {
            const rect = rowEl.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const dist = Math.abs(ev.clientY - midY);

            if (dist < closestDist) {
                closestDist = dist;
                closestRow = rowEl;
                isAbove = ev.clientY < midY;
                closestRowRect = rect;
            }
        }

        if (!closestRow) return;

        // Find matching record from timeline row's index within non-group rows
        // We need to get the record from the bar inside the row
        const barEl = closestRow.querySelector(".o_gantt_bar[data-record-id]");
        if (!barEl) return;
        const targetRid = parseInt(barEl.dataset.recordId, 10);
        if (!targetRid || targetRid === recordId) {
            // Hide indicators when over own row
            if (reorderIndicatorTimeline) reorderIndicatorTimeline.style.display = "none";
            if (reorderIndicatorList) reorderIndicatorList.style.display = "none";
            reorderTarget = null;
            return;
        }

        reorderTarget = { recordId: targetRid };
        reorderPosition = isAbove ? "before" : "after";

        // Position timeline indicator
        if (reorderIndicatorTimeline) {
            const timelineRect = timelineEl.getBoundingClientRect();
            const yPos = isAbove
                ? closestRowRect.top - timelineRect.top + timelineEl.scrollTop
                : closestRowRect.bottom - timelineRect.top + timelineEl.scrollTop;
            reorderIndicatorTimeline.style.display = "block";
            reorderIndicatorTimeline.style.top = `${yPos}px`;
        }

        // Position list indicator (synced)
        const listEl = params.getListEl ? params.getListEl() : null;
        if (listEl && reorderIndicatorList) {
            // Find matching list row
            const listRows = listEl.querySelectorAll(".o_gantt_list_row:not(.o_gantt_group_row)");
            for (const listRow of listRows) {
                const rid = parseInt(listRow.dataset.recordId, 10);
                if (rid === targetRid) {
                    const listRect = listEl.getBoundingClientRect();
                    const rowRect = listRow.getBoundingClientRect();
                    const yPos = isAbove
                        ? rowRect.top - listRect.top + listEl.scrollTop
                        : rowRect.bottom - listRect.top + listEl.scrollTop;
                    reorderIndicatorList.style.display = "block";
                    reorderIndicatorList.style.top = `${yPos}px`;
                    break;
                }
            }
        }
    }

    function _removeReorderElements() {
        if (reorderGhostEl && reorderGhostEl.parentNode) {
            reorderGhostEl.parentNode.removeChild(reorderGhostEl);
        }
        reorderGhostEl = null;

        if (reorderIndicatorTimeline && reorderIndicatorTimeline.parentNode) {
            reorderIndicatorTimeline.parentNode.removeChild(reorderIndicatorTimeline);
        }
        reorderIndicatorTimeline = null;

        if (reorderIndicatorList && reorderIndicatorList.parentNode) {
            reorderIndicatorList.parentNode.removeChild(reorderIndicatorList);
        }
        reorderIndicatorList = null;

        reorderTarget = null;
    }

    // -------------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------------

    function _cleanup() {
        isDragging = false;
        dragBar = null;
        recordId = null;
        dragThresholdMet = false;
        dragMode = null;
        minLeftDeltaX = -Infinity;
        _removeHint();
        _removeReorderElements();
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
