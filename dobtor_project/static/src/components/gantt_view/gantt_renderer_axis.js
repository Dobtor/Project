/** @odoo-module **/

import {
    dayWorkHours, workHoursInRange, workingFractionOfDay,
    workingHourOfDayFromFraction,
} from "./gantt_worktime";
import { planHoursToPx, pxToPlanHours } from "./gantt_plan_axis";
import { cellsDeltaToDuration, PLANNING_T0 } from "./gantt_utils";


/**
 * THE AXIS — how an instant becomes an x, and back.
 *
 * Mixed into GanttRenderer's prototype (see the bottom of gantt_renderer.js).
 * It lives in its own file because it is the chart's most load-bearing
 * arithmetic and it carries invariants worth reading in one place, not because
 * the renderer was too long: bars, dependency arrows, the grid, drag, resize and
 * the scroll map all agree with each other only because they all come through
 * here.
 *
 * A chart is drawn on exactly one of two timelines, and both are the same pair
 * of operations so they cannot drift apart:
 *
 *   _dateToPx(dt)  x of an instant
 *   _pxToDate(px)  the instant at x — the exact inverse
 *
 * PLAN axis — planning mode. There are no dates: a row's position is its
 *   plan_offset in working hours from T+0, and gantt_plan_axis.js maps those
 *   hours to pixels. (The DateTimes planning rows carry are T0 + hours, so the
 *   hours read straight back out.)
 *
 * CALENDAR axis — everything else. Position = the index of the cell the instant
 *   falls in, plus how far through that cell it sits. What "how far through"
 *   means is the ONE thing that varies: with a work calendar it is the cell's
 *   WORKING time consumed (a lunch break and a night take no width, so equal
 *   scheduled hours draw equal length); without one it is plain elapsed time.
 *   Cells are uniform (hour/day scales), filtered (hide-non-working) or variable
 *   (week/month) — _cellOf and _cellAt are the only places that know which.
 */
