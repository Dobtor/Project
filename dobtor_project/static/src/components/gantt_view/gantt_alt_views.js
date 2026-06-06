/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";

const { DateTime } = luxon;

// Must match the renderer's PLANNING_T0 so the calendar's T+N offsets line up
// exactly with the gantt's planning-mode labels.
const PLANNING_T0 = DateTime.fromObject({ year: 2000, month: 1, day: 1 });

/**
 * Alternate visualisations for the native Gantt, rendered as an overlay so the
 * main Gantt DOM is never touched (default "gantt" mode is unaffected):
 *
 *   - resource : OmniPlan-style resource view — one lane per resource with its
 *                assigned task bars and over-allocation (overlap) highlighting.
 *   - network  : PERT / network diagram — a node per task laid out in
 *                dependency layers, with dependency links drawn as SVG lines.
 *   - calendar : month grid with tasks placed on the days they span.
 *
 * All three reuse `model.data` (records already carry _dateStart / _dateEnd and
 * the resourceField), so no extra RPC is needed.
 *
 * Props:
 *   mode      : "resource" | "network" | "calendar"
 *   model     : the GanttModel instance
 *   archInfo  : parsed arch (for field names)
 *   onClose   : () => void
 */
export class GanttAltView extends Component {
    static template = "dobtor_project.GanttAltView";
    static props = {
        mode: { type: String },
        model: { type: Object },
        archInfo: { type: Object },
        onClose: { type: Function, optional: true },
        onSetMode: { type: Function, optional: true },
    };

    setup() {
        // Names for resource ids (res.users / resource.resource) resolved lazily,
        // because m2m fields (e.g. user_ids) only carry ids in the gantt records.
        this.resNames = useState({});
        onWillStart(() => this._loadResourceNames());
        onWillUpdateProps(() => this._loadResourceNames());
    }

    setMode(mode) {
        if (this.props.onSetMode) this.props.onSetMode(mode);
    }

    close() {
        if (this.props.onClose) this.props.onClose();
    }

    /** The field carrying resource assignment (explicit resourceField, else userId). */
    get _resourceField() {
        return this.props.archInfo.resourceField || this.props.archInfo.userId || "";
    }

    /** Normalise a record's resource value to a list of {id, name}. */
    _resourceRefs(rec) {
        const field = this._resourceField;
        if (!field) return [];
        const v = rec[field];
        if (!v) return [];
        // many2one pair [id, name]
        if (Array.isArray(v) && v.length === 2 && typeof v[1] === "string") {
            return [{ id: v[0], name: v[1] }];
        }
        // many2many: array of ids
        if (Array.isArray(v)) {
            return v.filter(x => typeof x === "number")
                    .map(id => ({ id, name: this.resNames[id] || ("#" + id) }));
        }
        return [{ id: v, name: this.resNames[v] || String(v) }];
    }

    async _loadResourceNames() {
        const field = this._resourceField;
        if (!field) return;
        const ids = new Set();
        for (const rec of this.records) {
            const v = rec[field];
            if (Array.isArray(v) && !(v.length === 2 && typeof v[1] === "string")) {
                for (const id of v) if (typeof id === "number") ids.add(id);
            }
        }
        const missing = [...ids].filter(id => !(id in this.resNames));
        if (!missing.length) return;
        const model = (field === this.props.archInfo.userId)
            ? "res.users"
            : (this.props.archInfo.resourceModel || "resource.resource");
        try {
            const recs = await this.props.model.orm.read(model, missing, ["display_name"]);
            for (const r of recs) this.resNames[r.id] = r.display_name;
        } catch (_e) { /* names are best-effort */ }
    }

    // --- shared helpers -----------------------------------------------------

    get records() {
        return (this.props.model.data?.records || []).filter(
            r => !r._isGroup && !r._isMilestoneRecord && r._dateStart && r._dateEnd
                 && r._dateStart.isValid && r._dateEnd.isValid);
    }

    get timeStart() {
        const recs = this.records;
        if (!recs.length) return DateTime.now().startOf("month");
        return recs.reduce((m, r) => (r._dateStart < m ? r._dateStart : m),
            recs[0]._dateStart).startOf("day");
    }

    get timeEnd() {
        const recs = this.records;
        if (!recs.length) return DateTime.now().endOf("month");
        return recs.reduce((m, r) => (r._dateEnd > m ? r._dateEnd : m),
            recs[0]._dateEnd).endOf("day");
    }

