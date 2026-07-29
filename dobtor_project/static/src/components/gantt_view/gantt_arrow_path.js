/** @odoo-module **/

/**
 * Pure geometry for dependency connectors — no OWL, no Odoo, NO IMPORTS.
 *
 * That is deliberate: `tests/geometry/arrow_path_sweep.mjs` loads this exact
 * file under plain node and sweeps thousands of bar layouts through it. Keep it
 * dependency-free or the sweep stops testing the shipped code and starts
 * testing a copy of it — which is how the SS/SF connectors managed to be broken
 * for every single link without anything noticing.
 *
 * Routing — all arrowheads are vertical (↓ or ↑). The connector leaves the
 * source on a 45° diagonal and turns vertical, landing D pixels inside the
 * target's connection edge (the deliberate endpoint offset).
 *
 *   Non-tight (target beyond chamfer distance):
 *     M source → 45° chamfer (length D) → horizontal to targetX → vertical ↓/↑
 *
 *   Tight (target within chamfer distance):
 *     M source → 45° chamfer SHORTENED to the available distance → vertical ↓/↑
 *
 *   Overlap (target's connection point behind the source's, bars overlapping):
 *     M targetX, source bar edge → vertical ↓/↑
 *
 * INVARIANT 1 — the corner is constant. The leg's horizontal run and the
 * arrowhead's inset from the target edge are the same distance D, identical on
 * every connector. When the source's bar reaches past the target's connection
 * edge (a flush chain whose short predecessor was widened by the min-width
 * clamp), the vertical line slides further INTO the target to make room, so the
 * leg keeps its size; the leg shrinks only once the inset hits its own bound
 * (half the target bar, or MAX_INSET), and then it shrinks proportionally.
 *
 * INVARIANT 2 — no backfold. Along the exit direction the path's X only ever
 * advances; the leg is clamped to the distance actually available.
 *
 * INVARIANT 3 — attached at both ends. A connector starts on its source bar and
 * its arrowhead lands inside its target bar. Never a line floating in the gap.
 */

/** How far the vertical line may be pushed INTO the target bar to keep the
 *  chamfer at its constant size. */
export const MAX_INSET = 24;

const EPS = 0.5;

/**
 * Where a link type attaches on each bar.
 *   FS: source right → target left     SS: source left  → target left
 *   FF: source right → target right    SF: source left  → target right
 */
function connectionX(type, parentLeft, parentRight, childLeft, childRight) {
    switch (type) {
        case "SS": return { fromX: parentLeft, toX: childLeft };
        case "FF": return { fromX: parentRight, toX: childRight };
        case "SF": return { fromX: parentLeft, toX: childRight };
        case "FS":
        default: return { fromX: parentRight, toX: childLeft };
    }
}

/**
 * The whole connector for one dependency link.
 *
 * @param {Object} o
 * @param {string} o.type link type: FS, SS, FF, SF
 * @param {number} o.parentLeft  source bar left edge X (visual, clamped)
 * @param {number} o.parentRight source bar right edge X
 * @param {number} o.childLeft   target bar left edge X
 * @param {number} o.childRight  target bar right edge X
 * @param {number} o.fromY source bar center Y
 * @param {number} o.toY   target bar center Y
 * @param {number} o.chamferD nominal corner size
 * @param {number} o.barEdge half bar height (center → top/bottom edge)
 * @returns {{d:string, turnX:number, turnY:number, isTight:boolean, isSameRow:boolean}}
 */
