/** @odoo-module **/

import { useRef, onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";

/**
 * Custom OWL hook for gutter (column resizer) drag interaction.
 * Attaches pointer events to the gutter element to resize the left panel.
 *
 * @param {Object} state - reactive state with `gutterWidth` property
 * @param {Object} [options]
 * @param {number} [options.min=200] - minimum width in px
 * @param {number} [options.max=500] - maximum width in px
 * @returns {{ gutterRef: Ref }}
 */
export function useGanttGutter(state, options = {}) {
    const min = options.min ?? 200;
    const max = options.max ?? 500;
    const gutterRef = useRef("gutter");

    let startX = 0;
    let startWidth = 0;
    let isDragging = false;

    const onMove = useThrottleForAnimation((ev) => {
        if (!isDragging) return;
        const delta = ev.clientX - startX;
        const newWidth = Math.min(max, Math.max(min, startWidth + delta));
        state.gutterWidth = newWidth;
    });

    function onPointerDown(ev) {
        ev.preventDefault();
        isDragging = true;
        startX = ev.clientX;
        startWidth = state.gutterWidth;

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onPointerUp, { once: true });
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }

    function onPointerUp() {
        isDragging = false;
        document.removeEventListener("pointermove", onMove);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        // Persist gutter width to localStorage
        try {
            localStorage.setItem("gantt_gutter_width", String(state.gutterWidth));
        } catch (_e) {
            // localStorage not available
        }
    }

    onMounted(() => {
        const el = gutterRef.el;
        if (el) {
            el.addEventListener("pointerdown", onPointerDown);
        }
    });

    onWillUnmount(() => {
        const el = gutterRef.el;
        if (el) {
            el.removeEventListener("pointerdown", onPointerDown);
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    });

    return { gutterRef };
}
