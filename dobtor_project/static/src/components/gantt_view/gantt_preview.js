/** @odoo-module **/

/**
 * Pure helpers for the "preview overlay": hollow bars drawn over the chart for a
 * set of PROPOSED task windows (an external assistant, a what-if tool …).
 *
 * The overlay is display-only by design: it never writes to the model, never
 * touches the undo stack and never triggers a save. It accepts the same wire
 * format the cascade RPCs return ({task_id: {date_start, date_end, plan_offset,
 * plan_duration}}), so any caller that can run `action_move_and_cascade` on a
 * scratch copy can show its result here.
 *
 * Kept free of OWL / web imports so it can be unit-tested with plain `node --test`
 * (static/tests/gantt_preview.test.mjs).
 */

/**
 * @param {Object} tasks  {taskId: {date_start, date_end, plan_offset, plan_duration}}
 *   Dated tasks carry date_start/date_end (Odoo UTC strings); planning-mode tasks
 *   (no dates) carry plan_offset + plan_duration in hours from T+0.
 * @param {Object} io
 *   parseDate(str) -> DateTime|null          string -> display DateTime
 *   planWindow(offset, duration) -> {start, end}   planning-mode hours -> DateTimes
 * @returns {Object} {taskId: {dateStart, dateEnd}} (only tasks that resolve to a window)
 */
export function previewBarsFromDiff(tasks, io) {
    const bars = {};
    for (const [rawId, row] of Object.entries(tasks || {})) {
        const id = Number(rawId);
        if (!id || !row) {
            continue;
        }
        let start = null;
        let end = null;
        if (row.date_start) {
            start = io.parseDate(row.date_start);
            end = row.date_end ? io.parseDate(row.date_end) : null;
        } else if (row.plan_offset !== undefined && row.plan_offset !== null
            && Number(row.plan_duration) > 0) {
            ({ start, end } = io.planWindow(Number(row.plan_offset), Number(row.plan_duration)));
        }
        if (start && start.isValid !== false) {
            bars[id] = { dateStart: start, dateEnd: end && end.isValid !== false ? end : null };
        }
    }
    return bars;
}

/** First task (smallest start) of a bar map, to scroll to. */
export function firstPreviewTask(bars) {
    let best = null;
    for (const [id, bar] of Object.entries(bars || {})) {
        const ms = bar.dateStart.toMillis ? bar.dateStart.toMillis() : +bar.dateStart;
        if (best === null || ms < best.ms) {
            best = { id: Number(id), ms };
        }
    }
    return best ? best.id : null;
}
