/**
 * The preview overlay maps a cascade diff to hollow bars, and only to bars.
 *
 *   node dobtor_project/tests/geometry/preview_overlay_check.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
    resolve(here, "../../static/src/components/gantt_view/gantt_preview.js"), "utf8");
const { previewBarsFromDiff, firstPreviewTask } = await import(
    "data:text/javascript;charset=utf-8," + encodeURIComponent(src));

const dt = (iso) => ({ isValid: true, toMillis: () => Date.parse(iso + "Z"), iso });
const io = {
    parseDate: (s) => (s === "bad" ? { isValid: false } : dt(s.replace(" ", "T"))),
    planWindow: (offset, duration) => ({ start: dt(`h${offset}`), end: dt(`h${offset + duration}`) }),
};

// dated task
let bars = previewBarsFromDiff({ 7: { date_start: "2026-11-05 08:00:00", date_end: "2026-11-05 17:00:00" } }, io);
assert.equal(Object.keys(bars).length, 1);
assert.equal(bars[7].dateStart.iso, "2026-11-05T08:00:00");
assert.equal(bars[7].dateEnd.iso, "2026-11-05T17:00:00");

// planning mode (no dates): window from plan_offset + plan_duration
bars = previewBarsFromDiff({ 8: { date_start: false, plan_offset: 32, plan_duration: 8 } }, io);
assert.equal(bars[8].dateStart.iso, "h32");
assert.equal(bars[8].dateEnd.iso, "h40");

// nothing resolvable -> no bar (never a half-drawn one)
bars = previewBarsFromDiff({
    1: { date_start: "bad" }, 2: {}, 3: null, 4: { plan_offset: 5, plan_duration: 0 }, x: { date_start: "2026-11-05 08:00:00" },
}, io);
assert.deepEqual(Object.keys(bars), []);
assert.deepEqual(previewBarsFromDiff(null, io), {});
assert.equal(firstPreviewTask({}), null);

// first task = earliest start
bars = previewBarsFromDiff({
    11: { date_start: "2026-11-09 08:00:00", date_end: "2026-11-09 17:00:00" },
    12: { date_start: "2026-11-05 08:00:00", date_end: "2026-11-05 17:00:00" } }, io);
assert.equal(firstPreviewTask(bars), 12);

console.log("preview overlay: ok");