    get dayWidth() {
        return 24;
    }

    get totalDays() {
        return Math.max(1, Math.ceil(this.timeEnd.diff(this.timeStart, "days").days));
    }

    get timelineWidth() {
        return this.totalDays * this.dayWidth;
    }

    /** Days header for resource / network background grid. */
    get dayColumns() {
        const cols = [];
        const start = this.timeStart;
        for (let i = 0; i < this.totalDays; i++) {
            const d = start.plus({ days: i });
            cols.push({ index: i, label: d.day, isWeekend: d.weekday >= 6 });
        }
        return cols;
    }

    _xOf(dt) {
        if (!dt || !dt.isValid) return 0;
        return Math.max(0, dt.diff(this.timeStart, "days").days * this.dayWidth);
    }

    _barStyle(rec) {
        const left = this._xOf(rec._dateStart);
        const right = this._xOf(rec._dateEnd);
        const width = Math.max(right - left, 4);
        return `left:${left}px;width:${width}px;`;
    }

    recName(rec) {
        return rec.display_name || rec[this.props.archInfo.name] || "";
    }

    // --- resource view ------------------------------------------------------

    /** [{id, name, tasks:[rec], overloads:[{left,width}]}] */
    get resourceLanes() {
        const byRes = new Map();
        for (const rec of this.records) {
            for (const ref of this._resourceRefs(rec)) {
                if (!byRes.has(ref.id)) byRes.set(ref.id, { id: ref.id, name: ref.name, tasks: [] });
                byRes.get(ref.id).tasks.push(rec);
            }
        }
        const lanes = [...byRes.values()];
        for (const lane of lanes) {
            lane.tasks.sort((a, b) => a._dateStart - b._dateStart);
            lane.overloads = this._computeOverloads(lane.tasks);
        }
        lanes.sort((a, b) => a.name.localeCompare(b.name));
        return lanes;
    }

    /** Time spans where 2+ of a resource's tasks overlap (capacity 1). */
    _computeOverloads(tasks) {
        const events = [];
        for (const t of tasks) {
            events.push({ t: t._dateStart, d: 1 });
            events.push({ t: t._dateEnd, d: -1 });
        }
        events.sort((a, b) => (a.t - b.t) || (a.d - b.d));
        const spans = [];
        let running = 0;
        let segStart = null;
        for (const ev of events) {
            const prev = running;
            running += ev.d;
            if (prev < 2 && running >= 2) segStart = ev.t;
            else if (prev >= 2 && running < 2 && segStart) {
                const left = this._xOf(segStart);
                const width = Math.max(this._xOf(ev.t) - left, 2);
                spans.push({ left, width });
                segStart = null;
            }
        }
        return spans;
    }

    // --- calendar view ------------------------------------------------------

    get calendarWeeks() {
        const first = this.timeStart.startOf("month");
        const gridStart = first.minus({ days: (first.weekday % 7) });
        const weeks = [];
        const recs = this.records;
        for (let w = 0; w < 6; w++) {
            const days = [];
            for (let d = 0; d < 7; d++) {
                const day = gridStart.plus({ days: w * 7 + d });
                const tasks = recs.filter(
                    r => r._dateStart <= day.endOf("day") && r._dateEnd >= day.startOf("day"));
                days.push({
                    key: day.toISODate(),
                    label: day.day,
                    inMonth: day.month === first.month,
                    tasks: tasks.slice(0, 4),
                    more: Math.max(0, tasks.length - 4),
                });
            }
            weeks.push({ key: `w${w}`, days });
        }
        return weeks;
    }

    get calendarTitle() {
        if (this.calendarIsPlanning) {
            return "規劃模式 — 相對日程（T0 = 專案起點）";
        }
        return this.timeStart.toFormat("yyyy LLLL");
    }

    /**
     * Planning mode: tasks have no real dates (virtual timeline anchored at
     * PLANNING_T0). Native Odoo calendar cannot show these at all — this is the
     * differentiating value of keeping a custom calendar. We render a grid of
     * relative days labelled T+0, T+1, … instead of calendar dates.
     */
    get calendarIsPlanning() {
        const recs = this.records;
        return recs.length > 0 && recs.every(r => r._isVirtualDates);
    }

    _planLabel(n) {
        return `T${n > 0 ? "+" : ""}${n}`;
    }

