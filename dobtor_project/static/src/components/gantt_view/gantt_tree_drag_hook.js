/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";

/**
 * Custom OWL hook for tree drag-drop reordering in the left panel.
 * Allows reordering tasks by dragging them within the task list.
 *
 * @param {Object} params
 * @param {Function} params.getListEl - returns the list rows DOM element
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onReorder - (recordId, targetId, position) => Promise
 *      position: "before" | "after" | "child"
 */
export function useGanttTreeDrag(params) {
    let isDragging = false;
    let dragRow = null;
    let recordId = null;
    let startY = 0;
    let dragThresholdMet = false;
    let ghostEl = null;
    let dropIndicator = null;
    let dropTarget = null;
    let dropPosition = "after"; // "before" | "after" | "child"

    // Cached row positions for binary search (built once per drag)
    let cachedRowPositions = null; // [{el, recordId, top, bottom, midY}, ...] sorted by top
    let cachedScrollTop = 0; // scrollTop at cache time, used to adjust for scroll delta

    const THRESHOLD = 5;
    const ROW_HEIGHT = 44;

    const onMove = useThrottleForAnimation((ev) => {
        if (!dragRow) return;

        const deltaY = ev.clientY - startY;

        if (!dragThresholdMet) {
            if (Math.abs(deltaY) < THRESHOLD) return;
            dragThresholdMet = true;
            _createGhost(ev);
            _createDropIndicator();
            dragRow.classList.add("o_gantt_tree_dragging_source");
        }

        // Move ghost
        if (ghostEl) {
            ghostEl.style.top = `${ev.clientY - 20}px`;
            ghostEl.style.left = `${ev.clientX + 12}px`;
        }

        // Determine drop target
        _updateDropTarget(ev);
    });

    function onPointerDown(ev) {
        // Only start drag from the drag handle
        const handle = ev.target.closest(".o_gantt_tree_drag_handle");
        if (!handle) return;

        const row = handle.closest(".o_gantt_list_row");
        if (!row) return;

        // Don't drag group rows
        if (row.classList.contains("o_gantt_group_row")) return;

        const rid = parseInt(row.dataset.recordId, 10);
        if (!rid) return;

        const record = params.getRecord(rid);
        if (!record) return;

        ev.preventDefault();
        isDragging = true;
        dragRow = row;
        recordId = rid;
        startY = ev.clientY;
        dragThresholdMet = false;

        // Build row position cache at drag start
        _buildRowPositionCache();

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });
    }

    function onPointerUp() {
        document.removeEventListener("pointermove", onMove);

        if (!dragRow || !dragThresholdMet) {
            _cleanup();
            return;
        }

        if (dropTarget && dropTarget.recordId !== recordId) {
            params.onReorder(recordId, dropTarget.recordId, dropPosition);
        }

        _cleanup();
    }

    function _createGhost(ev) {
        ghostEl = document.createElement("div");
        ghostEl.className = "o_gantt_tree_drag_ghost";
        ghostEl.style.cssText =
            "position:fixed;z-index:10000;padding:4px 12px;background:var(--gantt-surface-elevated);" +
            "border-radius:var(--gantt-radius-sm);box-shadow:var(--gantt-shadow-lg);" +
            "font-size:13px;font-weight:500;color:var(--gantt-label-primary);pointer-events:none;" +
            "white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;";

        const record = params.getRecord(recordId);
        ghostEl.textContent = record?.display_name || "";
        document.body.appendChild(ghostEl);
    }

    function _createDropIndicator() {
        dropIndicator = document.createElement("div");
        dropIndicator.className = "o_gantt_tree_drop_indicator";
        dropIndicator.style.cssText =
            "position:absolute;left:0;right:0;height:2px;background:var(--gantt-accent-blue);" +
            "z-index:100;pointer-events:none;display:none;" +
            "box-shadow:0 0 4px var(--gantt-accent-blue);" +
            "transition:top 0.1s ease, height 0.1s ease, background 0.1s ease;" +
            "border-radius:1px;";

        const listEl = params.getListEl();
        if (listEl) {
            listEl.style.position = "relative";
            listEl.appendChild(dropIndicator);
        }
    }

    function _buildRowPositionCache() {
        const listEl = params.getListEl();
        if (!listEl) {
            cachedRowPositions = null;
            return;
        }
        cachedScrollTop = listEl.scrollTop;
        const rows = listEl.querySelectorAll(".o_gantt_list_row:not(.o_gantt_group_row)");
        cachedRowPositions = [];
        for (const row of rows) {
            if (row === dragRow) continue;
            const rid = parseInt(row.dataset.recordId, 10);
            if (!rid || rid === recordId) continue;
            const rect = row.getBoundingClientRect();
            cachedRowPositions.push({
                el: row,
                recordId: rid,
                top: rect.top,
                bottom: rect.bottom,
                midY: rect.top + rect.height / 2,
                height: rect.height,
            });
        }
        // Sort by top Y (should already be in order, but ensure it)
        cachedRowPositions.sort((a, b) => a.top - b.top);
    }

    /**
     * Binary search to find the closest row to mouseY.
     * cachedPositions must be sorted by midY (ascending).
     * Returns {entry, isAbove} or null.
     */
    function _findClosestRow(mouseY) {
        if (!cachedRowPositions || cachedRowPositions.length === 0) return null;

        // Adjust for scroll delta since cache was built.
        // cached midY was at viewport coords when scrollTop = cachedScrollTop.
        // Now scrollTop may have changed. Current viewport midY = cached midY - scrollDelta.
        const listEl = params.getListEl();
        const sd = listEl ? listEl.scrollTop - cachedScrollTop : 0;

        const positions = cachedRowPositions;
        let lo = 0;
        let hi = positions.length - 1;
        // Find insertion point: the first row whose adjusted midY > mouseY
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if ((positions[mid].midY - sd) > mouseY) {
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }

        // Candidates: hi (last row with adjustedMidY <= mouseY) and lo (first row with adjustedMidY > mouseY)
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
        return { entry, isAbove, scrollDelta: sd };
    }

    function _updateDropTarget(ev) {
        const listEl = params.getListEl();
        if (!listEl || !dropIndicator) return;

        // Clear previous row highlights
        const prevTarget = listEl.querySelector(".o_gantt_tree_drop_child_target");
        if (prevTarget) prevTarget.classList.remove("o_gantt_tree_drop_child_target");

        const result = _findClosestRow(ev.clientY);
        if (!result) return;

        const { entry, isAbove, scrollDelta: sd } = result;
        const rid = entry.recordId;
        const closestRow = entry.el;

        dropTarget = { recordId: rid, el: closestRow };
        dropPosition = isAbove ? "before" : "after";

        // Check if dropping as child (right 40% of row)
        // Use cached position for left/width (adjusted for scroll — only vertical scroll matters, not horizontal for left)
        const rowLeft = entry.el.getBoundingClientRect().left;
        const rowWidth = entry.bottom - entry.top; // approximate; use cached height
        const relX = ev.clientX - rowLeft;
        // For width, use the element's actual width (horizontal position not affected by vertical scroll)
        const actualWidth = entry.el.offsetWidth;
        if (relX > actualWidth * 0.6) {
            dropPosition = "child";
        }

        // Position indicator using cached coordinates
        const listRect = listEl.getBoundingClientRect();
        const adjustedTop = entry.top - sd;
        const adjustedBottom = entry.bottom - sd;
        dropIndicator.style.display = "block";

        // Get indent of target row for visual alignment
        const targetRecord = params.getRecord(rid);
        const indent = targetRecord?._indent || 0;
        const indentPx = indent * 20 + 40; // match tree indent + handle width

        if (dropPosition === "before") {
            dropIndicator.style.top = `${adjustedTop - listRect.top + listEl.scrollTop}px`;
            dropIndicator.style.left = `${indentPx}px`;
            dropIndicator.style.right = "0";
            dropIndicator.style.height = "2px";
            dropIndicator.style.background = "var(--gantt-accent-blue)";
        } else if (dropPosition === "after") {
            dropIndicator.style.top = `${adjustedBottom - listRect.top + listEl.scrollTop}px`;
            dropIndicator.style.left = `${indentPx}px`;
            dropIndicator.style.right = "0";
            dropIndicator.style.height = "2px";
            dropIndicator.style.background = "var(--gantt-accent-blue)";
        } else {
            // "child" — highlight the row with indented indicator
            dropIndicator.style.top = `${adjustedTop - listRect.top + listEl.scrollTop}px`;
            dropIndicator.style.left = `${indentPx + 20}px`; // one level deeper
            dropIndicator.style.right = "0";
            dropIndicator.style.height = `${entry.height}px`;
            dropIndicator.style.background = "rgba(0, 122, 255, 0.08)";
            closestRow.classList.add("o_gantt_tree_drop_child_target");
        }
    }

    function _cleanup() {
        if (dragRow) {
            dragRow.classList.remove("o_gantt_tree_dragging_source");
        }
        if (ghostEl && ghostEl.parentNode) {
            ghostEl.parentNode.removeChild(ghostEl);
        }
        if (dropIndicator && dropIndicator.parentNode) {
            dropIndicator.parentNode.removeChild(dropIndicator);
        }
        // Clear child-target highlights
        const listEl = params.getListEl();
        if (listEl) {
            listEl.querySelectorAll(".o_gantt_tree_drop_child_target").forEach(
                el => el.classList.remove("o_gantt_tree_drop_child_target")
            );
        }

        isDragging = false;
        dragRow = null;
        recordId = null;
        dragThresholdMet = false;
        ghostEl = null;
        dropIndicator = null;
        dropTarget = null;
        cachedRowPositions = null;
        cachedScrollTop = 0;
    }

    onMounted(() => {
        const el = params.getListEl();
        if (el) {
            el.addEventListener("pointerdown", onPointerDown);
        }
    });

    onWillUnmount(() => {
        const el = params.getListEl();
        if (el) {
            el.removeEventListener("pointerdown", onPointerDown);
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onPointerUp);
        _cleanup();
    });
}
