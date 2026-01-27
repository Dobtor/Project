/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount } from "@odoo/owl";
import { luxon } from "@web/core/l10n/dates";

const { DateTime } = luxon;

export class GanttRenderer extends Component {
    static template = "dobtor_project.GanttRenderer";

    static props = {
        model: Object,
        archInfo: Object,
        onRecordClick: Function,
        onRecordUpdate: Function,
        onGroupToggle: Function,
        scale: String,
    };

    setup() {
        this.ganttContainer = useRef("ganttContainer");
        this.timelineRef = useRef("timeline");
        this.arrowContainer = useRef("arrowContainer");

        this.state = useState({
            gutterWidth: 320,
            timelineWidth: 0,
            hoveredRecordId: null,
            selectedRecordId: null,
            isDragging: false,
            dragMode: null, // 'move' or 'resize'
        });

        // Drag state (not reactive for performance)
        this._dragState = null;

        // Memoization cache for expensive computations
        // Cache invalidation is handled directly in the getters via hash comparison
        this._cache = {
            flattenedRows: null,
            flattenedRowsHash: null,
            timelineHeader: null,
            timelineHeaderHash: null,
            rowPositions: null,
            recordToRowMap: null,
            recordToRowMapHash: null,
        };

        // Apple HIG inspired scale configuration with better spacing
        this.scaleConfig = {
            "1h": { pixels: 48, unit: "hour", factor: 1 },
            "2h": { pixels: 24, unit: "hour", factor: 2 },
            "4h": { pixels: 12, unit: "hour", factor: 4 },
            "8h": { pixels: 6, unit: "hour", factor: 8 },
            "day": { pixels: 32, unit: "day", factor: 1 },
            "week": { pixels: 120, unit: "week", factor: 1 },
            "month": { pixels: 150, unit: "month", factor: 1 },
            "quarter": { pixels: 200, unit: "quarter", factor: 1 },
        };

        // Color variants mapping (Apple system colors)
        this.colorVariants = {
            blue: "var(--gantt-accent-blue)",
            green: "var(--gantt-accent-green)",
            orange: "var(--gantt-accent-orange)",
            red: "var(--gantt-accent-red)",
            purple: "var(--gantt-accent-purple)",
            indigo: "var(--gantt-accent-indigo)",
            teal: "var(--gantt-accent-teal)",
            pink: "var(--gantt-accent-pink)",
            yellow: "var(--gantt-accent-yellow)",
        };

        // Row height constant (matches CSS)
        this.ROW_HEIGHT = 44;

        onMounted(() => {
            this._calculateTimelineWidth();
            this._setupResizeObserver();
            this._updateArrows();
        });

        onWillUnmount(() => {
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
            }
            if (this._onWindowResize) {
                window.removeEventListener("resize", this._onWindowResize);
            }
            this._cleanupDragListeners();
            this._cleanupGutterListeners();
            this._clearCache();
        });
    }

    /**
     * Clear all cached data to prevent memory leaks
     */
    _clearCache() {
        this._cache.flattenedRows = null;
        this._cache.flattenedRowsHash = null;
        this._cache.timelineHeader = null;
        this._cache.timelineHeaderHash = null;
        this._cache.rowPositions = null;
        this._cache.recordToRowMap = null;
        this._cache.recordToRowMapHash = null;
    }

    _setupResizeObserver() {
        // Check browser support for ResizeObserver
        if (typeof ResizeObserver === "undefined") {
            console.warn("ResizeObserver not supported in this browser, using fallback");
            // Fallback: recalculate on window resize
            this._onWindowResize = () => {
                this._calculateTimelineWidth();
                this._updateArrows();
            };
            window.addEventListener("resize", this._onWindowResize);
            return;
        }

        if (this.ganttContainer.el) {
            this.resizeObserver = new ResizeObserver(() => {
                this._calculateTimelineWidth();
                this._updateArrows();
            });
            this.resizeObserver.observe(this.ganttContainer.el);
        }
    }

    _calculateTimelineWidth() {
        const { timeStart, timeStop } = this.props.model.data;
        if (!timeStart || !timeStop) return;

        const scale = this.props.scale;
        const config = this.scaleConfig[scale] || this.scaleConfig.day;

        let units = 0;
        switch (config.unit) {
            case "hour":
                units = timeStop.diff(timeStart, "hours").hours / config.factor;
                break;
            case "day":
                units = timeStop.diff(timeStart, "days").days;
                break;
            case "week":
                units = timeStop.diff(timeStart, "weeks").weeks;
                break;
            case "month":
                units = timeStop.diff(timeStart, "months").months;
                break;
            case "quarter":
                units = timeStop.diff(timeStart, "quarters").quarters;
                break;
        }

        this.state.timelineWidth = Math.ceil(Math.max(units, 1)) * config.pixels;
    }

    get model() {
        return this.props.model;
    }

    get records() {
        return this.model.data.records || [];
    }

    get groups() {
        return this.model.data.groups || [];
    }

    get predecessors() {
        return this.model.data.predecessors || [];
    }

    /**
     * Get current scale pixel width - cached for template performance
     */
    get currentScalePixels() {
        const config = this.scaleConfig[this.props.scale];
        return config ? config.pixels : 32;
    }

    /**
     * Compute a simple hash for cache invalidation
     */
    _computeDataHash() {
        const records = this.model.data.records || [];
        const groups = this.model.data.groups || [];
        return `${records.length}-${groups.length}-${this.props.scale}`;
    }

    get flattenedRows() {
        // Return cached result if available
        const currentHash = this._computeDataHash();
        if (this._cache.flattenedRows && this._cache.flattenedRowsHash === currentHash) {
            return this._cache.flattenedRows;
        }

        const rows = [];
        for (const group of this.groups) {
            rows.push({
                ...group,
                _isGroup: true,
                _rowIndex: rows.length,
            });
            if (!group.fold) {
                for (const record of group.records) {
                    rows.push({
                        ...record,
                        _isGroup: false,
                        _rowIndex: rows.length,
                    });
                }
            }
        }

        // Cache the result
        this._cache.flattenedRows = rows;
        this._cache.flattenedRowsHash = currentHash;
        return rows;
    }

    get timelineHeader() {
        const { timeStart, timeStop } = this.model.data;
        if (!timeStart || !timeStop) return { months: [], days: [] };

        // Compute cache hash including time range and scale
        const headerHash = `${timeStart.toISO()}-${timeStop.toISO()}-${this.props.scale}`;

        // Return cached result if valid
        if (this._cache.timelineHeader && this._cache.timelineHeaderHash === headerHash) {
            return this._cache.timelineHeader;
        }

        const scale = this.props.scale;
        const config = this.scaleConfig[scale] || this.scaleConfig.day;

        const months = [];
        const days = [];
        const today = DateTime.now().startOf("day");

        let current = timeStart.startOf("month");
        while (current <= timeStop) {
            const daysInMonth = current.daysInMonth;
            const monthEnd = current.endOf("month");
            const effectiveDays = Math.min(
                daysInMonth,
                Math.ceil(timeStop.diff(current, "days").days)
            );

            months.push({
                year: current.year,
                month: current.monthLong,
                days: effectiveDays,
                width: effectiveDays * config.pixels,
            });

            // Use startOf('day') for consistent date comparisons
            const timeStartDay = timeStart.startOf("day");
            const timeStopDay = timeStop.startOf("day");

            for (let d = 1; d <= daysInMonth; d++) {
                const day = current.set({ day: d }).startOf("day");

                // Check if day is beyond the time range
                if (day > timeStopDay) break;

                // Only include days within the time range
                if (day >= timeStartDay) {
                    const isToday = day.hasSame(today, "day");
                    days.push({
                        day: d,
                        weekday: day.weekdayShort,
                        isWeekend: day.weekday >= 6,
                        isToday,
                        date: day,
                    });
                }
            }

            current = current.plus({ months: 1 });
        }

        // Cache the result
        const result = { months, days };
        this._cache.timelineHeader = result;
        this._cache.timelineHeaderHash = headerHash;

        return result;
    }

    // =========================================================================
    // Bar Positioning and Styling
    // =========================================================================

    _getPixelsPerUnit() {
        const scale = this.props.scale;
        const config = this.scaleConfig[scale] || this.scaleConfig.day;
        return config.pixels;
    }

    _dateToPixels(date) {
        const { timeStart } = this.model.data;
        if (!timeStart || !date) return 0;

        const scale = this.props.scale;
        const config = this.scaleConfig[scale] || this.scaleConfig.day;

        let offset = 0;
        switch (config.unit) {
            case "hour":
                offset = date.diff(timeStart, "hours").hours / config.factor;
                break;
            case "day":
                offset = date.diff(timeStart, "days").days;
                break;
            case "week":
                offset = date.diff(timeStart, "weeks").weeks;
                break;
            case "month":
                offset = date.diff(timeStart, "months").months;
                break;
            case "quarter":
                offset = date.diff(timeStart, "quarters").quarters;
                break;
        }

        return offset * config.pixels;
    }

    _pixelsToDate(pixels) {
        const { timeStart } = this.model.data;
        if (!timeStart) return null;

        const scale = this.props.scale;
        const config = this.scaleConfig[scale] || this.scaleConfig.day;

        const units = pixels / config.pixels;

        switch (config.unit) {
            case "hour":
                return timeStart.plus({ hours: units * config.factor });
            case "day":
                return timeStart.plus({ days: units });
            case "week":
                return timeStart.plus({ weeks: units });
            case "month":
                return timeStart.plus({ months: units });
            case "quarter":
                return timeStart.plus({ quarters: units });
        }

        return timeStart;
    }

    getBarStyle(record) {
        const { timeStart } = this.model.data;
        if (!record._dateStart || !record._dateStop || !timeStart) {
            return { display: "none" };
        }

        const left = Math.max(0, this._dateToPixels(record._dateStart));
        const right = this._dateToPixels(record._dateStop);
        const barWidth = Math.max(this._getPixelsPerUnit(), right - left);

        // Apple HIG color handling - use CSS custom properties when possible
        let backgroundColor = "var(--gantt-accent-blue)";
        const colorField = this.props.archInfo.colorGantt;
        const colorSetField = this.props.archInfo.colorGanttSet;

        if (colorSetField && colorField && record[colorSetField] && record[colorField]) {
            const colorValue = record[colorField];
            // Map common colors to Apple system colors
            if (this.colorVariants[colorValue]) {
                backgroundColor = this.colorVariants[colorValue];
            } else if (colorValue.startsWith("#") || colorValue.startsWith("rgb")) {
                backgroundColor = colorValue;
            }
        }

        // Handle milestone rendering (diamond shape via CSS class)
        if (record._isMilestone) {
            return {
                left: `${left}px`,
            };
        }

        return {
            left: `${left}px`,
            width: `${barWidth}px`,
            backgroundColor,
        };
    }

    getBarClass(record) {
        const classes = ["o_gantt_bar"];

        if (record._isMilestone) {
            classes.push("o_gantt_milestone");
        }

        if (record._isCriticalPath) {
            classes.push("o_gantt_critical_path");
        }

        if (record._isSummary) {
            classes.push("o_gantt_summary");
        }

        if (this.state.selectedRecordId === record.id) {
            classes.push("o_gantt_selected");
        }

        if (this.state.hoveredRecordId === record.id) {
            classes.push("o_gantt_hovered");
        }

        // Color variant class
        const colorField = this.props.archInfo.colorGantt;
        const colorSetField = this.props.archInfo.colorGanttSet;
        if (colorSetField && colorField && record[colorSetField] && record[colorField]) {
            const colorValue = record[colorField];
            if (this.colorVariants[colorValue]) {
                classes.push(`o_gantt_bar_${colorValue}`);
            }
        }

        return classes.join(" ");
    }

    getProgressStyle(record) {
        const progress = record.progress || 0;
        if (progress <= 0) {
            return { display: "none" };
        }
        return {
            width: `${Math.min(100, progress)}%`,
        };
    }

    // =========================================================================
    // Predecessor Arrows
    // =========================================================================

    /**
     * Get cached record ID to row index mapping
     */
    _getRecordToRowMap() {
        const rows = this.flattenedRows;
        const currentHash = this._computeDataHash();

        // Return cached map if valid
        if (this._cache.recordToRowMap && this._cache.recordToRowMapHash === currentHash) {
            return this._cache.recordToRowMap;
        }

        // Build new map
        const recordToRow = new Map();
        rows.forEach((row, index) => {
            if (!row._isGroup) {
                recordToRow.set(row.id, index);
            }
        });

        // Cache the result
        this._cache.recordToRowMap = recordToRow;
        this._cache.recordToRowMapHash = currentHash;

        return recordToRow;
    }

    get predecessorArrows() {
        const arrows = [];
        const predecessors = this.predecessors;
        const rows = this.flattenedRows;

        if (!predecessors.length) return arrows;

        const taskIdField = this.props.archInfo.predecessorTaskId;
        const parentTaskIdField = this.props.archInfo.predecessorParentTaskId;
        const typeField = this.props.archInfo.predecessorType;

        // Use cached record to row mapping
        const recordToRow = this._getRecordToRowMap();

        for (const pred of predecessors) {
            const taskId = Array.isArray(pred[taskIdField]) ? pred[taskIdField][0] : pred[taskIdField];
            const parentTaskId = Array.isArray(pred[parentTaskIdField]) ? pred[parentTaskIdField][0] : pred[parentTaskIdField];
            const type = pred[typeField] || "FS";

            const fromRowIndex = recordToRow.get(parentTaskId);
            const toRowIndex = recordToRow.get(taskId);

            if (fromRowIndex !== undefined && toRowIndex !== undefined) {
                const fromRecord = rows[fromRowIndex];
                const toRecord = rows[toRowIndex];

                if (fromRecord._dateStart && fromRecord._dateStop && toRecord._dateStart && toRecord._dateStop) {
                    arrows.push({
                        id: pred.id,
                        from: fromRecord,
                        to: toRecord,
                        fromRowIndex,
                        toRowIndex,
                        type,
                        isCritical: fromRecord._isCriticalPath && toRecord._isCriticalPath,
                    });
                }
            }
        }

        return arrows;
    }

    getArrowPath(arrow) {
        const { from, to, fromRowIndex, toRowIndex, type } = arrow;

        // Calculate positions based on link type
        let fromX, fromY, toX, toY;
        const rowHeight = this.ROW_HEIGHT;
        const barOffset = 8; // Top offset of bar within row
        const barHeight = 28;

        // Determine start and end points based on link type (FS, SS, FF, SF)
        switch (type) {
            case "SS": // Start-to-Start
                fromX = this._dateToPixels(from._dateStart);
                toX = this._dateToPixels(to._dateStart);
                break;
            case "FF": // Finish-to-Finish
                fromX = this._dateToPixels(from._dateStop);
                toX = this._dateToPixels(to._dateStop);
                break;
            case "SF": // Start-to-Finish
                fromX = this._dateToPixels(from._dateStart);
                toX = this._dateToPixels(to._dateStop);
                break;
            case "FS": // Finish-to-Start (default)
            default:
                fromX = this._dateToPixels(from._dateStop);
                toX = this._dateToPixels(to._dateStart);
                break;
        }

        // Calculate Y positions (center of bars)
        fromY = fromRowIndex * rowHeight + barOffset + barHeight / 2;
        toY = toRowIndex * rowHeight + barOffset + barHeight / 2;

        // Create a curved path
        const midX = (fromX + toX) / 2;
        const controlOffset = Math.min(30, Math.abs(toX - fromX) / 3);

        // Different path styles based on relative positions
        if (toX > fromX + 20) {
            // Normal case: target is to the right
            return `M ${fromX} ${fromY}
                    C ${fromX + controlOffset} ${fromY},
                      ${toX - controlOffset} ${toY},
                      ${toX} ${toY}`;
        } else {
            // Wrap-around case: target is to the left or very close
            const verticalOffset = (toRowIndex > fromRowIndex ? 1 : -1) * rowHeight / 2;
            return `M ${fromX} ${fromY}
                    L ${fromX + 15} ${fromY}
                    L ${fromX + 15} ${fromY + verticalOffset}
                    L ${toX - 15} ${toY - verticalOffset}
                    L ${toX - 15} ${toY}
                    L ${toX} ${toY}`;
        }
    }

    getArrowClass(arrow) {
        const classes = ["o_gantt_arrow"];
        if (arrow.isCritical) {
            classes.push("o_gantt_arrow_critical");
        }
        if (this.state.hoveredRecordId === arrow.from.id || this.state.hoveredRecordId === arrow.to.id) {
            classes.push("o_gantt_arrow_highlight");
        }
        return classes.join(" ");
    }

    getArrowMarker(arrow) {
        if (arrow.isCritical) return "url(#arrowhead-critical)";
        if (this.state.hoveredRecordId === arrow.from.id || this.state.hoveredRecordId === arrow.to.id) {
            return "url(#arrowhead-highlight)";
        }
        return "url(#arrowhead)";
    }

    _updateArrows() {
        // Force re-render of arrows after layout changes
        if (this.arrowContainer.el) {
            // Arrows are rendered declaratively via template, just trigger reactivity
            this.render();
        }
    }

    // =========================================================================
    // Drag and Drop
    // =========================================================================

    onBarMouseDown(ev, record) {
        if (record._isGroup || record._isSummary) return;

        ev.preventDefault();
        ev.stopPropagation();

        // Clean up any existing listeners first to prevent duplicates
        this._cleanupDragListeners();

        const isResizeHandle = ev.target.classList.contains("o_gantt_bar_resize_handle");
        const isResizeLeft = ev.target.classList.contains("o_gantt_bar_resize_left");

        this._dragState = {
            record,
            startX: ev.clientX,
            originalStart: record._dateStart,
            originalStop: record._dateStop,
            mode: isResizeHandle ? (isResizeLeft ? "resize-left" : "resize-right") : "move",
            hasMoved: false,
        };

        this.state.isDragging = true;
        this.state.dragMode = this._dragState.mode;

        // Add visual feedback
        document.body.style.cursor = this._dragState.mode === "move" ? "grabbing" : "ew-resize";
        document.body.style.userSelect = "none";

        // Bind event listeners (store bound references for proper cleanup)
        this._boundDragMove = this._onDragMove.bind(this);
        this._boundDragEnd = this._onDragEnd.bind(this);
        document.addEventListener("mousemove", this._boundDragMove);
        document.addEventListener("mouseup", this._boundDragEnd);
    }

    _onDragMove(ev) {
        if (!this._dragState) return;

        const deltaX = ev.clientX - this._dragState.startX;
        if (Math.abs(deltaX) < 3 && !this._dragState.hasMoved) return;

        this._dragState.hasMoved = true;

        const deltaDate = this._pixelsToDuration(deltaX);
        const record = this._dragState.record;

        // Calculate new dates based on drag mode
        let newStart = this._dragState.originalStart;
        let newStop = this._dragState.originalStop;

        switch (this._dragState.mode) {
            case "move":
                newStart = this._dragState.originalStart.plus(deltaDate);
                newStop = this._dragState.originalStop.plus(deltaDate);
                break;
            case "resize-right":
                newStop = this._dragState.originalStop.plus(deltaDate);
                if (newStop <= newStart) {
                    newStop = newStart.plus({ hours: 1 });
                }
                break;
            case "resize-left":
                newStart = this._dragState.originalStart.plus(deltaDate);
                if (newStart >= newStop) {
                    newStart = newStop.minus({ hours: 1 });
                }
                break;
        }

        // Update visual preview (without saving to server)
        record._dateStart = newStart;
        record._dateStop = newStop;
        this.render();
    }

    _pixelsToDuration(pixels) {
        const scale = this.props.scale;
        const config = this.scaleConfig[scale] || this.scaleConfig.day;
        const units = pixels / config.pixels;

        switch (config.unit) {
            case "hour":
                return { hours: units * config.factor };
            case "day":
                return { days: units };
            case "week":
                return { weeks: units };
            case "month":
                return { months: units };
            case "quarter":
                return { months: units * 3 };
        }
        return { days: units };
    }

    async _onDragEnd(ev) {
        this._cleanupDragListeners();

        if (!this._dragState) return;

        const { record, originalStart, originalStop, hasMoved } = this._dragState;

        if (!hasMoved) {
            // It was a click, not a drag - restore original values
            record._dateStart = originalStart;
            record._dateStop = originalStop;
            this._dragState = null;
            this.state.isDragging = false;
            this.state.dragMode = null;
            return;
        }

        // Prepare values for server update
        const dateStartField = this.props.archInfo.dateStart;
        const dateStopField = this.props.archInfo.dateStop;

        const values = {
            [dateStartField]: record._dateStart.toISO(),
            [dateStopField]: record._dateStop.toISO(),
        };

        try {
            // Save to server
            const success = await this.props.onRecordUpdate(record.id, values);

            if (!success) {
                // Revert to original values on failure
                record._dateStart = originalStart;
                record._dateStop = originalStop;
            }
        } catch (error) {
            console.error("Failed to update record during drag:", error);
            // Revert to original values on error
            record._dateStart = originalStart;
            record._dateStop = originalStop;
        } finally {
            this._dragState = null;
            this.state.isDragging = false;
            this.state.dragMode = null;
            this.render();
        }
    }

    _cleanupDragListeners() {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (this._boundDragMove) {
            document.removeEventListener("mousemove", this._boundDragMove);
            this._boundDragMove = null;
        }
        if (this._boundDragEnd) {
            document.removeEventListener("mouseup", this._boundDragEnd);
            this._boundDragEnd = null;
        }
    }

    // =========================================================================
    // Event Handlers
    // =========================================================================

    onRowHover(recordId) {
        this.state.hoveredRecordId = recordId;
    }

    onRowLeave() {
        this.state.hoveredRecordId = null;
    }

    onRecordClick(record) {
        if (!record._isGroup && !this.state.isDragging) {
            this.state.selectedRecordId = record.id;
            this.props.onRecordClick(record);
        }
    }

    onGroupClick(group) {
        this.props.onGroupToggle(group.id);
    }

    onGutterResize(ev) {
        ev.preventDefault();

        // Clean up any existing listeners first
        this._cleanupGutterListeners();

        this._gutterState = {
            startX: ev.clientX,
            startWidth: this.state.gutterWidth,
        };

        // Add visual feedback during resize
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        // Store bound references for proper cleanup
        this._boundGutterMove = this._onGutterMove.bind(this);
        this._boundGutterEnd = this._onGutterEnd.bind(this);

        document.addEventListener("mousemove", this._boundGutterMove);
        document.addEventListener("mouseup", this._boundGutterEnd);
    }

    _onGutterMove(ev) {
        if (!this._gutterState) return;
        const diff = ev.clientX - this._gutterState.startX;
        // Respect Apple HIG min/max sidebar widths (240-480px)
        this.state.gutterWidth = Math.max(240, Math.min(480, this._gutterState.startWidth + diff));
    }

    _onGutterEnd() {
        this._cleanupGutterListeners();
        this._gutterState = null;
    }

    _cleanupGutterListeners() {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (this._boundGutterMove) {
            document.removeEventListener("mousemove", this._boundGutterMove);
            this._boundGutterMove = null;
        }
        if (this._boundGutterEnd) {
            document.removeEventListener("mouseup", this._boundGutterEnd);
            this._boundGutterEnd = null;
        }
    }

    onRecordSelect(record) {
        if (!record._isGroup) {
            this.state.selectedRecordId = record.id;
        }
    }

    // =========================================================================
    // Today Marker
    // =========================================================================

    getTodayMarkerStyle() {
        const { timeStart, timeStop } = this.model.data;
        if (!timeStart) {
            return { display: "none" };
        }

        const today = DateTime.now();

        // Check if today is within the visible range
        if (today < timeStart || today > timeStop) {
            return { display: "none" };
        }

        const left = this._dateToPixels(today);

        return {
            left: `${left}px`,
            display: "block",
        };
    }

    // =========================================================================
    // Keyboard Navigation
    // =========================================================================

    onKeyDown(ev) {
        if (!this.state.selectedRecordId) return;

        const record = this.flattenedRows.find(r => r.id === this.state.selectedRecordId);
        if (!record || record._isGroup) return;

        switch (ev.key) {
            case "ArrowUp":
                ev.preventDefault();
                this._selectPreviousRecord();
                break;
            case "ArrowDown":
                ev.preventDefault();
                this._selectNextRecord();
                break;
            case "Enter":
                ev.preventDefault();
                this.props.onRecordClick(record);
                break;
            case "Escape":
                ev.preventDefault();
                this.state.selectedRecordId = null;
                break;
        }
    }

    _selectPreviousRecord() {
        const rows = this.flattenedRows.filter(r => !r._isGroup);
        const currentIndex = rows.findIndex(r => r.id === this.state.selectedRecordId);
        if (currentIndex > 0) {
            this.state.selectedRecordId = rows[currentIndex - 1].id;
        }
    }

    _selectNextRecord() {
        const rows = this.flattenedRows.filter(r => !r._isGroup);
        const currentIndex = rows.findIndex(r => r.id === this.state.selectedRecordId);
        if (currentIndex < rows.length - 1) {
            this.state.selectedRecordId = rows[currentIndex + 1].id;
        }
    }
}
