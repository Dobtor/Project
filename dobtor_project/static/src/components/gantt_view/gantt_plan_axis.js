/** @odoo-module **/

/**
 * The planning-mode axis — pure numbers, NO IMPORTS.
 *
 * In planning mode a task has no dates: its position is `plan_offset`, in
 * WORKING HOURS from T+0, and its length is `plan_duration`, likewise in working
 * hours. That is the only truth, and this module is the only place that turns it
 * into pixels.
 *
 * Previously the hours were baked into a fake DateTime (T0 = 2000-01-01 plus the
 * hours, multiplied by 24/hours_per_day so that a working day filled a day
 * column). That scale factor then had to be undone again everywhere the hours
 * were read back — drag deltas, lag maths, milestone positions, the PDF report —
 * and every one of those sites was a chance to multiply where you should divide.
 * Now the hours stay hours all the way to the axis, and the conversion happens
 * once, here.
 *
 * A cell is one unit of the current zoom level:
 *   1h/2h/4h/8h → that many working hours
 *   day         → one working day        (hours_per_day)
 *   week        → one working week       (hours_per_day × working days per week)
 *   month       → four working weeks     (planning has no calendar to ask, so a
 *                                         "month" is simply the next zoom step)
 */

/** Working hours represented by one cell at the given zoom level. */
export function planHoursPerCell(scale, hpd, dpw) {
    const hoursPerDay = hpd > 0 ? hpd : 8;
    const daysPerWeek = dpw > 0 ? dpw : 5;
    switch (scale) {
        case "1h": return 1;
        case "2h": return 2;
        case "4h": return 4;
        case "8h": return 8;
        case "week": return hoursPerDay * daysPerWeek;
        case "month": return hoursPerDay * daysPerWeek * 4;
        case "day":
        default: return hoursPerDay;
    }
}

/**
 * Pixel position of a point on the plan, measured from the first drawn cell.
 *
 * @param {number} hours working hours from T+0
 * @param {number} hoursPerCell see {@link planHoursPerCell}
 * @param {number} firstCell index of the leftmost drawn cell (T+0 is cell 0)
 * @param {number} cellWidth px
 */
export function planHoursToPx(hours, hoursPerCell, firstCell, cellWidth) {
    if (!hoursPerCell) return 0;
    return (hours / hoursPerCell - firstCell) * cellWidth;
}

/** Inverse of {@link planHoursToPx}. */
export function pxToPlanHours(px, hoursPerCell, firstCell, cellWidth) {
    if (!cellWidth) return 0;
    return (px / cellWidth + firstCell) * hoursPerCell;
}

/**
 * Index range of the cells that cover [fromHours, toHours].
 * Never starts before T+0: a plan does not have negative hours, and letting the
 * axis drift left of its own origin is how the header ends up labelled T-6.
 */
export function planCellRange(fromHours, toHours, hoursPerCell) {
    if (!hoursPerCell) return { first: 0, last: 0 };
    const first = Math.max(0, Math.floor(fromHours / hoursPerCell));
    const last = Math.max(first, Math.ceil(toHours / hoursPerCell));
    return { first, last };
}

/**
 * Header label for a planning cell.
 *
 * Day/week/month cells are counted (T+3, W+2, M+1). The sub-day zooms label the
 * HOUR the cell starts at, not the cell's ordinal: at the 4h zoom the fourth
 * cell is H+12, because "H+3" there would read as hour three when it is hour
 * twelve.
 */
export function planCellLabel(index, scale, hoursPerCell = 1) {
    if (scale === "week") return `W${index > 0 ? "+" : ""}${index}`;
    if (scale === "month") return `M${index > 0 ? "+" : ""}${index}`;
    if (scale === "day") return `T${index > 0 ? "+" : ""}${index}`;
    const hour = index * hoursPerCell;
    return `H${hour > 0 ? "+" : ""}${hour}`;
}

/**
 * "T+3d" style label for an instant on the plan, at working-day precision.
 * @param {number} hours working hours from T+0
 * @param {number} hpd hours per working day
 */
export function planDayLabel(hours, hpd) {
    const hoursPerDay = hpd > 0 ? hpd : 8;
    const days = hours / hoursPerDay;
    if (Math.abs(days) < 0.001) return "T";
    if (Math.abs(days - Math.round(days)) < 0.01) {
        return `T${days > 0 ? "+" : ""}${Math.round(days)}d`;
    }
    return `T${days > 0 ? "+" : ""}${days.toFixed(1)}d`;
}
