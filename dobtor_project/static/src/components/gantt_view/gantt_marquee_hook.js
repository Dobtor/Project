/** @odoo-module **/

import { onMounted, onWillUnmount, onPatched } from "@odoo/owl";

/**
 * Rubber-band (marquee) selection over the timeline, OmniPlan-style.
 *
 * Pointer-down on empty timeline space starts a selection rectangle; on
 * pointer-up every task bar / milestone whose box intersects the rectangle is
 * selected. Holding Shift or Ctrl/Cmd adds to the current selection instead of
 * replacing it. Dragging that starts on a bar, handle, arrow connector, etc. is
 * ignored so this never competes with the bar-drag / resize / arrow-draw hooks.
 *
 * params:
 *   getTimelineEl(): HTMLElement   - the .o_gantt_timeline_data element
 *   setSelection(ids, additive)    - apply the resulting selection
 */
export function useGanttMarquee(params) {
    let active = false;
    let startX = 0;
    let startY = 0;
    let rectEl = null;
    let containerEl = null;
    let additive = false;

    // Elements that own their own pointer interaction — never start a marquee
    // when the gesture begins on one of these.
    const IGNORE_SELECTOR = [
        ".o_gantt_bar",
        ".o_gantt_milestone",
        ".o_gantt_bar_resize_handle",
        ".o_gantt_bar_progress_handle",
        ".o_gantt_arrow_connector",
        ".o_gantt_arrow",
        ".o_gantt_deadline_marker",
        ".o_gantt_group_bar",
    ].join(",");

    const onPointerDown = (ev) => {
        // Left button only, and not on an interactive element.
        if (ev.button !== 0) return;
        if (ev.target.closest(IGNORE_SELECTOR)) return;
        containerEl = params.getTimelineEl();
        if (!containerEl) return;

        const bounds = containerEl.getBoundingClientRect();
        startX = ev.clientX - bounds.left + containerEl.scrollLeft;
        startY = ev.clientY - bounds.top + containerEl.scrollTop;
        additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
        active = true;

        rectEl = document.createElement("div");
        rectEl.className = "o_gantt_marquee";
        rectEl.style.cssText =
            `position:absolute;left:${startX}px;top:${startY}px;width:0;height:0;` +
            `z-index:50;pointer-events:none;`;
        containerEl.appendChild(rectEl);

        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });
    };

    const onPointerMove = (ev) => {
        if (!active || !rectEl || !containerEl) return;
        const bounds = containerEl.getBoundingClientRect();
        const curX = ev.clientX - bounds.left + containerEl.scrollLeft;
        const curY = ev.clientY - bounds.top + containerEl.scrollTop;
        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        const width = Math.abs(curX - startX);
        const height = Math.abs(curY - startY);
        rectEl.style.left = `${left}px`;
        rectEl.style.top = `${top}px`;
        rectEl.style.width = `${width}px`;
        rectEl.style.height = `${height}px`;
    };

    const onPointerUp = () => {
        if (!active) return;
        active = false;
        document.removeEventListener("pointermove", onPointerMove);

        const ids = [];
        if (rectEl && containerEl) {
            const marqueeRect = rectEl.getBoundingClientRect();
            // Only treat as a marquee if the user actually dragged a box.
            if (marqueeRect.width > 3 || marqueeRect.height > 3) {
                const bars = containerEl.querySelectorAll(
                    ".o_gantt_bar[data-record-id], .o_gantt_milestone[data-record-id]");
                for (const bar of bars) {
                    const r = bar.getBoundingClientRect();
                    const intersects =
                        r.left < marqueeRect.right && r.right > marqueeRect.left &&
                        r.top < marqueeRect.bottom && r.bottom > marqueeRect.top;
                    if (intersects) {
                        const id = parseInt(bar.dataset.recordId, 10);
                        if (!Number.isNaN(id)) ids.push(id);
                    }
                }
                params.setSelection(ids, additive);
            }
        }

        if (rectEl) {
            rectEl.remove();
            rectEl = null;
        }
    };

    // Track the element we actually bound to, so we can rebind if OWL rebuilds
    // the timeline (e.g. after toggling an alternate view and back).
    let boundEl = null;
    const bind = () => {
        const el = params.getTimelineEl();
        if (el === boundEl) return;
        if (boundEl) boundEl.removeEventListener("pointerdown", onPointerDown);
        if (el) el.addEventListener("pointerdown", onPointerDown);
        boundEl = el;
    };

    onMounted(bind);
    onPatched(bind);

    onWillUnmount(() => {
        if (boundEl) boundEl.removeEventListener("pointerdown", onPointerDown);
        boundEl = null;
        document.removeEventListener("pointermove", onPointerMove);
        if (rectEl) {
            rectEl.remove();
            rectEl = null;
        }
    });
}
