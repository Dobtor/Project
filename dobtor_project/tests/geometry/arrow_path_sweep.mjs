/**
 * Dependency-connector geometry sweep.
 *
 *   node dobtor_project/tests/geometry/arrow_path_sweep.mjs
 *
 * Exercises the SHIPPED geometry (static/src/components/gantt_view/
 * gantt_arrow_path.js, loaded verbatim) over every combination of link type,
 * bar width, horizontal gap and row distance, and asserts the four invariants
 * the connectors are supposed to hold:
 *
 *   1. NO BACKFOLD   — X advances monotonically along the exit direction.
 *   2. ATTACHED      — the path starts on the source bar…
 *   3. LANDS INSIDE  — …and the arrowhead ends inside the target bar.
 *   4. 45°           — the exit leg's run equals its rise, exactly.
 *
 * Why a plain node script and not a QUnit/hoot test: this is pure arithmetic
 * with no DOM, and the failure it exists to catch (every SS link degenerating
 * into a floating vertical line) is invisible to anything that only checks
 * "an arrow was rendered". Keeping it runnable without Odoo means it can be run
 * in a second, from anywhere, including a machine with no database.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The geometry module is a .js file inside an Odoo addon (no package.json,
// so node would read it as CommonJS). Load the source and import it as ESM.
const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
    here, "../../static/src/components/gantt_view/gantt_arrow_path.js");
const source = readFileSync(modulePath, "utf8");
const { computeConnectorPath } = await import(
    "data:text/javascript;charset=utf-8," + encodeURIComponent(source));

// Layout constants mirrored from GanttArrows' defaultProps / the SCSS.
const ROW_HEIGHT = 44;
const BAR_HEIGHT = 28;
const CHAMFER_D = BAR_HEIGHT / 4;
const BAR_EDGE = BAR_HEIGHT / 2;
const TOL = 0.5;

const TYPES = ["FS", "SS", "FF", "SF"];
const PARENT_LEFTS = [0, 60];
const BAR_WIDTHS = [12, 40, 120];          // 12 = MIN_BAR_W clamp
const GAPS = [-400, -200, -40, -12, 0, 12, 40, 120, 400];
const ROW_DELTAS = [-5, -3, -1, 1, 2, 5];

/** Path "M x y L x y …" → [[x, y], …] */
function points(d) {
    const nums = d.replace(/[ML]/g, " ").trim().split(/\s+/).map(Number);
    const out = [];
    for (let i = 0; i < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
    return out;
}

const failures = [];
let cases = 0;

for (const type of TYPES) {
    for (const parentLeft of PARENT_LEFTS) {
        for (const pW of BAR_WIDTHS) {
            for (const gap of GAPS) {
                for (const cW of BAR_WIDTHS) {
                    for (const rowDelta of ROW_DELTAS) {
                        const parentRight = parentLeft + pW;
                        const childLeft = parentRight + gap;
                        const childRight = childLeft + cW;
                        const fromY = 0;
                        const toY = rowDelta * ROW_HEIGHT;
                        const layout = { type, parentLeft, parentRight, childLeft,
                                         childRight, rowDelta };

                        const r = computeConnectorPath({
                            type, parentLeft, parentRight, childLeft, childRight,
                            fromY, toY, chamferD: CHAMFER_D, barEdge: BAR_EDGE,
                        });
                        cases++;

                        const P = points(r.d);
                        const fail = (what, detail) =>
                            failures.push({ what, detail, d: r.d, ...layout });

                        // 1. no backfold
                        const xs = P.map(p => p[0]);
                        const dir = Math.sign((xs.at(-1) - xs[0]) || 1);
                        for (let i = 1; i < xs.length; i++) {
                            if ((xs[i] - xs[i - 1]) * dir < -TOL) {
                                fail("backfold", `x ${xs[i - 1]} → ${xs[i]}`);
                                break;
                            }
                        }

                        // 2. starts on the source bar
                        const [sx] = P[0];
                        if (sx < parentLeft - TOL || sx > parentRight + TOL) {
                            fail("detached from source",
                                 `starts at ${sx}, bar ${parentLeft}..${parentRight}`);
                        }

                        // 3. arrowhead inside the target bar
                        const [ex] = P.at(-1);
                        if (ex < childLeft - TOL || ex > childRight + TOL) {
                            fail("arrowhead outside target",
                                 `ends at ${ex}, bar ${childLeft}..${childRight}`);
                        }

                        // 4. the exit leg is exactly 45°
                        if (!r.isSameRow && P.length >= 3) {
                            const run = Math.abs(P[1][0] - P[0][0]);
                            const rise = Math.abs(P[1][1] - P[0][1]);
                            if (Math.abs(run - rise) > 0.001) {
                                fail("exit leg not 45°", `run ${run} vs rise ${rise}`);
                            }
                        }
                    }
                }
            }
        }
    }
}

if (failures.length) {
    console.error(`FAIL — ${failures.length} of ${cases} connector layouts break an invariant:`);
    for (const f of failures.slice(0, 20)) {
        console.error(`  [${f.type}] ${f.what}: ${f.detail}`);
        console.error(`     source ${f.parentLeft}..${f.parentRight}, target ` +
                      `${f.childLeft}..${f.childRight}, rows ${f.rowDelta}`);
        console.error(`     d = ${f.d}`);
    }
    if (failures.length > 20) console.error(`  …and ${failures.length - 20} more`);
    process.exit(1);
}
console.log(`OK — ${cases} connector layouts, all four invariants hold.`);
