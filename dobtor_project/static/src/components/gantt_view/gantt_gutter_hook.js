/** @odoo-module **/

import { useRef, onMounted, onWillUnmount } from "@odoo/owl";
import { useThrottleForAnimation } from "@web/core/utils/timing";

/**
 * Custom OWL hook for gutter (column resizer) drag interaction.
 * Attaches pointer events to the gutter element to resize a panel.
 *
 * @param {Object} state - reactive state object
 * @param {Object} [options]
 * @param {number} [options.min=200] - minimum width in px
 * @param {number} [options.max=500] - maximum width in px
 * @param {string} [options.refName="gutter"] - t-ref name for the gutter element
 * @param {string} [options.stateKey="gutterWidth"] - key in state to read/write width
 * @param {string} [options.storageKey="gantt_gutter_width"] - localStorage key for persistence
 * @returns {{ gutterRef: Ref }}
 */
export function useGanttGutter(state, options = {}) {
    const min = options.min ?? 200;
    const max = options.max ?? 500;
    const refName = options.refName ?? "gutter";
    const stateKey = options.stateKey ?? "gutterWidth";
    const storageKey = options.storageKey ?? "gantt_gutter_width";
    const gutterRef = useRef(refName);

    let startX = 0;
    let startWidth = 0;
    let isDragging = false;

    const onMove = useThrottleForAnimation((ev) => {
        if (!isDragging) return;
        const delta = ev.clientX - startX;
        const newWidth = Math.min(max, Math.max(min, startWidth + delta));
        state[stateKey] = newWidth;
    });

    function onPointerDown(ev) {
        ev.preventDefault();
        isDragging = true;
        startX = ev.clientX;
        startWidth = state[stateKey];

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
            localStorage.setItem(storageKey, String(state[stateKey]));
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
