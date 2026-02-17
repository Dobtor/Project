/** @odoo-module **/

/**
 * Shared utility functions for the Gantt view.
 * Used by: gantt_renderer, gantt_bar_drag_hook, gantt_bar_resize_hook.
 */

/**
 * Convert a cell count delta to a Luxon-compatible duration object
 * based on the current scale.
 *
 * @param {number} cellsDelta - Number of cells moved (can be fractional)
 * @param {string} scale - Current gantt scale ("1h", "2h", "4h", "8h", "day", "week", "month", "quarter")
 * @returns {Object} Duration object compatible with Luxon (e.g., { hours: 2 }, { days: 1 })
 */
export function cellsDeltaToDuration(cellsDelta, scale) {
    if (scale === "1h") return { hours: cellsDelta };
    if (scale === "2h") return { hours: cellsDelta * 2 };
    if (scale === "4h") return { hours: cellsDelta * 4 };
    if (scale === "8h") return { hours: cellsDelta * 8 };
    if (scale === "week") return { weeks: cellsDelta };
    if (scale === "month" || scale === "quarter") return { months: cellsDelta };
    return { days: cellsDelta }; // default: day
}

/**
 * Format a number of days into a human-readable short string.
 *
 * @param {number} days - Duration in days (can be fractional)
 * @returns {string} Formatted string (e.g., "4h", "3d", "2w 1d")
 */
export function humanizeDays(days) {
    if (days < 0) return "0\u5929";
    if (days < 1) {
        const hours = Math.round(days * 24);
        return `${hours}\u6642`;
    }
    if (days < 7) {
        return `${days}\u5929`;
    }
    const weeks = Math.floor(days / 7);
    const remainDays = Math.round(days % 7);
    if (remainDays === 0) return `${weeks}\u9031`;
    return `${weeks}\u9031${remainDays}\u5929`;
}

/**
 * Convert lag hours into a Luxon-compatible duration object.
 *
 * @param {number} lagHours - The lag value in hours (can be negative for lead time)
 * @returns {Object} Luxon Duration-compatible object (e.g., { hours: 48 })
 */
export function lagToDuration(lagHours) {
    if (!lagHours) return {};
    return { hours: lagHours };
}

/**
 * Convert a millisecond duration to lag hours (Float).
 *
 * @param {number} durationMs - Duration in milliseconds
 * @returns {number} Lag in hours
 */
export function durationToLag(durationMs) {
    return durationMs / 3600000;
}

/**
 * Parse a human-readable lag input string (e.g., "2d6h30m") into total hours.
 *
 * @param {string} text - Input string like "2d6h30m", "-1d", "3h"
 * @returns {number} Total hours (can be negative)
 */
export function parseLagInput(text) {
    const negative = text.trim().startsWith("-");
    const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/gi;
    let totalHours = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const val = parseFloat(match[1]);
        switch (match[2].toLowerCase()) {
            case "d": totalHours += val * 24; break;
            case "h": totalHours += val; break;
            case "m": totalHours += val / 60; break;
            case "s": totalHours += val / 3600; break;
        }
    }
    return negative ? -totalHours : totalHours;
}

/**
 * Convert hours to editable input format string (e.g., "2d6h30m").
 *
 * @param {number} hours - Duration in hours
 * @returns {string} Formatted string like "2d6h30m"
 */
export function hoursToInputFormat(hours) {
    if (!hours) return "";
    const negative = hours < 0;
    const abs = Math.abs(hours);
    const d = Math.floor(abs / 24);
    const h = Math.floor(abs % 24);
    const m = Math.round((abs % 1) * 60) % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    const result = parts.join("") || "0h";
    return negative ? `-${result}` : result;
}

/**
 * Format hours into a human-readable display string (e.g., "4.8天").
 *
 * @param {number} hours - Duration in hours
 * @returns {string} Formatted string like "4.8天", "2小時", "1週3天"
 */
export function humanizeHours(hours) {
    if (hours === 0 || !hours) return "0";
    const negative = hours < 0;
    const absHours = Math.abs(hours);
    const days = absHours / 24;
    let result;
    if (days < 1) {
        result = `${Math.round(absHours * 10) / 10}\u5c0f\u6642`;
    } else if (days < 7) {
        result = `${Math.round(days * 10) / 10}\u5929`;
    } else {
        const weeks = Math.floor(days / 7);
        const remainDays = Math.round(days % 7);
        if (remainDays === 0) {
            result = `${weeks}\u9031`;
        } else {
            result = `${weeks}\u9031${remainDays}\u5929`;
        }
    }
    return negative ? `-${result}` : result;
}

/**
 * Format a cell delta into a human-readable delta label (e.g., "+2d3h", "-30m").
 *
 * @param {number} cellsDelta - Number of cells moved
 * @param {string} scale - Current gantt scale
 * @returns {string} Formatted label with sign prefix
 */
export function formatDeltaLabel(cellsDelta, scale) {
    const dur = cellsDeltaToDuration(cellsDelta, scale);
    const totalMinutes = Math.round(
        (dur.months || 0) * 43200 + (dur.weeks || 0) * 10080 +
        (dur.days || 0) * 1440 + (dur.hours || 0) * 60 + (dur.minutes || 0)
    );
    const sign = totalMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(totalMinutes);
    const d = Math.floor(abs / 1440);
    const h = Math.floor((abs % 1440) / 60);
    const m = abs % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}\u5929`);
    if (h > 0) parts.push(`${h}\u6642`);
    if (m > 0 || parts.length === 0) parts.push(`${m}\u5206`);
    return `${sign}${parts.join("")}`;
}