export function computeConnectorPath(o) {
    const type = (o.type || "FS").toUpperCase();
    const { parentLeft, parentRight, childLeft, childRight,
            fromY, toY, chamferD, barEdge } = o;
    const { fromX, toX } = connectionX(
        type, parentLeft, parentRight, childLeft, childRight);

    // SS/FF overlap: when the target is behind the source, draw a vertical from
    // the source bar's top/bottom edge to the target bar's, at the target's
    // offset X (D inward from its connection point).
    //   SS overlap: childLeft <= parentLeft
    //   FF overlap: childRight <= parentRight
    //
    // …but only while that vertical actually stands ON the source bar. The two
    // bars overlapping is what makes a bare vertical read as a connection at
    // all; when the target sits far enough left that the line would rise out of
    // empty space, it is not a connector, it is a floating tick. Those fall
    // through to buildPath, which exits toward the target and stays attached to
    // both ends.
    const overlapD = Math.min(chamferD, Math.abs(toY - fromY) * 0.3);
    const overlapVertX = toX + overlapD * ((type === "SS") ? 1 : -1);
    const isOverlap =
        ((type === "SS" && childLeft <= parentLeft) ||
         (type === "FF" && childRight <= parentRight)) &&
        overlapVertX >= parentLeft - EPS && overlapVertX <= parentRight + EPS;

    if (isOverlap && Math.abs(fromY - toY) >= 2) {
        const vertDir = toY > fromY ? 1 : -1;
        const startY = fromY + barEdge * vertDir;
        const endY = toY - barEdge * vertDir;
        return {
            d: `M ${overlapVertX} ${startY} L ${overlapVertX} ${endY}`,
            turnX: overlapVertX,
            turnY: (startY + endY) / 2,
            isTight: true,
            isSameRow: false,
        };
    }

    return buildPath(fromX, fromY, toX, toY, type,
                     childLeft, childRight, chamferD, barEdge);
}

/**
 * @param {number} fromX source connection X
 * @param {number} fromY source connection Y (bar center)
 * @param {number} toX target connection X
 * @param {number} toY target connection Y (bar center)
 * @param {string} type link type: FS, SS, FF, SF
 * @param {number} targetLeft target bar left edge X
 * @param {number} targetRight target bar right edge X
 * @param {number} chamferD chamfer diagonal distance
 * @param {number} barEdge half bar height (center to edge)
 */
