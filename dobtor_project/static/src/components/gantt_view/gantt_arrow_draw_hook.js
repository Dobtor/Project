/** @odoo-module **/

import { onMounted, onWillUnmount } from "@odoo/owl";

/**
 * Custom OWL hook for drawing predecessor arrows by dragging from
 * connector dots on bars to target bars.
 *
 * @param {Object} params
 * @param {Function} params.getTimelineEl - returns the timeline data DOM element
 * @param {Function} params.getRecord - (recordId) => record object
 * @param {Function} params.onLinkCreated - (fromId, toId, type) => Promise
 * @param {Function} params.onLinkDeleted - (predecessorId) => Promise
 */
export function useGanttArrowDraw(params) {
    let isDrawing = false;
    let fromRecordId = null;
    let fromSide = null; // "start" or "end"
    let svgLine = null;  // Temporary SVG line element
    let startX = 0;
    let startY = 0;
    let lastHighlightedBar = null; // Fallback for target detection on pointerup
    let pendingDeleteMenuTimeout = null;

    function onPointerDown(ev) {
        const connector = ev.target.closest(".o_gantt_connector");
        if (!connector) return;

        const bar = connector.closest(".o_gantt_bar");
        if (!bar) return;

        // Milestones cannot initiate arrow connections
        if (bar.classList.contains("o_gantt_milestone")) return;

        const rid = parseInt(bar.dataset.recordId, 10);
        if (!rid) return;

        ev.preventDefault();
        ev.stopPropagation();

        isDrawing = true;
        fromRecordId = rid;
        fromSide = connector.classList.contains("o_gantt_connector_left") ? "start" : "end";

        const timelineEl = params.getTimelineEl();
        if (!timelineEl) return;

        // Calculate start position relative to timeline data container
        const tlRect = timelineEl.getBoundingClientRect();
        const connRect = connector.getBoundingClientRect();
        startX = connRect.left + connRect.width / 2 - tlRect.left + timelineEl.scrollLeft;
        startY = connRect.top + connRect.height / 2 - tlRect.top + timelineEl.scrollTop;

        // Create temporary SVG line for visual feedback
        _createTempLine(timelineEl);

        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });

        // Add visual class to source bar
        bar.classList.add("o_gantt_connector_active");
    }

    function onPointerMove(ev) {
        if (!isDrawing || !svgLine) return;

        const timelineEl = params.getTimelineEl();
        if (!timelineEl) return;

        const tlRect = timelineEl.getBoundingClientRect();
        const endX = ev.clientX - tlRect.left + timelineEl.scrollLeft;
        const endY = ev.clientY - tlRect.top + timelineEl.scrollTop;

        svgLine.setAttribute("x2", endX);
        svgLine.setAttribute("y2", endY);

        // Highlight potential drop target
        _highlightTarget(ev);
    }

    function onPointerUp(ev) {
        document.removeEventListener("pointermove", onPointerMove);

        if (!isDrawing) {
            _cleanup();
            return;
        }

        // Find the target bar under the cursor (with fallback to last highlighted)
        const targetBar = _getTargetBar(ev) || lastHighlightedBar;

        _removeTempLine();
        _clearHighlights();

        if (targetBar) {
            const toId = parseInt(targetBar.dataset.recordId, 10);
            if (toId && toId !== fromRecordId) {
                // Auto-detect target side based on cursor position relative to bar center
                const toSide = _detectTargetSide(targetBar, ev);
                const type = _determineLinkType(fromSide, toSide);
                params.onLinkCreated(fromRecordId, toId, type);
            }
        }

        _cleanup();
    }

    function _detectTargetSide(bar, ev) {
        if (!bar) return "start";
        const rect = bar.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        return ev.clientX > midX ? "end" : "start";
    }

    function _determineLinkType(from, to) {
        // from=end,to=start → FS; from=start,to=start → SS
        // from=end,to=end → FF; from=start,to=end → SF
        if (from === "end" && to === "start") return "FS";
        if (from === "start" && to === "start") return "SS";
        if (from === "end" && to === "end") return "FF";
        if (from === "start" && to === "end") return "SF";
        return "FS";
    }

    function _getTargetBar(ev) {
        // Hide ALL SVG overlays (draw SVG + main arrow container) so
        // elementFromPoint can find the bar underneath
        const timelineEl = params.getTimelineEl();
        const svgs = timelineEl ? timelineEl.querySelectorAll("svg") : [];
        svgs.forEach(s => s.style.pointerEvents = "none");

        const el = document.elementFromPoint(ev.clientX, ev.clientY);

        svgs.forEach(s => s.style.pointerEvents = "");

        if (el) {
            const bar = el.closest(".o_gantt_bar");
            if (bar) {
                const rid = parseInt(bar.dataset.recordId, 10);
                if (rid && rid !== fromRecordId) return bar;
            }
        }

        // Fallback: bounding-rect scan for bars that clip-path may hide
        // from elementFromPoint (e.g. summary/parent bars with bracket shape)
        return _findBarByRect(ev, timelineEl);
    }

    function _createTempLine(container) {
        // Find or create a temporary SVG overlay for the drawing line
        let svg = container.querySelector(".o_gantt_arrow_draw_svg");
        if (!svg) {
            svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.classList.add("o_gantt_arrow_draw_svg");
            // Use scrollHeight so the SVG covers the full content area
            // (flex:1 + min-height:0 on the container means CSS box < content height)
            const h = Math.max(container.scrollHeight, container.offsetHeight);
            svg.style.cssText = `position:absolute;top:0;left:0;width:100%;height:${h}px;pointer-events:none;z-index:50;overflow:visible;`;
            container.appendChild(svg);
        }

        svgLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        svgLine.setAttribute("x1", startX);
        svgLine.setAttribute("y1", startY);
        svgLine.setAttribute("x2", startX);
        svgLine.setAttribute("y2", startY);
        svgLine.classList.add("o_gantt_arrow_drawing");
        svg.appendChild(svgLine);
    }

    function _removeTempLine() {
        if (svgLine && svgLine.parentNode) {
            const parentSvg = svgLine.parentNode;
            parentSvg.removeChild(svgLine);
            // Clean up empty draw SVG container
            if (parentSvg.classList.contains("o_gantt_arrow_draw_svg") && !parentSvg.children.length) {
                parentSvg.parentNode.removeChild(parentSvg);
            }
        }
        svgLine = null;
    }

    function _highlightTarget(ev) {
        _clearHighlights();
        const bar = _peekTargetBar(ev);
        lastHighlightedBar = bar;
        if (bar) {
            bar.classList.add("o_gantt_connector_drop_target");
        }
    }

    function _peekTargetBar(ev) {
        // Hide ALL SVG overlays to find bars underneath
        const timelineEl = params.getTimelineEl();
        const svgs = timelineEl ? timelineEl.querySelectorAll("svg") : [];
        svgs.forEach(s => s.style.pointerEvents = "none");
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        svgs.forEach(s => s.style.pointerEvents = "");
        if (el) {
            const bar = el.closest(".o_gantt_bar");
            if (bar) {
                const rid = parseInt(bar.dataset.recordId, 10);
                if (rid && rid !== fromRecordId) return bar;
            }
        }
        // Fallback: bounding-rect scan (clip-path may prevent elementFromPoint
        // from finding summary/parent bars)
        return _findBarByRect(ev, timelineEl);
    }

    function _findBarByRect(ev, timelineEl) {
        if (!timelineEl) return null;
        const bars = timelineEl.querySelectorAll(".o_gantt_bar");
        for (const bar of bars) {
            const rid = parseInt(bar.dataset.recordId, 10);
            if (!rid || rid === fromRecordId) continue;
            const r = bar.getBoundingClientRect();
            if (ev.clientX >= r.left && ev.clientX <= r.right &&
                ev.clientY >= r.top && ev.clientY <= r.bottom) {
                return bar;
            }
        }
        return null;
    }

    function _clearHighlights() {
        const timelineEl = params.getTimelineEl();
        if (!timelineEl) return;
        const highlighted = timelineEl.querySelectorAll(".o_gantt_connector_drop_target");
        for (const el of highlighted) {
            el.classList.remove("o_gantt_connector_drop_target");
        }
        const active = timelineEl.querySelectorAll(".o_gantt_connector_active");
        for (const el of active) {
            el.classList.remove("o_gantt_connector_active");
        }
    }

    function _cleanup() {
        isDrawing = false;
        fromRecordId = null;
        fromSide = null;
        lastHighlightedBar = null;
        _removeTempLine();
        _clearHighlights();
    }

    // --- Arrow click/delete support ---

    function onArrowClick(ev) {
        const path = ev.target.closest(".o_gantt_arrow");
        if (!path) return;

        // Toggle selection on the arrow
        const wasSelected = path.classList.contains("o_gantt_arrow_selected");
        // Deselect all first
        const container = path.closest(".o_gantt_arrow_container");
        if (container) {
            container.querySelectorAll(".o_gantt_arrow_selected").forEach(
                el => el.classList.remove("o_gantt_arrow_selected")
            );
        }
        if (!wasSelected) {
            path.classList.add("o_gantt_arrow_selected");
        }
    }

    function onArrowContextMenu(ev) {
        const path = ev.target.closest(".o_gantt_arrow");
        if (!path) return;

        ev.preventDefault();

        // Extract predecessor info from path id (format: arrow_parentId_childId)
        const pathId = path.id || path.getAttribute("data-pred-id");
        if (!pathId) return;

        // Show a simple confirm-delete popup
        _showDeleteMenu(ev.clientX, ev.clientY, pathId);
    }

    function _showDeleteMenu(x, y, pathId) {
        // Remove any existing menu
        _removeDeleteMenu();

        const menu = document.createElement("div");
        menu.className = "o_gantt_arrow_delete_menu";
        menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:1100;` +
            "background:var(--gantt-surface-elevated, #fff);padding:8px 16px;" +
            "border-radius:var(--gantt-radius-sm, 6px);box-shadow:var(--gantt-shadow-lg);" +
            "cursor:pointer;font-size:13px;font-weight:500;color:var(--gantt-accent-red, #FF3B30);";
        menu.innerHTML = '<i class="fa fa-trash-o" style="margin-right:6px;"></i>Delete Link';

        menu.addEventListener("click", () => {
            _removeDeleteMenu();
            if (params.onLinkDeleted && pathId) {
                params.onLinkDeleted(pathId);
            }
        });

        // Close on click outside (track timeout for cleanup)
        pendingDeleteMenuTimeout = setTimeout(() => {
            pendingDeleteMenuTimeout = null;
            document.addEventListener("click", _removeDeleteMenu, { once: true });
        }, 0);

        document.body.appendChild(menu);
    }

    function _removeDeleteMenu() {
        const existing = document.querySelector(".o_gantt_arrow_delete_menu");
        if (existing) existing.remove();
    }

    onMounted(() => {
        const el = params.getTimelineEl();
        if (el) {
            el.addEventListener("pointerdown", onPointerDown);
        }

        // Arrow click/contextmenu on SVG
        const arrowSvg = el?.querySelector(".o_gantt_arrow_container");
        if (arrowSvg) {
            arrowSvg.addEventListener("click", onArrowClick);
            arrowSvg.addEventListener("contextmenu", onArrowContextMenu);
        }
    });

    onWillUnmount(() => {
        const el = params.getTimelineEl();
        if (el) {
            el.removeEventListener("pointerdown", onPointerDown);
        }
        const arrowSvg = el?.querySelector(".o_gantt_arrow_container");
        if (arrowSvg) {
            arrowSvg.removeEventListener("click", onArrowClick);
            arrowSvg.removeEventListener("contextmenu", onArrowContextMenu);
        }
        document.removeEventListener("pointermove", onPointerMove);
        if (pendingDeleteMenuTimeout) {
            clearTimeout(pendingDeleteMenuTimeout);
            pendingDeleteMenuTimeout = null;
        }
        _removeDeleteMenu();
        _cleanup();
    });
}