    get planningCalendarRows() {
        const recs = this.records;
        if (!recs.length) return [];
        const spans = recs.map(r => {
            const s = Math.floor(r._dateStart.diff(PLANNING_T0, "days").days);
            let e = Math.ceil(r._dateEnd.diff(PLANNING_T0, "days").days) - 1;
            if (e < s) e = s;
            return { rec: r, s, e };
        });
        const minOff = Math.min(...spans.map(sp => sp.s));
        const maxOff = Math.max(...spans.map(sp => sp.e));
        const PER_ROW = 7;
        const rows = [];
        for (let base = minOff; base <= maxOff; base += PER_ROW) {
            const cells = [];
            for (let i = 0; i < PER_ROW && base + i <= maxOff; i++) {
                const off = base + i;
                const hit = spans.filter(sp => sp.s <= off && off <= sp.e);
                cells.push({
                    key: "p" + off,
                    label: this._planLabel(off),
                    tasks: hit.slice(0, 4).map(sp => sp.rec),
                    more: Math.max(0, hit.length - 4),
                });
            }
            rows.push({ key: "r" + base, days: cells });
        }
        return rows;
    }

    get weekdayLabels() {
        return ["日", "一", "二", "三", "四", "五", "六"];
    }

    // --- network / PERT view ------------------------------------------------

    /** Nodes laid out in dependency layers (longest-path depth). */
    get networkLayout() {
        const recs = this.records;
        const preds = this.props.model.data?.predecessors || [];
        const idSet = new Set(recs.map(r => r.id));
        // adjacency: parent_task_id -> [task_id]
        const succ = new Map();
        const indeg = new Map();
        for (const r of recs) indeg.set(r.id, 0);
        const taskField = this.props.archInfo.predecessorTaskId || "task_id";
        const parentField = this.props.archInfo.predecessorParentTaskId || "parent_task_id";
        const edges = [];
        for (const p of preds) {
            const from = Array.isArray(p[parentField]) ? p[parentField][0] : p[parentField];
            const to = Array.isArray(p[taskField]) ? p[taskField][0] : p[taskField];
            if (!idSet.has(from) || !idSet.has(to)) continue;
            if (!succ.has(from)) succ.set(from, []);
            succ.get(from).push(to);
            indeg.set(to, (indeg.get(to) || 0) + 1);
            edges.push({ from, to });
        }
        // longest-path layering via Kahn's algorithm
        const layer = new Map();
        const queue = [];
        for (const r of recs) {
            if ((indeg.get(r.id) || 0) === 0) { layer.set(r.id, 0); queue.push(r.id); }
        }
        const indegWork = new Map(indeg);
        while (queue.length) {
            const cur = queue.shift();
            for (const nxt of (succ.get(cur) || [])) {
                layer.set(nxt, Math.max(layer.get(nxt) || 0, (layer.get(cur) || 0) + 1));
                indegWork.set(nxt, indegWork.get(nxt) - 1);
                if (indegWork.get(nxt) === 0) queue.push(nxt);
            }
        }
        // assign positions per layer
        const NODE_W = 150, NODE_H = 56, GAP_X = 60, GAP_Y = 24;
        const byLayer = new Map();
        for (const r of recs) {
            const l = layer.get(r.id) || 0;
            if (!byLayer.has(l)) byLayer.set(l, []);
            byLayer.get(l).push(r);
        }
        const pos = new Map();
        const nodes = [];
        for (const [l, group] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
            group.forEach((r, i) => {
                const x = l * (NODE_W + GAP_X) + 20;
                const y = i * (NODE_H + GAP_Y) + 20;
                pos.set(r.id, { x, y });
                nodes.push({
                    id: r.id, name: this.recName(r), x, y, w: NODE_W, h: NODE_H,
                    critical: !!r[this.props.archInfo.criticalPath],
                    progress: Math.round(r._progress || 0),
                });
            });
        }
        const links = [];
        for (const e of edges) {
            const a = pos.get(e.from), b = pos.get(e.to);
            if (!a || !b) continue;
            links.push({
                x1: a.x + NODE_W, y1: a.y + NODE_H / 2,
                x2: b.x, y2: b.y + NODE_H / 2,
            });
        }
        const width = Math.max(...nodes.map(n => n.x + n.w), 200) + 40;
        const height = Math.max(...nodes.map(n => n.y + n.h), 200) + 40;
        return { nodes, links, width, height };
    }
}
