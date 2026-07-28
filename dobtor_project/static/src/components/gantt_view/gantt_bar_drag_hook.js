/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useThrottleForAnimation } from "@web/core/utils/timing";
import { cellsDeltaToDuration, humanizeDays, formatDeltaLabel, escapeHtml } from "./gantt_utils";

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

    // Item 10: Multi-select drag state
    let isMultiDrag = false;
    let multiDragBars = [];  // [{barEl, recordId, originalLeft}]

    // Vertical reorder state
    let reorderGhostEl = null;
    let reorderIndicatorTimeline = null;
    let reorderIndicatorList = null;
    let reorderTarget = null;
    let reorderPosition = "after";

    // Cached row positions for binary search (built once per vertical drag)
    let cachedTimelineRows = null; // [{el, recordId, top, bottom, midY, height, listRowEl}, ...] sorted by top
    let cachedTimelineScrollTop = 0;
    let cachedListScrollTop = 0;

    const THRESHOLD = 3; // px before drag starts

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
                _buildTimelineRowCache();
                _createReorderGhost(ev);
                _createReorderIndicators();
                dragBar.classList.add("o_gantt_bar_dragging_vertical");
            } else {
                // Horizontal drag → date change mode
                dragMode = "horizontal";
                // Leftward FS clamp. For a multi-selection moving as a rigid
                // block, the binding constraint is the MOST restrictive (largest,
                // i.e. closest to 0) clamp across every selected task.
                minLeftDeltaX = _minLeftDeltaForRecord(recordId);
                if (isMultiDrag) {
                    for (const mb of multiDragBars) {
                        const d = _minLeftDeltaForRecord(mb.recordId);
                        if (d > minLeftDeltaX) minLeftDeltaX = d;
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
            // Geometry is owned by OWL: onDragMove updates _dragState and
            // getBarStyle re-renders every selected bar with the offset. No
            // imperative style writes here, so bars and their arrows stay glued.
            if (isMultiDrag) {
                for (const mb of multiDragBars) {
                    mb.barEl.classList.add("o_gantt_bar_dragging");
                }
            }
            _updateHint(clampedDeltaX);
            // Live arrow + bar update during drag
            if (params.onDragMove) {
                params.onDragMove(recordId, clampedDeltaX);
            }
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

        // Item 10: Check if this task is in the multi-selection
        isMultiDrag = false;
        multiDragBars = [];
        if (params.getSelectedIds) {
            const selectedIds = params.getSelectedIds();
            if (selectedIds.length > 1 && selectedIds.includes(rid)) {
                isMultiDrag = true;
                // Collect all selected bar elements and their original positions
                const timelineEl = params.getTimelineEl();
                if (timelineEl) {
                    for (const selId of selectedIds) {
                        if (selId === rid) continue; // primary bar handled separately
                        const selBar = timelineEl.querySelector(`.o_gantt_bar[data-record-id="${selId}"]`);
                        if (selBar) {
                            multiDragBars.push({
                                barEl: selBar,
                                recordId: selId,
                                originalLeft: parseFloat(selBar.style.left) || 0,
                            });
                        }
                    }
                }
            }
        }

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
            if (!cellWidth) { _cleanup(); return; }
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
                if (isMultiDrag && params.onMultiDragEnd) {
                    // Item 10: Multi-drag end — collect all selected IDs
                    const allIds = [recordId, ...multiDragBars.map(mb => mb.recordId)];
                    // Remove dragging class from multi-drag bars
                    for (const mb of multiDragBars) {
                        mb.barEl.classList.remove("o_gantt_bar_dragging");
                    }
                    params.onMultiDragEnd(allIds, cellsDelta);
                } else {
                    params.onDragEnd(recordId, cellsDelta);
                }
            } else {
                // Snap back: drop the live offset, OWL restores every bar.
                if (isMultiDrag) {
                    for (const mb of multiDragBars) {
                        mb.barEl.classList.remove("o_gantt_bar_dragging");
                    }
                }
                params.onGestureCancel?.();
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

    /**
     * Leftward pixel clamp for one record from its FS predecessor (or, for a
     * milestone, its linked tasks' latest end). Returns -Infinity when the
     * record is unconstrained. Negative = how far left it may move.
     */
    function _minLeftDeltaForRecord(rid) {
        const record = params.getRecord(rid);
        if (!record) return -Infinity;
        let minDate = null;
        let currentRef = null;
        if (record._isMilestoneRecord && params.getMinMilestoneDate) {
            minDate = params.getMinMilestoneDate(rid);
            currentRef = record._dateStart;
        } else if (params.getMinStart) {
            minDate = params.getMinStart(rid);
            currentRef = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        }
        if (!minDate || !currentRef) return -Infinity;
        const cellWidth = params.getCellWidth();
        const scale = params.getScale ? params.getScale() : "day";
        const diffMs = currentRef.toMillis() - minDate.toMillis();
        return -((diffMs / _scaleToMs(scale)) * cellWidth);
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
        if (!cellWidth) return;
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
            // Use renderer's shiftDate for working-day-aware preview
            const newStart = params.shiftDate
                ? params.shiftDate(ds, cellsDelta)
                : ds.plus(shiftDur);
            const newEnd = de
                ? (params.shiftDate ? params.shiftDate(de, cellsDelta) : de.plus(shiftDur))
                : null;

            // Duration display: a move never changes the scheduled hours, so
            // show the task's own planned hours (the authoritative input) and
            // only fall back to a measurement when it has none.
            let durationStr = "";
            if (newEnd) {
                const planned = record._planDuration || record.working_duration;
                if (planned && planned > 0) {
                    durationStr = humanizeDays(planned / hpd, dpw, hpd);
                } else {
                    const diffHours = newEnd.diff(newStart, "hours").hours;
                    durationStr = humanizeDays(diffHours / hpd, dpw, hpd);
                }
            }

            const lines = [];
            lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">${escapeHtml(_t("開始"))}:</span> ${escapeHtml(newStart.toFormat("M/d HH:mm"))}</div>`);
            if (newEnd) {
                lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">${escapeHtml(_t("結束"))}:</span> ${escapeHtml(newEnd.toFormat("M/d HH:mm"))}</div>`);
            }
            if (durationStr) {
                lines.push(`<div class="o_gantt_hint_row"><span class="o_gantt_hint_label">${escapeHtml(_t("工期"))}:</span> ${escapeHtml(durationStr)}</div>`);
            }
            const deltaLabel = formatDeltaLabel(cellsDelta, scale, hpd, dpw);
            lines.push(`<div class="o_gantt_hint_delta">${escapeHtml(deltaLabel)}</div>`);
            // Lag preview for FS predecessors
            if (params.getPredLagPreview) {
                const lagInfo = params.getPredLagPreview(recordId, cellsDelta);
                if (lagInfo && lagInfo.length > 0) {
                    for (const info of lagInfo) {
                        lines.push(`<div class="o_gantt_hint_row o_gantt_hint_lag"><span class="o_gantt_hint_label">${escapeHtml(info.type)} lag:</span> ${escapeHtml(info.currentLag)} → ${escapeHtml(info.newLag)}</div>`);
                    }
                }
            }
            hintEl.innerHTML = lines.join("");
        } else {
            const deltaLabel = formatDeltaLabel(cellsDelta, scale, hpd, dpw);
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

    function _buildTimelineRowCache() {
        const timelineEl = params.getTimelineEl();
        if (!timelineEl) {
            cachedTimelineRows = null;
            return;
        }
        cachedTimelineScrollTop = timelineEl.scrollTop;

        const listEl = params.getListEl ? params.getListEl() : null;
        cachedListScrollTop = listEl ? listEl.scrollTop : 0;

        // Build a map of recordId → list row element for quick lookup
        const listRowMap = {};
        if (listEl) {
            const listRows = listEl.querySelectorAll(".o_gantt_list_row:not(.o_gantt_group_row)");
            for (const lr of listRows) {
                const rid = parseInt(lr.dataset.recordId, 10);
                if (rid) {
                    listRowMap[rid] = {
                        el: lr,
                        rect: lr.getBoundingClientRect(),
                    };
                }
            }
        }

        const timelineRows = timelineEl.querySelectorAll(".o_gantt_timeline_row:not(.o_gantt_group_row)");
        cachedTimelineRows = [];

        for (const rowEl of timelineRows) {
            const barEl = rowEl.querySelector(".o_gantt_bar[data-record-id]");
            if (!barEl) continue;
            const rid = parseInt(barEl.dataset.recordId, 10);
            if (!rid || rid === recordId) continue;

            const rect = rowEl.getBoundingClientRect();
            const listInfo = listRowMap[rid] || null;

            cachedTimelineRows.push({
                el: rowEl,
                recordId: rid,
                top: rect.top,
                bottom: rect.bottom,
                midY: rect.top + rect.height / 2,
                height: rect.height,
                // List row cached info
                listTop: listInfo ? listInfo.rect.top : 0,
                listBottom: listInfo ? listInfo.rect.bottom : 0,
                hasListRow: !!listInfo,
            });
        }

        cachedTimelineRows.sort((a, b) => a.top - b.top);
    }

    /**
     * Binary search to find the closest timeline row to mouseY.
     * Returns {entry, isAbove, scrollDelta} or null.
     */
    function _findClosestTimelineRow(mouseY) {
        if (!cachedTimelineRows || cachedTimelineRows.length === 0) return null;

        const timelineEl = params.getTimelineEl();
        const sd = timelineEl ? timelineEl.scrollTop - cachedTimelineScrollTop : 0;

        const positions = cachedTimelineRows;
        let lo = 0;
        let hi = positions.length - 1;

        // Binary search: find insertion point where adjusted midY > mouseY
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if ((positions[mid].midY - sd) > mouseY) {
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }

        // Candidates: hi and lo
        let bestIdx = -1;
        let bestDist = Infinity;
        for (const idx of [hi, lo]) {
            if (idx >= 0 && idx < positions.length) {
                const dist = Math.abs(mouseY - (positions[idx].midY - sd));
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = idx;
                }
            }
        }

        if (bestIdx < 0) return null;
        const entry = positions[bestIdx];
        const isAbove = mouseY < (entry.midY - sd);
        return { entry, isAbove, timelineScrollDelta: sd };
    }

    function _updateReorderTarget(ev) {
        const timelineEl = params.getTimelineEl();
        if (!timelineEl) return;

        const result = _findClosestTimelineRow(ev.clientY);
        if (!result) {
            if (reorderIndicatorTimeline) reorderIndicatorTimeline.style.display = "none";
            if (reorderIndicatorList) reorderIndicatorList.style.display = "none";
            reorderTarget = null;
            return;
        }

        const { entry, isAbove, timelineScrollDelta: sd } = result;
        const targetRid = entry.recordId;

        reorderTarget = { recordId: targetRid };
        reorderPosition = isAbove ? "before" : "after";

        // Position timeline indicator using cached coordinates
        if (reorderIndicatorTimeline) {
            const timelineRect = timelineEl.getBoundingClientRect();
            const adjustedTop = entry.top - sd;
            const adjustedBottom = entry.bottom - sd;
            const yPos = isAbove
                ? adjustedTop - timelineRect.top + timelineEl.scrollTop
                : adjustedBottom - timelineRect.top + timelineEl.scrollTop;
            reorderIndicatorTimeline.style.display = "block";
            reorderIndicatorTimeline.style.top = `${yPos}px`;
        }

        // Position list indicator (synced) using cached coordinates
        const listEl = params.getListEl ? params.getListEl() : null;
        if (listEl && reorderIndicatorList && entry.hasListRow) {
            const listSd = listEl.scrollTop - cachedListScrollTop;
            const listRect = listEl.getBoundingClientRect();
            const adjustedListTop = entry.listTop - listSd;
            const adjustedListBottom = entry.listBottom - listSd;
            const yPos = isAbove
                ? adjustedListTop - listRect.top + listEl.scrollTop
                : adjustedListBottom - listRect.top + listEl.scrollTop;
            reorderIndicatorList.style.display = "block";
            reorderIndicatorList.style.top = `${yPos}px`;
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
        // Item 10: Reset multi-drag state
        isMultiDrag = false;
        multiDragBars = [];
        cachedTimelineRows = null;
        cachedTimelineScrollTop = 0;
        cachedListScrollTop = 0;
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
