/** @odoo-module **/

import { Component } from "@odoo/owl";
import { humanizeHours } from "./gantt_utils";

/**
 * OWL component that renders predecessor arrows as SVG paths.
 *
 * Arrow routing — all arrowheads are vertical (↓ or ↑):
 *
 *   Tight (target within chamfer distance):
 *     M source → 45° chamfer to targetX → vertical ↓/↑
 *
 *   Non-tight (target beyond chamfer distance):
 *     M source → 45° chamfer → horizontal to targetX → vertical ↓/↑
 *
 * Position calculation uses the renderer's dateToPx() callback to ensure
 * arrow endpoints always match bar positions across all scale levels.
 */
export class GanttArrows extends Component {
    static template = "dobtor_project.GanttArrows";

    static props = {
        predecessors: { type: Array, optional: true },
        milestoneLinks: { type: Array, optional: true },
        records: { type: Array, optional: true },
        flattenedRows: { type: Array, optional: true },
        dateToPx: Function,
        rowHeight: { type: Number, optional: true },
        barTopOffset: { type: Number, optional: true },
        barHeight: { type: Number, optional: true },
        selectedRowId: { optional: true },
        criticalField: { type: String, optional: true },
        hpd: { type: Number, optional: true },
        dpw: { type: Number, optional: true },
    };

    static defaultProps = {
        predecessors: [],
        milestoneLinks: [],
        records: [],
        flattenedRows: [],
        rowHeight: 44,
        barTopOffset: 8,
        barHeight: 28,
        selectedRowId: null,
        criticalField: "",
    };

    get arrowPaths() {
        const paths = [];
        paths.push(...this._buildPredecessorPaths());
        paths.push(...this._buildMilestonePaths());
        return paths;
    }

    /**
     * Build predecessor arrows (existing logic).
     */
    _buildPredecessorPaths() {
        const { predecessors, flattenedRows, dateToPx, rowHeight } = this.props;
        if (!predecessors || !predecessors.length || !flattenedRows || !dateToPx) {
            return [];
        }

        const chamferD = this.props.barHeight / 4;
        const barEdge = this.props.barHeight / 2;

        const { recordMap, rowIndexMap } = this._buildLookups();

        const paths = [];

        for (const pred of predecessors) {
            const parentRecord = recordMap.get(pred.parent_task_id);
            const childRecord = recordMap.get(pred.task_id);

            if (!parentRecord || !childRecord) continue;
            // Use summary dates for parent tasks
            const pStart = (parentRecord._hasChildren && parentRecord._summaryDateStart) || parentRecord._dateStart;
            const pEnd = (parentRecord._hasChildren && parentRecord._summaryDateEnd) || parentRecord._dateEnd;
            const cStart = (childRecord._hasChildren && childRecord._summaryDateStart) || childRecord._dateStart;
            const cEnd = (childRecord._hasChildren && childRecord._summaryDateEnd) || childRecord._dateEnd;
            if (!pStart || !cStart) continue;

            const parentIdx = rowIndexMap.get(pred.parent_task_id);
            const childIdx = rowIndexMap.get(pred.task_id);
            if (parentIdx === undefined || childIdx === undefined) continue;

            // Use renderer's dateToPx for scale-aware coordinate mapping
            const parentLeft = dateToPx(pStart);
            const parentRight = pEnd ? dateToPx(pEnd) : parentLeft + 20;
            const childLeft = dateToPx(cStart);
            const childRight = cEnd ? dateToPx(cEnd) : childLeft + 20;

            const parentCenterY = parentIdx * rowHeight + rowHeight / 2;
            const childCenterY = childIdx * rowHeight + rowHeight / 2;

            const type = (pred.type || "FS").toUpperCase();
            let fromX, fromY, toX, toY;

            switch (type) {
                case "SS":
                    fromX = parentLeft; fromY = parentCenterY;
                    toX = childLeft; toY = childCenterY;
                    break;
                case "FF":
                    fromX = parentRight; fromY = parentCenterY;
                    toX = childRight; toY = childCenterY;
                    break;
                case "SF":
                    fromX = parentLeft; fromY = parentCenterY;
                    toX = childRight; toY = childCenterY;
                    break;
                case "FS":
                default:
                    fromX = parentRight; fromY = parentCenterY;
                    toX = childLeft; toY = childCenterY;
                    break;
            }

            const result = this._buildPath(
                fromX, fromY, toX, toY, type,
                childLeft, childRight, chamferD, barEdge
            );

            let pathClass = "o_gantt_arrow";
            let markerClass = "";
            const criticalField = this.props.criticalField;

            if (criticalField && parentRecord[criticalField] && childRecord[criticalField]) {
                pathClass += " o_gantt_arrow_critical";
                markerClass = "critical";
            } else if (
                this.props.selectedRowId &&
                (parentRecord.id === this.props.selectedRowId ||
                    childRecord.id === this.props.selectedRowId)
            ) {
                pathClass += " o_gantt_arrow_highlight";
                markerClass = "highlight";
            }

            let lagLabel = "";
            if (pred.lag_hours && Math.abs(pred.lag_hours) > 0.001) {
                const sign = pred.lag_hours > 0 ? "+" : "";
                lagLabel = `${sign}${humanizeHours(pred.lag_hours, this.props.hpd || 24, this.props.dpw || 7)}`;
            }

            // Lag label position at the turn point (horizontal→vertical
            // or diagonal→vertical junction).
            //
            // Non-tight (has horizontal segment):
            //   Default: RIGHT of vertical line, left-edge aligned (anchor=start)
            //   Collision: flip to LEFT of vertical, right-edge aligned (anchor=end)
            // Tight (diagonal → vertical):
            //   Always RIGHT of vertical, left-edge aligned (anchor=start)
            const LABEL_GAP = 3;
            const FONT_SIZE = 10;
            const vertDir = toY > fromY ? 1 : -1;
            let lagX, lagY, lagAnchor;
            if (result.isSameRow) {
                lagX = result.turnX;
                lagY = result.turnY - LABEL_GAP;
                lagAnchor = "middle";
            } else if (result.isTight) {
                // Diagonal → vertical: right of vertical line
                lagAnchor = "start";
                lagX = result.turnX + LABEL_GAP;
                lagY = vertDir > 0
                    ? result.turnY + FONT_SIZE  // down: not higher than turn
                    : result.turnY;             // up: not lower than turn
            } else {
                // Horizontal → vertical: check if label collides with target bar
                const availSpace = vertDir > 0
                    ? (toY - barEdge) - result.turnY
                    : result.turnY - (toY + barEdge);
                const collides = availSpace < FONT_SIZE + LABEL_GAP * 2;

                if (collides) {
                    lagAnchor = "end";
                    lagX = result.turnX - LABEL_GAP;
                } else {
                    lagAnchor = "start";
                    lagX = result.turnX + LABEL_GAP;
                }
                lagY = vertDir > 0
                    ? result.turnY + FONT_SIZE + LABEL_GAP  // below horizontal
                    : result.turnY - LABEL_GAP;              // above horizontal
            }

            paths.push({
                id: `arrow_${pred.parent_task_id}_${pred.task_id}`,
                d: result.d,
                pathClass,
                markerClass,
                lagLabel,
                lagX,
                lagY,
                lagAnchor,
            });
        }

        return paths;
    }

