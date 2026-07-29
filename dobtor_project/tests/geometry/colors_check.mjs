/**
 * The chart's colour palette matches the shared fixture.
 *
 *   node dobtor_project/tests/geometry/colors_check.mjs
 *
 * A bar has to be the same colour on screen and in the PDF, and the palette is
 * a production constant in two languages — gantt_colors.js and
 * report/project_gantt_report.py. tests/test_report_colors.py asserts the other
 * half against the same fixture, so neither can be edited alone.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
    resolve(here, "../../static/src/components/gantt_view/gantt_colors.js"), "utf8");
const { GANTT_COLORS, NO_COLOR_STYLE } = await import(
    "data:text/javascript;charset=utf-8," + encodeURIComponent(src));
const fixture = JSON.parse(readFileSync(
    resolve(here, "../fixtures/gantt_colors.json"), "utf8"));

const problems = [];
if (GANTT_COLORS.length !== fixture.gantt_colors.length) {
    problems.push(`palette has ${GANTT_COLORS.length} entries, fixture has ${fixture.gantt_colors.length}`);
}
fixture.gantt_colors.forEach((expected, i) => {
    if (GANTT_COLORS[i] !== expected) {
        problems.push(`colour ${i}: ${JSON.stringify(GANTT_COLORS[i])} ≠ ${JSON.stringify(expected)}`);
    }
});
if (NO_COLOR_STYLE !== fixture.no_color_style) {
    problems.push(`no-colour style: ${NO_COLOR_STYLE} ≠ ${fixture.no_color_style}`);
}
// index 0 must stay "no colour": the renderer and the report both branch on it
if (GANTT_COLORS[0] !== "") problems.push("index 0 must be the empty 'no colour' slot");

if (problems.length) {
    console.error("FAIL — palette drifted from the fixture:");
    for (const p of problems) console.error("   " + p);
    process.exit(1);
}
console.log(`OK — ${GANTT_COLORS.length} colours match tests/fixtures/gantt_colors.json`);