export const GanttAxisMixin = {
    /**
     * Convert a DateTime to pixel position relative to timeline start.
     * - Sub-day: uniform px/ms (or working-hour index when hiding non-working).
     * - Day: px/day (or working-day index when hiding non-working).
     * - Week/month: column-index-based (variable column widths).
     */
    _dateToPx(dt) {
        const data = this.props.model.data;
        if (!data?.timeStart || !dt) return 0;
        if (!data.timeStart.isValid || (dt.isValid !== undefined && !dt.isValid)) return 0;
        // Render-cycle cache: same dt → same px within one render pass
        if (!this._dateToPxCache) this._dateToPxCache = new Map();
        const cacheKey = dt.toMillis();
        const cached = this._dateToPxCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const result = this._dateToPxUncached(dt);
        this._dateToPxCache.set(cacheKey, result);
        return result;
    },

    // =====================================================================
    // THE AXIS
    //
    // A chart is drawn on exactly one of two timelines, and both are expressed
    // as the same pair of operations so they cannot drift apart:
    //
    //   _axisToPx(dt)   x of an instant
    //   _axisFromPx(px) the instant at x  — the exact inverse
    //
    // PLAN axis  — planning mode. There are no dates: a row's position is its
    //   plan_offset in working hours from T+0, and gantt_plan_axis.js maps those
    //   hours to pixels. (The DateTimes planning rows carry are T0 + hours, so
    //   the hours read straight back out.)
    //
    // CALENDAR axis — everything else. Position = the index of the cell the
    //   instant falls in, plus how far through that cell it sits. What "how far
    //   through" means is the ONE thing that varies: with a work calendar it is
    //   the cell's WORKING time consumed (a lunch break and a night take no
    //   width, so equal scheduled hours draw equal length); without one it is
    //   plain elapsed time. Cells are uniform (hour/day scales), filtered
    //   (hide-non-working) or variable (week/month) — _cellOf and _cellAt are
    //   the only places that know which.
    //
    // Every caller — bars, arrows, the grid, drag, resize — goes through this
    // pair. It used to be two long parallel if-chains, one per direction, that
    // had to be kept in step by hand.
    // =====================================================================

    /** The cell containing `dt`: {index, start, end}, or null if unresolvable. */
    _cellOf(dt) {
        const scale = this.props.scale;
        const timeStart = this._extendedTimeStart || this.props.model.data.timeStart;

        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            const hours = parseInt(scale);
            if (this._workingHourIndex && this.props.hideNonWorkingDays) {
                const dtHour = dt.hour + dt.minute / 60;
                const aligned = dt.startOf("hour").set({
                    hour: Math.floor(dtHour) - (Math.floor(dtHour) % hours) });
                const index = this._workingHourIndex.get(aligned.toISO());
                if (index === undefined) return null;   // hidden hour → caller falls back
                return { index, start: aligned, end: aligned.plus({ hours }) };
            }
            const index = Math.floor(
                (dt.toMillis() - timeStart.toMillis()) / (hours * 3600 * 1000));
            const cellStart = timeStart.plus({ hours: index * hours });
            return { index, start: cellStart, end: cellStart.plus({ hours }) };
        }

        if (scale === "week" || scale === "month") {
            const cols = this._coarseColumns;
            if (!cols || !cols.length) return null;
            const step = scale === "week" ? { weeks: 1 } : { months: 1 };
            const dtMs = dt.toMillis();
            let lo = 0, hi = cols.length - 1, index = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (dtMs < cols[mid].date.toMillis()) hi = mid - 1;
                else { index = mid; lo = mid + 1; }
            }
            // Outside the generated columns: extrapolate from the nearest one,
            // so a bar beyond the range still lands in the right direction.
            if (index < 0) index = 0;
            return this._cellAt(index, step);
        }

        // Day
        if (this._workingDayIndex && this.props.hideNonWorkingDays) {
            const day = dt.startOf("day");
            const index = this._workingDayIndex.get(day.toISODate());
            if (index === undefined) return null;       // hidden day → caller falls back
            return { index, start: day, end: day.plus({ days: 1 }) };
        }
        const day = dt.startOf("day");
        const index = Math.round(day.diff(timeStart.startOf("day"), "days").days);
        return { index, start: day, end: day.plus({ days: 1 }) };
    },

    /** The cell at `index`: {index, start, end}. Clamped/extrapolated at the ends. */
    _cellAt(index, step) {
        const scale = this.props.scale;
        const timeStart = this._extendedTimeStart || this.props.model.data.timeStart;

        if (scale === "week" || scale === "month") {
            const cols = this._coarseColumns;
            if (!cols || !cols.length) return null;
            const stp = step || (scale === "week" ? { weeks: 1 } : { months: 1 });
            const i = Math.max(0, Math.min(cols.length - 1, index));
            const start = cols[i].date;
            const end = (i + 1 < cols.length) ? cols[i + 1].date : start.plus(stp);
            return { index: i, start, end };
        }

        if (scale === "1h" || scale === "2h" || scale === "4h" || scale === "8h") {
            const hours = parseInt(scale);
            if (this._workingHourIndex && this.props.hideNonWorkingDays) {
                const cols = this._workingHourCols || [];
                if (!cols.length) return null;
                const i = Math.max(0, Math.min(cols.length - 1, index));
                return { index: i, start: cols[i].date,
                         end: cols[i].date.plus({ hours }) };
            }
            const start = timeStart.plus({ hours: index * hours });
            return { index, start, end: start.plus({ hours }) };
        }

        if (this._workingDayIndex && this.props.hideNonWorkingDays) {
            const cols = this.timelineColumns;
            if (!cols.length) return null;
            const i = Math.max(0, Math.min(cols.length - 1, index));
            const start = cols[i].date.startOf("day");
            return { index: i, start, end: start.plus({ days: 1 }) };
        }
        const start = timeStart.startOf("day").plus({ days: index });
        return { index, start, end: start.plus({ days: 1 }) };
    },

    /** How far through `cell` the instant `dt` sits, as 0..1. */
    _cellFraction(cell, dt) {
        if (this._useWorkTimeAxis && this._cellIsCalendarDay) {
            return this._workingFractionOfDay(dt);
        }
        if (this._useWorkTimeAxis && this._cellIsCoarse) {
            return this._workingFractionOfSpan(cell, dt);
        }
        const span = cell.end.toMillis() - cell.start.toMillis();
        return span > 0 ? (dt.toMillis() - cell.start.toMillis()) / span : 0;
    },

    /** The instant at `frac` through `cell` — inverse of _cellFraction. */
    _cellInstant(cell, frac) {
        if (this._useWorkTimeAxis && this._cellIsCalendarDay) {
            return this._dateFromWorkingFraction(cell.start, frac);
        }
        if (this._useWorkTimeAxis && this._cellIsCoarse) {
            const profile = this._spanWorkProfile(cell);
            if (profile.total > 0) {
                // Which day has `frac × total` working hours behind it?
                const want = Math.max(0, Math.min(1, frac)) * profile.total;
                let lo = 0, hi = profile.days.length - 1, i = -1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    if (profile.upto[mid] <= want) { i = mid; lo = mid + 1; }
                    else hi = mid - 1;
                }
                if (i < 0) return cell.start;
                const day = profile.days[i];
                const dayHours = profile.upto[i + 1] - profile.upto[i];
                return this._dateFromWorkingFraction(
                    day, dayHours > 0 ? (want - profile.upto[i]) / dayHours : 0);
            }
        }
        const span = cell.end.toMillis() - cell.start.toMillis();
        return cell.start.plus({ milliseconds: frac * span });
    },

    get _cellIsCalendarDay() {
        return this.props.scale === "day";
    },

    get _cellIsCoarse() {
        return this.props.scale === "week" || this.props.scale === "month";
    },

    /** Memoised working hours in a coarse cell (a month is ~31 day lookups). */
    /**
     * A coarse cell's working time, as a prefix sum over its days:
     * ``{days: [DateTime], upto: [0, h₀, h₀+h₁, …], total}``.
     *
     * Both directions used to walk the cell day by day on EVERY call — up to 31
     * lookups per bar edge per render at the month zoom, and again on every
     * pointer move during a drag. The walk happens once per cell per render now
     * and each query is a binary search over `upto`.
     */
    _spanWorkProfile(cell) {
        if (!this._spanWorkCache) this._spanWorkCache = new Map();
        let profile = this._spanWorkCache.get(cell.index);
        if (profile === undefined) {
            const days = [];
            const upto = [0];
            let cursor = cell.start.startOf("day");
            let acc = 0;
            while (cursor < cell.end) {
                days.push(cursor);
                acc += this._dayWorkHours(cursor);
                upto.push(acc);
                cursor = cursor.plus({ days: 1 });
            }
            profile = { days, upto, total: acc };
            this._spanWorkCache.set(cell.index, profile);
        }
        return profile;
    },

    /** Index of the day containing `dt` inside a cell profile, or -1. */
    _profileDayIndex(profile, dt) {
        const { days } = profile;
        let lo = 0, hi = days.length - 1, found = -1;
        const ms = dt.toMillis();
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ms < days[mid].toMillis()) hi = mid - 1;
            else { found = mid; lo = mid + 1; }
        }
        return found;
    },

    _dateToPxUncached(dt) {
        const cw = this.cellWidth;

        if (this.isPlanningMode) {
            return planHoursToPx(dt.diff(PLANNING_T0, "hours").hours,
                this._planCellHours, this._planFirstCell || 0, cw);
        }

        const cell = this._cellOf(dt);
        if (!cell) {
            // The instant falls on a hidden day/hour: park it on the nearest
            // visible edge rather than nowhere.
            return this._cellIsCalendarDay
                ? this._dateToPxFallback(dt, cw)
                : this._dateToPxHourFallback(dt, cw);
        }
        return (cell.index + this._cellFraction(cell, dt)) * cw;
    },

    /** The instant at pixel `px` — exact inverse of :meth:`_dateToPx`. */
    _pxToDate(px) {
        const cw = this.cellWidth;
        if (!cw) return null;

        if (this.isPlanningMode) {
            const hours = pxToPlanHours(px, this._planCellHours,
                this._planFirstCell || 0, cw);
            return PLANNING_T0.plus({ hours: Math.max(0, hours) });
        }

        const pos = px / cw;
        const index = Math.floor(pos);
        const cell = this._cellAt(index);
        if (!cell) return null;
        return this._cellInstant(cell, pos - index);
    },

    /**
     * Move `dt` by a (possibly fractional) number of cells, in whatever units
     * the current axis is drawn in — so the committed date matches where the
     * user actually dropped the bar.
     */
    _shiftByCells(dt, cellsDelta) {
        const axisDate = this._pxToDate(this._dateToPx(dt) + cellsDelta * this.cellWidth);
        if (axisDate && axisDate.isValid) return axisDate;
        // Only reachable before the first render, when no columns exist yet.
        return dt.plus(cellsDeltaToDuration(cellsDelta, this.props.scale));
    },

    /**
     * Build a Map from ISO date string → column index for working days.
     */
    _rebuildWorkingDayIndex(cols) {
        this._workingDayIndex = new Map();
        for (let i = 0; i < cols.length; i++) {
            this._workingDayIndex.set(cols[i].date.toISODate(), i);
        }
    },

    /**
     * Build a Map from ISO datetime string → column index for working hours.
     * The column array is kept too: _cellAt resolves an index back to its cell.
     */
    _rebuildWorkingHourIndex(cols) {
        this._workingHourIndex = new Map();
        this._workingHourCols = cols;
        for (let i = 0; i < cols.length; i++) {
            this._workingHourIndex.set(cols[i].date.toISO(), i);
        }
    },

    /**
     * Fallback for _dateToPx when dt falls on a non-working hour.
     * Scans backward through visible columns to find the nearest edge.
     */
    _dateToPxHourFallback(dt, cw) {
        const cols = this._workingHourCols;
        if (!cols || !cols.length) return 0;
        // Find nearest preceding working column
        let bestIdx = -1;
        for (let i = cols.length - 1; i >= 0; i--) {
            if (cols[i].date <= dt) {
                bestIdx = i;
                break;
            }
        }
        if (bestIdx >= 0) {
            return (bestIdx + 1) * cw; // right edge of that column
        }
        // dt is before all visible columns
        return 0;
    },

    /**
     * Fallback for _dateToPx when dt falls on a non-working day.
     * Returns the right edge (end) of the nearest preceding working day.
     */
    _dateToPxFallback(dt, cw) {
        const cols = this.timelineColumns;
        if (!cols.length) return 0;
        let cursor = dt.startOf("day").minus({ days: 1 });
        const earliest = cols[0]?.date;
        while (cursor >= earliest) {
            const key = cursor.toISODate();
            const idx = this._workingDayIndex.get(key);
            if (idx !== undefined) {
                return (idx + 1) * cw; // right edge of that working day
            }
            cursor = cursor.minus({ days: 1 });
        }
        return 0;
    },

    // ---------------------------------------------------------------------
    // Working-time axis
    //
    // A day column's WIDTH means the working time of that day, not 24 clock
    // hours. With a 9:00–12:00 / 13:00–18:00 calendar, 8 scheduled hours fill
    // exactly one day cell; the lunch hour and the night take no width at all.
    // Two tasks of the same scheduled hours therefore draw the same length —
    // measuring the wall clock made a task that happened to run over a lunch
    // break, or overnight, look longer than an identical one that did not.
    //
    // Non-working DAYS still occupy their column (the "hide non-working days"
    // toggle is what removes those); they simply contain no working time, so
    // everything inside such a day maps to the column's left edge.
    //
    // Not applied in planning mode: a planning chart has no calendar to lay out
    // — its rows are positioned in planned hours from T+0 and go through
    // gantt_plan_axis.js instead. Without a work calendar the axis stays on the
    // clock, exactly as before.
    // ---------------------------------------------------------------------

    /** Whether positions should be measured in working time. */
    get _useWorkTimeAxis() {
        return !!this.props.model.data?.calendarInfo?._weekdayMap
            && !this.isPlanningMode;
    },

    /**
     * The day's work intervals as [{from, to}] in decimal local hours.
     * `[]` for a day the calendar does not work; `null` when there is no
     * calendar to consult (caller falls back to clock time).
     */
    _dayWorkIntervals(day) {
        const ci = this.props.model.data?.calendarInfo;
        if (!ci?._weekdayMap) return null;
        if (ci._leaveDays?.has(day.toISODate())) return [];
        return ci._weekdayMap[String(day.weekday - 1)] || [];
    },

    /** Total working hours of a day (0 on a weekend / leave day). */
    _dayWorkHours(day) {
        return dayWorkHours(this._dayWorkIntervals(day) || []);
    },

    /**
     * How far through the day's working time `dt` sits, as 0..1.
     * 09:00 → 0, 12:00 and 13:00 → both 3/8 (the break has no width),
     * 18:00 → 1. Falls back to the clock fraction with no calendar.
     */
    _workingFractionOfDay(dt) {
        const ivs = this._dayWorkIntervals(dt.startOf("day"));
        if (!ivs) return (dt.hour + dt.minute / 60) / 24;
        return workingFractionOfDay(
            ivs, dt.hour + dt.minute / 60 + dt.second / 3600);
    },

    /** Inverse of :meth:`_workingFractionOfDay`. */
    _dateFromWorkingFraction(day, frac) {
        const ivs = this._dayWorkIntervals(day);
        if (!ivs) return day.plus({ hours: Math.max(0, frac) * 24 });
        const hour = workingHourOfDayFromFraction(ivs, frac);
        return hour === null ? day : day.plus({ hours: hour });
    },

    /** Working hours between two datetimes (used for week / month columns). */
    _workingHoursBetween(from, to) {
        if (to <= from) return 0;
        let total = 0;
        let cursor = from.startOf("day");
        const lastDay = to.startOf("day");
        const fromH = from.hour + from.minute / 60;
        const toH = to.hour + to.minute / 60;
        while (cursor <= lastDay) {
            const ivs = this._dayWorkIntervals(cursor);
            if (ivs && ivs.length) {
                const isFirst = +cursor === +from.startOf("day");
                const isLast = +cursor === +lastDay;
                total += workHoursInRange(
                    ivs, isFirst ? fromH : 0, isLast ? toH : 24);
            }
            cursor = cursor.plus({ days: 1 });
        }
        return total;
    },

    /**
     * Fraction of a coarse cell (week / month) consumed by working time up to
     * `dt`. A weekend inside the cell costs nothing, so an 8-hour task is 1/5 of
     * a five-day week wherever it falls.
     */
    _workingFractionOfSpan(cell, dt) {
        const profile = this._spanWorkProfile(cell);
        if (profile.total <= 0) {
            const span = cell.end.toMillis() - cell.start.toMillis();
            return span > 0 ? (dt.toMillis() - cell.start.toMillis()) / span : 0;
        }
        const i = this._profileDayIndex(profile, dt);
        if (i < 0) return 0;
        const day = profile.days[i];
        const inDay = workHoursInRange(
            this._dayWorkIntervals(day) || [], 0,
            dt.hour + dt.minute / 60 + dt.second / 3600);
        return Math.max(0, Math.min(1, (profile.upto[i] + inDay) / profile.total));
    },
};