    /**
     * Build milestone arrows (task → milestone).
     * Same visual style and chamfer D as task-to-task arrows.
     * All arrows converge on diamond visual center; arrowhead at vertex.
     */
    _buildMilestonePaths() {
        const { milestoneLinks, flattenedRows, dateToPx, rowHeight } = this.props;
        if (!milestoneLinks || !milestoneLinks.length || !flattenedRows || !dateToPx) {
            return [];
        }

        // Diamond: 18px CSS box rotated 45°
        const DIAMOND_SIZE = 18;
        const diamondHalf = Math.ceil(DIAMOND_SIZE * Math.SQRT2 / 2); // ≈13 visual half-diagonal
        const halfBox = DIAMOND_SIZE / 2; // 9px CSS box center offset

        // Same chamfer distance as task-to-task arrows
        const chamferD = this.props.barHeight / 4;

        const { recordMap, rowIndexMap } = this._buildLookups();

        const paths = [];

        for (const link of milestoneLinks) {
            const taskRecord = recordMap.get(link.task_id);
            const msRecord = recordMap.get(link.milestone_id); // negative ID

            if (!taskRecord || !msRecord) continue;
            if (!taskRecord._dateStart || !msRecord._dateStart) continue;

            const taskIdx = rowIndexMap.get(link.task_id);
            const msIdx = rowIndexMap.get(link.milestone_id);
            if (taskIdx === undefined || msIdx === undefined) continue;

            // Task: from right edge (FS style) — use dateToPx
            const fromX = taskRecord._dateEnd
                ? dateToPx(taskRecord._dateEnd)
                : dateToPx(taskRecord._dateStart) + 20;
            const fromY = taskIdx * rowHeight + rowHeight / 2;

            // Milestone: diamond visual center = dateToPx(start) + half box
            const msCenterX = dateToPx(msRecord._dateStart) + halfBox;
            const toY = msIdx * rowHeight + rowHeight / 2;

            const vertDir = toY > fromY ? 1 : -1;
            const vertDist = Math.abs(toY - fromY);
            const D = Math.min(chamferD, vertDist * 0.3);

            // Arrowhead target: diamond top/bottom vertex
            const endY = toY - diamondHalf * vertDir;

            // Gap from task end to diamond visual center
            const gap = Math.abs(msCenterX - fromX);

            // 45° chamfer direction: toward diamond
            const hDir = msCenterX >= fromX ? 1 : -1;
            const cx = fromX + D * hDir;
            const cy = fromY + D * vertDir;

            let path;
            if (Math.abs(fromY - toY) < 2) {
                // Same row: straight horizontal
                path = `M ${fromX} ${fromY} L ${msCenterX} ${toY}`;
            } else if (gap <= D) {
                // Tight: 45° chamfer to msCenterX → vertical to vertex
                const chamferY = fromY + gap * vertDir;
                path = `M ${fromX} ${fromY} L ${msCenterX} ${chamferY} L ${msCenterX} ${endY}`;
            } else {
                // Non-tight: full 45° chamfer → horizontal to msCenterX → vertical
                path = `M ${fromX} ${fromY} L ${cx} ${cy} L ${msCenterX} ${cy} L ${msCenterX} ${endY}`;
            }

            paths.push({
                id: `ms_arrow_${link.task_id}_${link.milestone_id}`,
                d: path,
                pathClass: "o_gantt_arrow",
                markerClass: "",
                lagLabel: "",
                lagX: 0,
                lagY: 0,
            });
        }

        return paths;
    }

