/** @odoo-module **/

import { Component } from "@odoo/owl";
import { humanizeHours } from "./gantt_utils";
import { computeConnectorPath } from "./gantt_arrow_path";

/**
 * OWL component that renders predecessor arrows as SVG paths.
 *
 * The connector geometry itself lives in ./gantt_arrow_path — pure, import-free
 * and swept by tests/geometry/arrow_path_sweep.mjs. This component only decides
 * WHICH links to draw, where the bars are, and how the lag label is placed.
 *
 * Position calculation uses the renderer's barGeom()/dateToPx() callbacks so
 * arrow endpoints always match the bars across all scale levels.
 */
export class GanttArrows extends Component {
    static template = "dobtor_project.GanttArrows";

    static props = {
        predecessors: { type: Array, optional: true },
        milestoneLinks: { type: Array, optional: true },
        records: { type: Array, optional: true },
        flattenedRows: { type: Array, optional: true },
        visibleRowIds: { type: Set, optional: true },  // For virtual scrolling
        dateToPx: Function,
        // Authoritative bar-edge geometry: (record) => {left, right} | null.
        // When provided, task arrow endpoints use the bar's *visual* edges
        // (clamp + fallback + live drag already baked in) instead of raw
        // dateToPx, so they stay glued to the bar through resize/drag.
        barGeom: { type: Function, optional: true },
        rowHeight: { type: Number, optional: true },
        barTopOffset: { type: Number, optional: true },
        barHeight: { type: Number, optional: true },
        selectedRowId: { optional: true },
        criticalField: { type: String, optional: true },
        hpd: { type: Number, optional: true },
        dpw: { type: Number, optional: true },
        // Drag-time live update: { recordId, deltaX } — shifts dragged bar's arrow endpoints
        dragState: { type: Object, optional: true },
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
        const lookups = this._buildLookups();
        const paths = [];
        paths.push(...this._buildPredecessorPaths(lookups));
        paths.push(...this._buildMilestonePaths(lookups));
        return paths;
    }

    /**
     * Check if an arrow should be rendered based on virtual scroll visibility.
     * An arrow is visible if either parent or child is in the visible set.
     */
    _isArrowVisible(pred) {
        const { visibleRowIds } = this.props;
        
        // If no virtual scroll (visibleRowIds not provided), render all arrows
        if (!visibleRowIds || visibleRowIds.size === 0) {
            return true;
        }
        
        // Check if parent or child is visible
        const parentVisible = visibleRowIds.has(pred.parent_task_id);
        const childVisible = visibleRowIds.has(pred.task_id);
        
        // Render arrow if either task is visible
        return parentVisible || childVisible;
    }

    /**
     * Build predecessor arrows (existing logic).
     */
    _buildPredecessorPaths(lookups) {
        const { predecessors, flattenedRows, dateToPx, rowHeight } = this.props;
        if (!predecessors || !predecessors.length || !flattenedRows || !dateToPx) {
            return [];
        }

        const chamferD = this.props.barHeight / 4;
        const barEdge = this.props.barHeight / 2;

        const { recordMap, rowIndexMap } = lookups;

        const paths = [];

        for (const pred of predecessors) {
            // Virtual scroll optimization: skip arrows for tasks not in viewport
            if (!this._isArrowVisible(pred)) continue;
            
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

            // Bar-edge coordinates. Prefer the renderer's authoritative
            // geometry (clamp + no-end fallback + live drag offset already
            // applied) so endpoints stay glued to the bar's *visual* edge.
            // Fall back to raw dateToPx (+ manual drag offset) only if the host
            // didn't supply barGeom. NOTE: in this module the renderer ALWAYS
            // passes barGeom, so this fallback is not exercised here — it is kept
            // as a safety net for reusing GanttArrows without a host geometry fn.
            const { barGeom } = this.props;
            let parentLeft, parentRight, childLeft, childRight;
            const pg = barGeom && barGeom(parentRecord);
            const cg = barGeom && barGeom(childRecord);
            if (pg && cg) {
                parentLeft = pg.left; parentRight = pg.right;
                childLeft = cg.left; childRight = cg.right;
            } else {
                parentLeft = dateToPx(pStart);
                parentRight = pEnd ? dateToPx(pEnd) : parentLeft + 20;
                childLeft = dateToPx(cStart);
                childRight = cEnd ? dateToPx(cEnd) : childLeft + 20;
                // Live drag/resize offset: shift the moved record's endpoints.
                const drag = this.props.dragState;
                if (drag && drag.ids) {
                    if (drag.ids[pred.parent_task_id]) {
                        parentLeft += drag.deltaLeft;
                        parentRight += drag.deltaRight;
                    }
                    if (drag.ids[pred.task_id]) {
                        childLeft += drag.deltaLeft;
                        childRight += drag.deltaRight;
                    }
                }
            }

            const type = (pred.type || "FS").toUpperCase();
            const fromY = parentIdx * rowHeight + rowHeight / 2;
            const toY = childIdx * rowHeight + rowHeight / 2;

            const result = computeConnectorPath({
                type,
                parentLeft, parentRight, childLeft, childRight,
                fromY, toY, chamferD, barEdge,
            });

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
    _buildMilestonePaths(lookups) {
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

        const { recordMap, rowIndexMap } = lookups;

        const paths = [];

        for (const link of milestoneLinks) {
            const taskRecord = recordMap.get(link.task_id);
            const msRecord = recordMap.get(link.milestone_id); // negative ID

            if (!taskRecord || !msRecord) continue;
            if (!taskRecord._dateStart || !msRecord._dateStart) continue;

            const taskIdx = rowIndexMap.get(link.task_id);
            const msIdx = rowIndexMap.get(link.milestone_id);
            if (taskIdx === undefined || msIdx === undefined) continue;

            // Task: from right edge (FS style). Prefer the authoritative bar
            // geometry so the connector starts at the bar's *visual* right edge
            // (clamp + drag baked in); fall back to dateToPx otherwise.
            const { barGeom } = this.props;
            const tg = barGeom && barGeom(taskRecord);
            let fromX;
            if (tg) {
                fromX = tg.right;
            } else {
                fromX = taskRecord._dateEnd
                    ? dateToPx(taskRecord._dateEnd)
                    : dateToPx(taskRecord._dateStart) + 20;
            }
            const fromY = taskIdx * rowHeight + rowHeight / 2;

            // Milestone: diamond visual center = dateToPx(start) + half box
            let msCenterX = dateToPx(msRecord._dateStart) + halfBox;

            // Live drag/resize offset for the gesture. The task side is already
            // baked into barGeom (tg); only apply the manual offset on the
            // dateToPx fallback. The milestone center always needs it.
            const drag = this.props.dragState;
            if (drag && drag.ids) {
                if (!tg && drag.ids[link.task_id]) fromX += drag.deltaRight;
                if (drag.ids[link.milestone_id]) msCenterX += drag.deltaLeft;
            }
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
}
