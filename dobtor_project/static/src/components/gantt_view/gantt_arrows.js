/** @odoo-module **/

import { Component } from "@odoo/owl";

/**
 * OWL component that renders predecessor arrows as SVG paths.
 *
 * Props:
 *   predecessors: Array of { task_id, parent_task_id, type }
 *   records: Array of all records
 *   flattenedRows: Array of visible rows (groups + records)
 *   timeStart: Luxon DateTime for timeline start
 *   cellWidth: number (px per day)
 *   rowHeight: number (px per row, default 44)
 *   selectedRowId: number | null
 *   criticalField: string (field name for critical path boolean)
 */
export class GanttArrows extends Component {
    static template = "dobtor_project.GanttArrows";

    static props = {
        predecessors: { type: Array, optional: true },
        records: { type: Array, optional: true },
        flattenedRows: { type: Array, optional: true },
        timeStart: { optional: true },
        cellWidth: Number,
        rowHeight: { type: Number, optional: true },
        selectedRowId: { optional: true },
        criticalField: { type: String, optional: true },
    };

    static defaultProps = {
        predecessors: [],
        records: [],
        flattenedRows: [],
        rowHeight: 44,
        selectedRowId: null,
        criticalField: "",
    };

    get arrowPaths() {
        const { predecessors, flattenedRows, timeStart, cellWidth, rowHeight } = this.props;
        if (!predecessors || !predecessors.length || !flattenedRows || !timeStart) {
            return [];
        }

        // Build record lookup: id → record
        const recordMap = new Map();
        for (const row of flattenedRows) {
            if (!row._isGroup && row.id) {
                recordMap.set(row.id, row);
            }
        }

        // Build row index map: recordId → visual row index
        const rowIndexMap = new Map();
        let idx = 0;
        for (const row of flattenedRows) {
            if (!row._isGroup) {
                rowIndexMap.set(row.id, idx);
            }
            idx++;
        }

        const paths = [];

        for (const pred of predecessors) {
            const parentRecord = recordMap.get(pred.parent_task_id);
            const childRecord = recordMap.get(pred.task_id);

            if (!parentRecord || !childRecord) continue;
            if (!parentRecord._dateStart || !childRecord._dateStart) continue;

            const parentIdx = rowIndexMap.get(pred.parent_task_id);
            const childIdx = rowIndexMap.get(pred.task_id);
            if (parentIdx === undefined || childIdx === undefined) continue;

            // Calculate bar positions
            const parentStartDays = parentRecord._dateStart.diff(timeStart, "days").days;
            const parentEndDays = parentRecord._dateEnd
                ? parentRecord._dateEnd.diff(timeStart, "days").days
                : parentStartDays + 1;
            const childStartDays = childRecord._dateStart.diff(timeStart, "days").days;
            const childEndDays = childRecord._dateEnd
                ? childRecord._dateEnd.diff(timeStart, "days").days
                : childStartDays + 1;

            const parentLeft = parentStartDays * cellWidth;
            const parentRight = parentEndDays * cellWidth;
            const childLeft = childStartDays * cellWidth;
            const childRight = childEndDays * cellWidth;

            const parentCenterY = parentIdx * rowHeight + rowHeight / 2;
            const childCenterY = childIdx * rowHeight + rowHeight / 2;

            // Determine connection points based on type (default FS)
            const type = (pred.type || "FS").toUpperCase();
            let fromX, fromY, toX, toY;

            switch (type) {
                case "SS": // Start-to-Start
                    fromX = parentLeft;
                    fromY = parentCenterY;
                    toX = childLeft;
                    toY = childCenterY;
                    break;
                case "FF": // Finish-to-Finish
                    fromX = parentRight;
                    fromY = parentCenterY;
                    toX = childRight;
                    toY = childCenterY;
                    break;
                case "SF": // Start-to-Finish
                    fromX = parentLeft;
                    fromY = parentCenterY;
                    toX = childRight;
                    toY = childCenterY;
                    break;
                case "FS": // Finish-to-Start (default)
                default:
                    fromX = parentRight;
                    fromY = parentCenterY;
                    toX = childLeft;
                    toY = childCenterY;
                    break;
            }

            // Generate SVG path
            const path = this._buildPath(fromX, fromY, toX, toY, type);

            // Determine CSS classes
            let pathClass = "o_gantt_arrow";
            let markerClass = "";
            const criticalField = this.props.criticalField;

            if (
                criticalField &&
                parentRecord[criticalField] &&
                childRecord[criticalField]
            ) {
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

            // Compute lag label and position
            let lagLabel = "";
            let lagX = (fromX + toX) / 2;
            let lagY = (fromY + toY) / 2 - 8;

            if (pred.lag_qty && pred.lag_qty !== 0) {
                const sign = pred.lag_qty > 0 ? "+" : "";
                const unit = (pred.lag_type || "day").charAt(0);
                lagLabel = `${sign}${pred.lag_qty}${unit}`;
            }

            paths.push({
                id: `arrow_${pred.parent_task_id}_${pred.task_id}`,
                d: path,
                pathClass,
                markerClass,
                lagLabel,
                lagX,
                lagY,
            });
        }

        return paths;
    }

    /**
     * Build an SVG path string connecting two points.
     * Uses a multi-segment approach: horizontal out → vertical → horizontal in
     * with quadratic bezier corners for smooth routing.
     */
    _buildPath(fromX, fromY, toX, toY, type) {
        const OFFSET = 12; // horizontal clearance before turning
        const RADIUS = 6; // corner rounding

        // For FS/SF, determine which side we exit/enter
        const exitRight = type === "FS" || type === "FF";
        const enterLeft = type === "FS" || type === "SS";

        const exitX = exitRight ? fromX + OFFSET : fromX - OFFSET;
        const enterX = enterLeft ? toX - OFFSET : toX + OFFSET;

        // Simple case: direct horizontal connection is possible
        if (Math.abs(fromY - toY) < 2) {
            return `M ${fromX} ${fromY} L ${toX} ${toY}`;
        }

        // Determine if we need an S-curve (tasks overlap horizontally)
        const goingRight = exitX < enterX;
        const needsSCurve =
            (exitRight && enterLeft && fromX > toX - OFFSET * 2) ||
            (!exitRight && !enterLeft && fromX < toX + OFFSET * 2);

        if (needsSCurve) {
            // S-curve: go out, drop halfway vertically, come back
            const midY = (fromY + toY) / 2;
            return (
                `M ${fromX} ${fromY}` +
                ` L ${exitX} ${fromY}` +
                ` Q ${exitX} ${fromY + _sign(toY - fromY) * RADIUS} ${exitX} ${midY > fromY ? fromY + RADIUS : fromY - RADIUS}` +
                ` L ${exitX} ${midY}` +
                ` L ${enterX} ${midY}` +
                ` L ${enterX} ${midY > toY ? toY + RADIUS : toY - RADIUS}` +
                ` Q ${enterX} ${toY} ${enterX + _sign(toX - enterX) * RADIUS} ${toY}` +
                ` L ${toX} ${toY}`
            );
        }

        // Standard L-shaped path with rounded corners
        const vertDir = toY > fromY ? 1 : -1;

        return (
            `M ${fromX} ${fromY}` +
            ` L ${exitX - RADIUS * (exitRight ? 1 : -1)} ${fromY}` +
            ` Q ${exitX} ${fromY} ${exitX} ${fromY + RADIUS * vertDir}` +
            ` L ${exitX} ${toY - RADIUS * vertDir}` +
            ` Q ${exitX} ${toY} ${exitX + RADIUS * (enterX > exitX ? 1 : -1)} ${toY}` +
            ` L ${toX} ${toY}`
        );
    }
}

function _sign(v) {
    return v >= 0 ? 1 : -1;
}