    /**
     * Build shared lookup maps from flattenedRows.
     */
    _buildLookups() {
        const { flattenedRows } = this.props;
        const recordMap = new Map();
        const rowIndexMap = new Map();
        let idx = 0;
        for (const row of flattenedRows) {
            if (!row._isGroup && row.id != null) {
                recordMap.set(row.id, row);
                rowIndexMap.set(row.id, idx);
            }
            idx++;
        }
        return { recordMap, rowIndexMap };
    }

    /**
     * Build arrow path with vertical arrowhead.
     *
     * Arrowhead always lands D pixels *inward* from the target bar edge:
     *   - Target left  (FS/SS): vertX = targetLeft  + D
     *   - Target right (FF/SF): vertX = targetRight - D
     * This ensures symmetric offset whether connecting to start or end side.
     *
     * Tight (chamfer endpoint ≈ vertX):
     *   M source → 45° chamfer (full D) → vertical ↓/↑ at cx
     *
     * Non-tight:
     *   M source → 45° chamfer (full D) → horizontal to vertX → vertical ↓/↑
     *
     * @param {number} fromX - source connection X
     * @param {number} fromY - source connection Y (bar center)
     * @param {number} toX - target connection X
     * @param {number} toY - target connection Y (bar center)
     * @param {string} type - link type: FS, SS, FF, SF
     * @param {number} targetLeft - target bar left edge X
     * @param {number} targetRight - target bar right edge X
     * @param {number} chamferD - chamfer diagonal distance
     * @param {number} barEdge - actual half bar height (center to edge)
     */
    _buildPath(fromX, fromY, toX, toY, type, targetLeft, targetRight, chamferD, barEdge) {
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
        const D = Math.min(chamferD, vertDist * 0.3); // clamp for very close rows
        const vertDir = toY > fromY ? 1 : -1; // 1=down, -1=up

        // Exit direction: FS/FF exit right, SS/SF exit left
        const exitRight = (type === "FS" || type === "FF");
        const exitSign = exitRight ? 1 : -1;

        // Determine horizontal target X based on link type
        let hTargetX;
        switch ((type || "FS").toUpperCase()) {
            case "SS":
                hTargetX = targetLeft;
                break;
            case "FF":
                hTargetX = targetRight;
                break;
            case "SF":
                hTargetX = targetRight;
                break;
            case "FS":
            default:
                hTargetX = targetLeft;
                break;
        }

        // Arrow endpoint: bar top/bottom edge (not center)
        const endY = toY - barEdge * vertDir;

        // Always draw full 45° chamfer
        const cx = fromX + D * exitSign;
        const cy = fromY + D * vertDir;

        // Entry sign: +1 for target-left (FS/SS), -1 for target-right (FF/SF)
        // Ensures arrowhead lands D pixels *inward* from the target bar edge,
        // symmetric for both start-side and end-side connections.
        const entrySign = (type === "FS" || type === "SS") ? 1 : -1;

        // Vertical line X: D pixels inward from target connection edge
        const vertX = hTargetX + D * entrySign;

        // If chamfer endpoint and vertical line converge, draw tight 2-segment path
        const hDist = Math.abs(cx - vertX);
        if (hDist < 1) {
            // Tight: full chamfer → straight vertical at cx
            return {
                d: `M ${fromX} ${fromY} L ${cx} ${cy} L ${cx} ${endY}`,
                turnX: cx,
                turnY: cy,
                isTight: true,
                isSameRow: false,
            };
        }

        // Non-tight: full chamfer → horizontal to vertX → vertical
        return {
            d: `M ${fromX} ${fromY} L ${cx} ${cy} L ${vertX} ${cy} L ${vertX} ${endY}`,
            turnX: vertX,
            turnY: cy,
            isTight: false,
            isSameRow: false,
        };
    }
}
