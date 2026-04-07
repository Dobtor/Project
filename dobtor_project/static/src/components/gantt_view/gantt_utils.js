/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";

/**
 * Shared utility functions for the Gantt view.
 * Used by: gantt_renderer, gantt_bar_drag_hook, gantt_bar_resize_hook.
 *
 * Calendar-aware params used across many functions:
 *   hpd = hours per (working) day   – from calendarInfo.hours_per_day (default 24)
 *   dpw = working days per week      – from calendarInfo._workingWeekdays.size (default 7)
 */

/**
 * Escape HTML special characters to prevent XSS when inserting
 * dynamic values into innerHTML-built hint/tooltip strings.
 *
 * @param {*} str - Value to escape (coerced to string)
 * @returns {string} HTML-safe string
 */
export function escapeHtml(str) {
    const s = String(str ?? "");
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Convert a cell count delta to a Luxon-compatible duration object
 * based on the current scale.
 *
 * @param {number} cellsDelta - Number of cells moved (can be fractional)
 * @param {string} scale - Current gantt scale ("1h", "2h", "4h", "8h", "day", "week", "month")
 * @returns {Object} Duration object compatible with Luxon (e.g., { hours: 2 }, { days: 1 })
 */
export function cellsDeltaToDuration(cellsDelta, scale) {
    if (scale === "1h") return { hours: cellsDelta };
    if (scale === "2h") return { hours: cellsDelta * 2 };
    if (scale === "4h") return { hours: cellsDelta * 4 };
    if (scale === "8h") return { hours: cellsDelta * 8 };
    if (scale === "week") return { weeks: cellsDelta };
    if (scale === "month") return { months: cellsDelta };
    return { days: cellsDelta }; // default: day
}

/**
 * Format a number of (working) days into a human-readable short string.
 *
 * @param {number} days - Duration in working days (can be fractional)
 * @param {number} [dpw=7] - Working days per week
 * @returns {string} Formatted string (e.g., "4時", "3天", "2週1天")
 */
export function humanizeDays(days, dpw = 7, hpd = 24) {
    if (days < 0) return _t("%(n)s天", { n: 0 });
    if (days < 1) {
        const hours = Math.round(days * hpd);
        return _t("%(n)s時", { n: hours });
    }
    if (days < dpw) {
        return _t("%(n)s天", { n: Math.round(days * 10) / 10 });
    }
    const weeks = Math.floor(days / dpw);
    const remainDays = Math.round(days % dpw);
    if (remainDays === 0) return _t("%(n)s週", { n: weeks });
    return _t("%(w)s週%(d)s天", { w: weeks, d: remainDays });
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
 * "d" means one working day = hpd hours.
 * "w" means one working week = dpw * hpd hours.
 *
 * @param {string} text - Input string like "2d6h30m", "-1d", "3h", "1w"
 * @param {number} [hpd=24] - Hours per working day
 * @param {number} [dpw=7] - Working days per week
 * @returns {number} Total hours (can be negative)
 */
export function parseLagInput(text, hpd = 24, dpw = 7) {
    const negative = text.trim().startsWith("-");
    const regex = /(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/gi;
    let totalHours = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const val = parseFloat(match[1]);
        switch (match[2].toLowerCase()) {
            case "w": totalHours += val * dpw * hpd; break;
            case "d": totalHours += val * hpd; break;
            case "h": totalHours += val; break;
            case "m": totalHours += val / 60; break;
            case "s": totalHours += val / 3600; break;
        }
    }
    return negative ? -totalHours : totalHours;
}

/**
 * Convert hours to editable input format string (e.g., "2d6h30m").
 * Uses working-day hours (hpd) for the day unit.
 *
 * @param {number} hours - Duration in hours
 * @param {number} [hpd=24] - Hours per working day
 * @returns {string} Formatted string like "2d6h30m"
 */
export function hoursToInputFormat(hours, hpd = 24) {
    if (!hours) return "";
    const negative = hours < 0;
    const abs = Math.abs(hours);
    const d = Math.floor(abs / hpd);
    const remainH = abs - d * hpd;
    const h = Math.floor(remainH);
    const rawM = Math.round((remainH % 1) * 60);
    const m = rawM >= 60 ? 0 : rawM;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    const result = parts.join("") || "0h";
    return negative ? `-${result}` : result;
}

/**
 * Format hours into a human-readable display string (e.g., "2天", "4小時").
 * Uses working-day hours (hpd) and working-days-per-week (dpw) for conversion.
 *
 * @param {number} hours - Duration in hours
 * @param {number} [hpd=24] - Hours per working day
 * @param {number} [dpw=7] - Working days per week
 * @returns {string} Formatted string like "4.8天", "2小時", "1週3天"
 */
export function humanizeHours(hours, hpd = 24, dpw = 7) {
    if (hours === 0 || !hours) return "0";
    const negative = hours < 0;
    const absHours = Math.abs(hours);
    const days = absHours / hpd;
    let result;
    if (days < 1) {
        result = _t("%(n)s小時", { n: Math.round(absHours * 10) / 10 });
    } else if (days < dpw) {
        result = _t("%(n)s天", { n: Math.round(days * 10) / 10 });
    } else {
        const weeks = Math.floor(days / dpw);
        const remainDays = Math.round(days % dpw);
        if (remainDays === 0) {
            result = _t("%(n)s週", { n: weeks });
        } else {
            result = _t("%(w)s週%(d)s天", { w: weeks, d: remainDays });
        }
    }
    return negative ? `-${result}` : result;
}

/**
 * Serialize a Luxon DateTime (in any timezone) to Odoo's server datetime format (UTC).
 * Odoo stores datetimes as UTC strings: "yyyy-MM-dd HH:mm:ss".
 *
 * @param {DateTime} dt - Luxon DateTime in any timezone
 * @returns {string} UTC-formatted string for Odoo ORM write
 */
export function toOdooDatetime(dt) {
    return dt.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
}

/**
 * Format a cell delta into a human-readable delta label (e.g., "+2天3時", "-30分").
 * Uses hpd for day-based display thresholds.
 *
 * @param {number} cellsDelta - Number of cells moved
 * @param {string} scale - Current gantt scale
 * @param {number} [hpd=24] - Hours per working day
 * @param {number} [dpw=7] - Working days per week
 * @returns {string} Formatted label with sign prefix
 */
export function formatDeltaLabel(cellsDelta, scale, hpd = 24, dpw = 7) {
    const dur = cellsDeltaToDuration(cellsDelta, scale);
    // Month scale: display directly as months (variable length, no minute conversion)
    if (dur.months) {
        const sign = dur.months >= 0 ? "+" : "-";
        return `${sign}${_t("%(n)s月", { n: Math.abs(dur.months) })}`;
    }
    // Convert to total minutes using calendar-aware day/week length
    const totalMinutes = Math.round(
        (dur.weeks || 0) * dpw * hpd * 60 +
        (dur.days || 0) * hpd * 60 + (dur.hours || 0) * 60 + (dur.minutes || 0)
    );
    const sign = totalMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(totalMinutes);
    const hpdMin = hpd * 60;
    const d = Math.floor(abs / hpdMin);
    const h = Math.floor((abs % hpdMin) / 60);
    const m = abs % 60;
    const parts = [];
    if (d > 0) parts.push(_t("%(n)s天", { n: d }));
    if (h > 0) parts.push(_t("%(n)s時", { n: h }));
    if (m > 0 || parts.length === 0) parts.push(_t("%(n)s分", { n: m }));
    return `${sign}${parts.join("")}`;
}
