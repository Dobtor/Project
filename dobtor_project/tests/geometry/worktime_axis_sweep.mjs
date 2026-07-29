/**
 * Working-time axis sweep.
 *
 *   node dobtor_project/tests/geometry/worktime_axis_sweep.mjs
 *
 * Exercises the SHIPPED axis maths (static/src/components/gantt_view/
 * gantt_worktime.js, loaded verbatim) and the day-scale position formula the
 * renderer builds on top of it — px(dt) = (whole days + working fraction) × cw.
 *
 * The property that matters: a day cell means the day's WORKING time, so two
 * tasks scheduled for the same number of hours draw the same length no matter
 * where they sit — across a lunch break, across a night, across several days.
 * Measuring the wall clock is what made an 8-hour task that ran 09:00→18:00
 * look three times longer than one that ran 09:00→17:00 with no break.
 *
 * Non-working DAYS deliberately still occupy a column (option B: the weekend
 * cells stay visible; the "hide non-working days" toggle is what removes them),
 * so the equal-length property is asserted over spans that contain no weekend.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
    resolve(here, "../../static/src/components/gantt_view/gantt_worktime.js"), "utf8");
const {
    dayWorkHours, workHoursInRange, workingFractionOfDay, workingHourOfDayFromFraction,
} = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(src));

const CW = 40;                       // px per day column
const EPS = 1e-9;
const failures = [];
const fail = (what, detail) => failures.push(`${what}: ${detail}`);

// Calendars to sweep. `days` maps weekday (1=Mon..7=Sun) → intervals.
const CALENDARS = {
    "9-12/13-18 Mon-Fri": {
        work: [{ from: 9, to: 12 }, { from: 13, to: 18 }],
        weekend: [6, 7],
    },
    "8-12/13-17 Mon-Fri": {
        work: [{ from: 8, to: 12 }, { from: 13, to: 17 }],
        weekend: [6, 7],
    },
    "continuous 0-24": {
        work: [{ from: 0, to: 24 }],
        weekend: [],
    },
    "single block 9-17": {
        work: [{ from: 9, to: 17 }],
        weekend: [6, 7],
    },
};

for (const [name, cal] of Object.entries(CALENDARS)) {
    const ivs = cal.work;
    const dayHours = dayWorkHours(ivs);

    // px of "day index d, hour h" on the day-scale axis.
    const px = (d, h) => (d + workingFractionOfDay(ivs, h)) * CW;

    // ---- 1. the break and the night take no width --------------------------
    const firstEnd = ivs[0].to;
    if (ivs.length > 1) {
        const breakStart = px(0, ivs[0].to);
        const breakEnd = px(0, ivs[1].from);
        if (Math.abs(breakStart - breakEnd) > 1e-6) {
            fail(`${name} / break has width`,
                 `${breakStart} → ${breakEnd}`);
        }
    }
    const nightEnd = px(0, 24);         // end of day d
    const nextStart = px(1, 0);         // start of day d+1
    if (Math.abs(nightEnd - nextStart) > 1e-6) {
        fail(`${name} / night has width`, `${nightEnd} vs ${nextStart}`);
    }

    // ---- 2. one working day is exactly one cell ----------------------------
    const fullDay = px(0, ivs[ivs.length - 1].to) - px(0, ivs[0].from);
    if (Math.abs(fullDay - CW) > 1e-6) {
        fail(`${name} / a full working day is not one cell`, `${fullDay}px`);
    }

    // ---- 3. monotonic, and round-trips through the inverse -----------------
    let prev = -Infinity;
    for (let h = 0; h <= 24; h += 0.25) {
        const p = px(0, h);
        if (p < prev - 1e-9) fail(`${name} / axis goes backwards`, `at ${h}h`);
        prev = p;
    }
    for (let f = 0; f <= 1.0001; f += 0.05) {
        const hour = workingHourOfDayFromFraction(ivs, Math.min(f, 1));
        const back = workingFractionOfDay(ivs, hour);
        if (Math.abs(back - Math.min(f, 1)) > 1e-9) {
            fail(`${name} / fraction round-trip`, `${f} → ${hour}h → ${back}`);
        }
    }

    // ---- 4. THE PROPERTY: equal scheduled hours ⇒ equal drawn length -------
    // Place a task of H working hours at every legal start instant (quarter-hour
    // granularity, inside working time, spilling over as many days as needed),
    // and check the pixel width is always H / dayHours cells.
    for (const H of [0.5, 1, 2, 3.5, 4, 7, 8, 8.5, 12, 16, 20]) {
        if (H > dayHours * 4) continue;
        const expected = (H / dayHours) * CW;
        for (let startH = 0; startH <= 24; startH += 0.25) {
            // only starts that sit inside working time are legal (the server
            // snaps every start into a work interval before writing)
            const inWork = ivs.some(iv => startH >= iv.from && startH < iv.to);
            if (!inWork) continue;

            // walk H working hours forward through consecutive WORKING days
            let d = 0, h = startH, left = H;
            while (left > EPS) {
                const rest = workHoursInRange(ivs, h, 24);
                if (rest >= left - EPS) {
                    h = workingHourOfDayFromFraction(
                        ivs, workingFractionOfDay(ivs, h) + left / dayHours);
                    left = 0;
                } else {
                    left -= rest;
                    d += 1;
                    h = 0;
                }
            }
            const width = px(d, h) - px(0, startH);
            if (Math.abs(width - expected) > 1e-6) {
                fail(`${name} / ${H}h task width varies`,
                     `start ${startH}h → ${width.toFixed(4)}px, expected ${expected.toFixed(4)}px`);
            }
        }
    }
}

// ---- 5. a day with no working time collapses to its column edge ------------
if (workingFractionOfDay([], 13) !== 0) {
    fail("empty day", "does not collapse to 0");
}
if (workingHourOfDayFromFraction([], 0.5) !== null) {
    fail("empty day inverse", "should report 'no working time'");
}

if (failures.length) {
    console.error(`FAIL — ${failures.length} violation(s):`);
    for (const f of failures.slice(0, 25)) console.error("   " + f);
    if (failures.length > 25) console.error(`   …and ${failures.length - 25} more`);
    process.exit(1);
}
console.log(`OK — working-time axis holds for ${Object.keys(CALENDARS).length} calendars: `
    + "breaks and nights take no width, one working day is one cell, "
    + "and equal scheduled hours always draw equal length.");