function buildPath(fromX, fromY, toX, toY, type, targetLeft, targetRight, chamferD, barEdge) {
    // Same row: straight horizontal line
    if (Math.abs(fromY - toY) < 2) {
        return {
            d: `M ${fromX} ${fromY} L ${toX} ${toY}`,
            turnX: (fromX + toX) / 2,
            turnY: fromY,
            isTight: false,
            isSameRow: true,
        };
    }

    const vertDist = Math.abs(toY - fromY);
    const vertDir = toY > fromY ? 1 : -1; // 1=down, -1=up

    // THE CORNER IS A CONSTANT. The 45° leg's horizontal run and the arrowhead's
    // inset from the target's edge are the SAME distance D, so every connector in
    // the chart turns identically — it must not vary with how far apart the two
    // rows happen to be.
    const D = Math.min(chamferD, vertDist * 0.3);

    // Preferred exit side for the link type: FS/FF leave the source's right
    // edge, SS/SF its left.
    const preferredExit = (type === "FS" || type === "FF") ? 1 : -1;

    // Horizontal target X per link type
    let hTargetX;
    switch (type) {
        case "SS": hTargetX = targetLeft; break;
        case "FF": hTargetX = targetRight; break;
        case "SF": hTargetX = targetRight; break;
        case "FS":
        default: hTargetX = targetLeft; break;
    }

    // Arrow endpoint: bar top/bottom edge (not center)
    const endY = toY - barEdge * vertDir;

    // Entry sign: +1 for target-left (FS/SS), -1 for target-right (FF/SF).
    // Ensures the arrowhead lands *inward* from the target bar edge, symmetric
    // for both start-side and end-side connections.
    const entrySign = (type === "FS" || type === "SS") ? 1 : -1;

    // --------------------------------------------------------------
    // Exit toward the target.
    //
    // The preferred side is only a preference. When the target's connection edge
    // lies on the OTHER side of the source's — which is the NORMAL case for SS
    // and SF, whose exit side is the left one while the successor sits to the
    // right — exiting on the preferred side would force the path to double back,
    // and INVARIANT 2 forbids that. The whole connector then collapsed into the
    // "no forward room" fallback below: a bare vertical line standing wherever
    // the target is, touching neither bar. (Measured over a 720-case sweep:
    // EVERY SS link and 86% of SF links came out that way, 85% of them not even
    // starting on the source's bar.)
    //
    // Exiting toward the target keeps both invariants — X still only ever
    // advances, the corner is still D — and the connector still leaves from the
    // edge its link type says it should. The leg may cross back over the source's
    // own bar; the arrow layer sits UNDER the bars, so it is hidden there and
    // simply emerges on the far side.
    // --------------------------------------------------------------
    const wantVertX = hTargetX + D * entrySign;
    const exitSign = Math.abs(wantVertX - fromX) <= EPS
        ? preferredExit
        : (wantVertX > fromX ? 1 : -1);

    // --------------------------------------------------------------
    // Keeping the corner constant when the source is in the way.
    //
    // ``room`` is the gap between the source's exit point and the target's
    // connection edge, measured along the exit direction. It goes NEGATIVE when
    // the source's bar reaches past that edge — which happens on every flush
    // chain as soon as the min-width clamp widens a short predecessor, and on a
    // summary bar that inherits such a child's widened edge.
    //
    // Rather than squeeze the chamfer away (that is what turned the exit into a
    // bare vertical), absorb the shortfall by sliding the vertical line FURTHER
    // INTO the target. The leg then keeps its full length D and the corner looks
    // the same as everywhere else; only the inset grows.
    //
    // The inset may not grow past MAX_INSET, nor past half the target bar — the
    // arrowhead has to stay inside the bar it points at. When that bound binds
    // there genuinely is not enough room, and only then does the leg shrink,
    // proportionally, keeping the 45° until it runs out entirely.
    // --------------------------------------------------------------
    const room = (hTargetX - fromX) * exitSign;
    const maxInset = Math.max(0, Math.min(
        (targetRight - targetLeft) / 2,
        MAX_INSET,
    ));
    const inset = Math.min(Math.max(D, D - room), maxInset);
    const vertX = hTargetX + inset * entrySign;

    // NO BACKFOLD: along the exit direction the path's X only ever advances,
    // fromX → cx → vertX. ``reach`` is how far the vertical line is ahead of the
    // source; the leg is clamped to it so it can never overshoot.
    const reach = (vertX - fromX) * exitSign;

    if (reach <= EPS) {
        // The target's connection point is at or behind the source's and the
        // bars overlap: no forward room for a chamfer at all. Draw the same pure
        // vertical the overlap case uses rather than folding the line backwards.
        return {
            d: `M ${vertX} ${fromY + barEdge * vertDir} L ${vertX} ${endY}`,
            turnX: vertX,
            turnY: (fromY + barEdge * vertDir + endY) / 2,
            isTight: true,
            isSameRow: false,
        };
    }

    const legLen = Math.min(D, reach);
    const cx = fromX + legLen * exitSign;
    const cy = fromY + legLen * vertDir; // 45°: equal run and rise

    if (reach <= D + EPS) {
        // Tight: the clamped chamfer lands exactly on the vertical line.
        return {
            d: `M ${fromX} ${fromY} L ${cx} ${cy} L ${cx} ${endY}`,
            turnX: cx,
            turnY: cy,
            isTight: true,
            isSameRow: false,
        };
    }

    // Non-tight: full chamfer → forward horizontal to vertX → vertical
    return {
        d: `M ${fromX} ${fromY} L ${cx} ${cy} L ${vertX} ${cy} L ${vertX} ${endY}`,
        turnX: vertX,
        turnY: cy,
        isTight: false,
        isSameRow: false,
    };
}
