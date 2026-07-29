/**
 * Planning-mode axis sweep.
 *
 *   node dobtor_project/tests/geometry/plan_axis_sweep.mjs
 *
 * Exercises the SHIPPED axis (static/src/components/gantt_view/gantt_plan_axis.js,
 * loaded verbatim). In planning mode a task's position and length are working
 * hours from T+0 — there are no dates — so the properties to hold are:
 *
 *   1. ROUND-TRIP     px → hours → px is the identity (a drag commits the plan
 *                     offset the bar was dropped on).
 *   2. PROPORTIONAL   equal planned hours ⇒ equal pixel length, at every zoom
 *                     level and every offset. This is what the old fake-DateTime
 *                     representation kept breaking: the hours were multiplied by
 *                     24/hpd on the way in and divided again on the way out, in
 *                     a dozen separate places.
 *   3. ONE CELL       a working day is one day cell, a working week is one week
 *                     cell, N hours is one N-hour cell.
 *   4. ORIGIN         the axis never starts left of T+0, and T+0 is at x=0 when
 *                     the chart starts there.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
    resolve(here, "../../static/src/components/gantt_view/gantt_plan_axis.js"), "utf8");
const {
    planHoursPerCell, planHoursToPx, pxToPlanHours, planCellRange, planCellLabel, planDayLabel,
} = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(src));

const SCALES = ["1h", "2h", "4h", "8h", "day", "week", "month"];
const CALENDARS = [
    { hpd: 8, dpw: 5 },      // the usual 8h × Mon-Fri
    { hpd: 7.5, dpw: 5 },
    { hpd: 4, dpw: 6 },      // half days, six-day week
    { hpd: 24, dpw: 7 },     // continuous
];
const CELL_WIDTHS = [24, 40, 120];

const failures = [];
const fail = (what, detail) => failures.push(`${what}: ${detail}`);
let checks = 0;

for (const { hpd, dpw } of CALENDARS) {
    for (const scale of SCALES) {
        const hpc = planHoursPerCell(scale, hpd, dpw);
        if (!(hpc > 0)) fail(`${scale} @${hpd}h`, `hoursPerCell = ${hpc}`);

        // 3. one unit = one cell
        const unit = scale === "day" ? hpd
            : scale === "week" ? hpd * dpw
            : scale === "month" ? hpd * dpw * 4
            : parseInt(scale);
        if (Math.abs(hpc - unit) > 1e-9) {
            fail(`${scale} @${hpd}h`, `cell is ${hpc}h, expected ${unit}h`);
        }

        for (const cw of CELL_WIDTHS) {
            for (const firstCell of [0, 1, 7, 30]) {
                // 1. round-trip
                for (let px = -200; px <= 2000; px += 37) {
                    const hours = pxToPlanHours(px, hpc, firstCell, cw);
                    const back = planHoursToPx(hours, hpc, firstCell, cw);
                    checks++;
                    if (Math.abs(back - px) > 1e-9) {
                        fail(`${scale} @${hpd}h cw${cw} first${firstCell} round-trip`,
                             `${px} → ${hours}h → ${back}`);
                    }
                }

                // 2. equal hours ⇒ equal length, anywhere on the axis
                for (const H of [0.5, 1, 4, 8, 40, 173]) {
                    const widths = [];
                    for (const offset of [0, 3, 8, 17.25, 100, 999.5]) {
                        widths.push(
                            planHoursToPx(offset + H, hpc, firstCell, cw) -
                            planHoursToPx(offset, hpc, firstCell, cw));
                    }
                    checks++;
                    const spread = Math.max(...widths) - Math.min(...widths);
                    if (spread > 1e-9) {
                        fail(`${scale} @${hpd}h ${H}h length varies`, `spread ${spread}`);
                    }
                    const expected = (H / hpc) * cw;
                    if (Math.abs(widths[0] - expected) > 1e-9) {
                        fail(`${scale} @${hpd}h ${H}h width`,
                             `${widths[0]} vs expected ${expected}`);
                    }
                }
            }
        }

        // 4. origin: the range never starts before T+0, T+0 sits at x=0
        const { first, last } = planCellRange(-48, 500, hpc);
        if (first !== 0) fail(`${scale} @${hpd}h origin`, `first cell ${first}`);
        if (last < first) fail(`${scale} @${hpd}h range`, `last ${last} < first ${first}`);
        if (planHoursToPx(0, hpc, 0, 40) !== 0) {
            fail(`${scale} @${hpd}h origin px`, "T+0 is not at x=0");
        }
        // cells must cover the requested span
        if (last * hpc < 500 - 1e-9) {
            fail(`${scale} @${hpd}h coverage`, `last cell ends at ${last * hpc}h < 500h`);
        }
    }
}

// labels
const labelCases = [
    [0, "day", "T0"], [3, "day", "T+3"], [1, "week", "W+1"], [2, "month", "M+2"], [5, "4h", "H+5"],
];
for (const [i, scale, expected] of labelCases) {
    const got = planCellLabel(i, scale);
    if (got !== expected) fail("cell label", `${scale} #${i} → ${got}, expected ${expected}`);
}
const dayLabelCases = [[0, 8, "T"], [8, 8, "T+1d"], [24, 8, "T+3d"], [12, 8, "T+1.5d"]];
for (const [h, hpd, expected] of dayLabelCases) {
    const got = planDayLabel(h, hpd);
    if (got !== expected) fail("day label", `${h}h @${hpd} → ${got}, expected ${expected}`);
}

if (failures.length) {
    console.error(`FAIL — ${failures.length} violation(s):`);
    for (const f of failures.slice(0, 25)) console.error("   " + f);
    process.exit(1);
}
console.log(`OK — planning axis: ${checks} checks over ${SCALES.length} zoom levels `
    + `× ${CALENDARS.length} calendars — px↔hours round-trips, equal hours draw equal `
    + `length everywhere, one working day/week is one cell, origin pinned at T+0.`);
