/**
 * The axis reads the PROJECT's clock, not the viewer's.
 *
 *   node dobtor_project/tests/geometry/axis_timezone_sweep.mjs
 *
 * Loads the SHIPPED axis module (gantt_renderer_axis.js) and mixes it into a
 * stand-in renderer — the same object the real one is, minus OWL — so the cell
 * resolution and the working-time fractions being tested are the ones that ship.
 *
 * A work calendar's attendances are hours of the PROJECT's day: 09:00 means
 * nine o'clock where the work happens, and the server snaps every date with
 * `pytz.timezone(project.tz)`. The browser's dates are in the VIEWER's zone, so
 * reading `dt.hour` to ask "is this working time?" compares one clock against
 * another. Same-zone viewers never notice. The property asserted here is the one
 * that matters: the answer must not depend on where the viewer is sitting.
 *
 * Luxon comes from the Odoo checkout (it is a bundle global in the browser, and
 * there is no node_modules here); the module's own imports are rewritten to
 * data: URLs so nothing but @web/... needs stubbing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../static/src/components/gantt_view");

// ---- luxon -----------------------------------------------------------------
const LUXON_CANDIDATES = [
    process.env.ODOO_SRC && `${process.env.ODOO_SRC}/addons/web/static/lib/luxon/luxon.js`,
    `${process.env.HOME}/Desktop/Claude/odoo-18.0/addons/web/static/lib/luxon/luxon.js`,
    `${process.env.HOME}/Documents/GitHub/odoo/addons/web/static/lib/luxon/luxon.js`,
].filter(Boolean);
const luxonPath = LUXON_CANDIDATES.find(p => existsSync(p));
if (!luxonPath) {
    console.log("SKIP — no Odoo checkout found for luxon (set ODOO_SRC)");
    process.exit(0);
}
const ctx = {};
createContext(ctx);
runInContext(readFileSync(luxonPath, "utf8"), ctx);
const { DateTime, Settings } = ctx.luxon;

// ---- the shipped axis, with its local imports inlined ----------------------
const dataUrl = (src) => "data:text/javascript;charset=utf-8," + encodeURIComponent(src);
const read = (name) => readFileSync(resolve(SRC, name), "utf8");

const utilsStub = `
    export const PLANNING_T0 = null;             // planning mode is not under test
    export function cellsDeltaToDuration() { return {}; }
`;
const axisSrc = read("gantt_renderer_axis.js")
    .replace('from "./gantt_worktime"', `from "${dataUrl(read("gantt_worktime.js"))}"`)
    .replace('from "./gantt_plan_axis"', `from "${dataUrl(read("gantt_plan_axis.js"))}"`)
    .replace('from "./gantt_utils"', `from "${dataUrl(utilsStub)}"`);
const { GanttAxisMixin } = await import(dataUrl(axisSrc));

// ---- a stand-in renderer ---------------------------------------------------
// 09:00–12:00 / 13:00–18:00, Mon–Fri, in the project's zone.
const WEEKDAY_MAP = {};
for (let d = 0; d < 5; d++) {
    WEEKDAY_MAP[String(d)] = [{ from: 9, to: 12 }, { from: 13, to: 18 }];
}

function makeRenderer(projectZone, timeStart) {
    const renderer = Object.create(Object.defineProperties({},
        Object.getOwnPropertyDescriptors(GanttAxisMixin)));
    renderer.props = {
        scale: "day",
        hideNonWorkingDays: false,
        model: { data: {
            timeStart,
            calendarInfo: {
                tz: projectZone,
                hours_per_day: 8,
                _weekdayMap: WEEKDAY_MAP,
                _leaveDays: new Set(),
                _workingWeekdays: new Set([1, 2, 3, 4, 5]),
            },
        } },
    };
    renderer.cellWidth = 40;
    renderer._extendedTimeStart = timeStart;
    renderer.isPlanningMode = false;
    renderer._calHpd = 8;
    renderer._calDpw = 5;
    return renderer;
}

const failures = [];
const fail = (what, detail) => failures.push(`${what}: ${detail}`);
let checks = 0;

const PROJECT_ZONE = "Asia/Taipei";
// Viewers in four zones look at the same project.
const VIEWER_ZONES = ["Asia/Taipei", "UTC", "America/New_York", "Europe/Berlin"];

// Monday 2026-03-02, 09:00 Taipei — the start of the project's working week.
const MON_09_TAIPEI = DateTime.fromISO("2026-03-02T09:00:00", { zone: PROJECT_ZONE });

// Instants through that day and the next, as absolute points in time.
const SAMPLES = [];
for (let h = 0; h <= 32; h += 0.5) {
    SAMPLES.push(MON_09_TAIPEI.plus({ hours: h }));
}

const reference = [];
for (const viewer of VIEWER_ZONES) {
    Settings.defaultZone = viewer;
    // The model anchors the range on the PROJECT's day boundary (see
    // _calculateTimeRange), so the origin is the same instant for every viewer.
    const timeStart = MON_09_TAIPEI.setZone(PROJECT_ZONE).startOf("day").setZone(viewer);
    const renderer = makeRenderer(PROJECT_ZONE, timeStart);

    const readings = SAMPLES.map(instant => {
        const dt = instant.setZone(viewer);        // what the browser would hold
        return renderer._workingFractionOfDay(dt);
    });
    checks += readings.length;

    if (!reference.length) {
        reference.push(...readings);
        // Sanity: the fractions must actually be the calendar's, not the clock's.
        const atNine = renderer._workingFractionOfDay(MON_09_TAIPEI.setZone(viewer));
        const atNoon = renderer._workingFractionOfDay(
            MON_09_TAIPEI.plus({ hours: 3 }).setZone(viewer));   // 12:00 → 3/8
        const atSix = renderer._workingFractionOfDay(
            MON_09_TAIPEI.plus({ hours: 9 }).setZone(viewer));   // 18:00 → 1
        if (Math.abs(atNine) > 1e-9) fail("09:00", `fraction ${atNine}, expected 0`);
        if (Math.abs(atNoon - 3 / 8) > 1e-9) fail("12:00", `fraction ${atNoon}, expected 0.375`);
        if (Math.abs(atSix - 1) > 1e-9) fail("18:00", `fraction ${atSix}, expected 1`);
    } else {
        readings.forEach((value, i) => {
            if (Math.abs(value - reference[i]) > 1e-9) {
                fail(`viewer ${viewer}`,
                     `sample ${i} (${SAMPLES[i].setZone(PROJECT_ZONE).toFormat("EEE HH:mm")}) `
                     + `reads ${value.toFixed(4)}, Taipei viewer read ${reference[i].toFixed(4)}`);
            }
        });
    }

    // The working-day a bar belongs to must also be the project's day, not the
    // viewer's: 08:00 Taipei Tuesday is still Monday evening in New York.
    const tueEarly = MON_09_TAIPEI.plus({ days: 1 }).setZone(viewer);   // Tue 09:00 Taipei
    const cell = renderer._cellOf(tueEarly);
    if (!cell || cell.index !== 1) {
        fail(`viewer ${viewer}`, `Tuesday resolved to cell ${cell && cell.index}, expected 1`);
    }
    checks++;

    // …and the inverse lands back on the same instant.
    const roundTrip = renderer._pxToDate(renderer._dateToPx(tueEarly));
    if (!roundTrip || Math.abs(+roundTrip - +tueEarly) > 60 * 1000) {
        fail(`viewer ${viewer}`,
             `round-trip drifted: ${roundTrip && roundTrip.toISO()} vs ${tueEarly.toISO()}`);
    }
    checks++;
}
Settings.defaultZone = "system";

if (failures.length) {
    console.error(`FAIL — ${failures.length} violation(s):`);
    for (const f of failures.slice(0, 20)) console.error("   " + f);
    process.exit(1);
}
console.log(`OK — axis reads the project's clock: ${checks} checks across `
    + `${VIEWER_ZONES.length} viewer zones agree with the ${PROJECT_ZONE} calendar.`);
