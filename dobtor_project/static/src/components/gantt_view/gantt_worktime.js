/** @odoo-module **/

/**
 * Working-time arithmetic for the timeline axis — pure numbers, NO IMPORTS.
 *
 * A day column's width means the working time of that day, not 24 clock hours:
 * with a 9:00–12:00 / 13:00–18:00 calendar, the 8 scheduled hours fill the whole
 * cell, the lunch break and the night take no width, and two tasks of equal
 * scheduled hours draw equal lengths wherever they sit.
 *
 * Kept import-free on purpose: tests/geometry/worktime_axis_sweep.mjs loads this
 * exact file under plain node. Intervals are `[{from, to}]` in decimal hours of
 * the local day, the shape gantt_model builds in calendarInfo._weekdayMap.
 */

/** Total working hours in a day's intervals. */
export function dayWorkHours(intervals) {
    let total = 0;
    for (const iv of intervals || []) {
        total += Math.max(0, iv.to - iv.from);
    }
    return total;
}

/** Working hours between two hours-of-day within one day's intervals. */
export function workHoursInRange(intervals, fromHour, toHour) {
    let total = 0;
    for (const iv of intervals || []) {
        const s = Math.max(iv.from, fromHour);
        const e = Math.min(iv.to, toHour);
        if (e > s) total += e - s;
    }
    return total;
}

/**
 * How far through the day's working time `hour` sits, as 0..1.
 * Before the first interval → 0; inside the lunch break → the fraction reached
 * at the break's start; after the last interval → 1.
 * Returns 0 for a day with no working time (it collapses to its column's edge).
 */
export function workingFractionOfDay(intervals, hour) {
    const total = dayWorkHours(intervals);
    if (total <= 0) return 0;
    const done = workHoursInRange(intervals, 0, hour);
    return Math.max(0, Math.min(1, done / total));
}

/**
 * Inverse of {@link workingFractionOfDay}: the hour-of-day at which `frac` of
 * the day's working time has elapsed. Returns null when the day does not work,
 * so the caller can decide what a position inside it means.
 */
export function workingHourOfDayFromFraction(intervals, frac) {
    const total = dayWorkHours(intervals);
    if (total <= 0) return null;
    let want = Math.max(0, Math.min(1, frac)) * total;
    for (const iv of intervals) {
        const len = Math.max(0, iv.to - iv.from);
        if (want <= len) return iv.from + want;
        want -= len;
    }
    return intervals[intervals.length - 1].to;
}
