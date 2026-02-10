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
            "box-shadow:0 0 4px var(--gantt-accent-blue);";

        const listEl = params.getListEl();
        if (listEl) {
            listEl.style.position = "relative";
            listEl.appendChild(dropIndicator);
        }
    }

    function _updateDropTarget(ev) {
        const listEl = params.getListEl();
        if (!listEl || !dropIndicator) return;

        const rows = listEl.querySelectorAll(".o_gantt_list_row:not(.o_gantt_group_row)");
        let closestRow = null;
        let closestDist = Infinity;
        let isAbove = false;

        for (const row of rows) {
            if (row === dragRow) continue;

            const rect = row.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const dist = Math.abs(ev.clientY - midY);

            if (dist < closestDist) {
                closestDist = dist;
                closestRow = row;
                isAbove = ev.clientY < midY;
            }
        }

        if (closestRow) {
            const rid = parseInt(closestRow.dataset.recordId, 10);
            if (rid && rid !== recordId) {
                dropTarget = { recordId: rid, el: closestRow };
                dropPosition = isAbove ? "before" : "after";

                // Check if dropping as child (indent zone: mouse in left 30% of row, and target has no children or is a parent)
                const rect = closestRow.getBoundingClientRect();
                const relX = ev.clientX - rect.left;
                if (relX > rect.width * 0.6) {
                    dropPosition = "child";
                }

                // Position indicator
                const listRect = listEl.getBoundingClientRect();
                const rowRect = closestRow.getBoundingClientRect();
                dropIndicator.style.display = "block";

                if (dropPosition === "before") {
                    dropIndicator.style.top = `${rowRect.top - listRect.top + listEl.scrollTop}px`;
                    dropIndicator.style.height = "2px";
                } else if (dropPosition === "after") {
                    dropIndicator.style.top = `${rowRect.bottom - listRect.top + listEl.scrollTop}px`;
                    dropIndicator.style.height = "2px";
                } else {
                    // "child" — highlight the whole row
                    dropIndicator.style.top = `${rowRect.top - listRect.top + listEl.scrollTop}px`;
                    dropIndicator.style.height = `${rowRect.height}px`;
                    dropIndicator.style.background = "rgba(0, 122, 255, 0.08)";
                }
            }
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

        isDragging = false;
        dragRow = null;
        recordId = null;
        dragThresholdMet = false;
        ghostEl = null;
        dropIndicator = null;
        dropTarget = null;
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
