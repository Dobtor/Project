/** @odoo-module **/
import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { DateTimeInput } from "@web/core/datetime/datetime_input";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { serializeDateTime } from "@web/core/l10n/dates";
import { parseLagInput, hoursToInputFormat, humanizeHours } from "./gantt_utils";
import { GANTT_COLORS } from "./gantt_colors";

// Re-exported: several modules already import the palette from here.
export { GANTT_COLORS };

// Kanban-consistent 12 fixed colors (index 0-11)

export function getGanttColorNames() {
    return [
        _t("無顏色"),    // 0
        _t("紅色"),      // 1
        _t("橘色"),      // 2
        _t("黃色"),      // 3
        _t("青色"),      // 4
        _t("紫色"),      // 5
        _t("杏色"),      // 6
        _t("藍綠色"),    // 7
        _t("藍色"),      // 8
        _t("莓紅色"),    // 9
        _t("綠色"),      // 10
        _t("紫羅蘭色"),  // 11
    ];
}

export class GanttInspector extends Component {
    static template = "dobtor_project.GanttInspector";
    static components = { DateTimeInput };
    static props = {
        visible: Boolean,
        record: { optional: true },
        archInfo: Object,
        predecessors: { type: Array, optional: true },
        isPlanningMode: { type: Boolean, optional: true },
        onClose: Function,
        onFieldChange: Function,
        onOpenForm: Function,
        onDetailPlan: { type: Function, optional: true },
        onDeletePredecessor: { type: Function, optional: true },
        onUpdatePredecessor: { type: Function, optional: true },
        milestoneLinkedTasks: { type: Array, optional: true },
        onRemoveMilestoneLink: { type: Function, optional: true },
        calendarInfo: { optional: true },
    };

    static defaultProps = {
        isPlanningMode: false,
    };

    setup() {
        this.orm = useService("orm");
        this.state = useState({
            expandedSections: {
                general: true,
                schedule: true,
                resources: false,
                predecessors: true,
                milestoneLinks: true,
            },
            editingLagPredId: null,
            userQuery: "",
            userResults: [],
            showUserDropdown: false,
        });
        this._userNames = {};  // { userId: displayName } cache

        onWillStart(async () => {
            await this._loadUserNames(this.props.record);
        });

        onWillUpdateProps(async (nextProps) => {
            await this._loadUserNames(nextProps.record);
        });
    }

    // -------------------------------------------------------------------------
    // User Picker (受指派人)
    // -------------------------------------------------------------------------

    async _loadUserNames(record) {
        if (!record) return;
        const userField = this.props.archInfo.userId || "user_ids";
        const raw = record[userField];
        if (!raw || !raw.length) return;
        // Extract integer IDs: handle both plain [id, ...] and M2M commands [[6, 0, [ids]]]
        const ids = [];
        for (const item of raw) {
            if (typeof item === "number" && Number.isInteger(item) && item > 0) {
                ids.push(item);
            } else if (Array.isArray(item) && item[0] === 6 && Array.isArray(item[2])) {
                // (6, 0, [ids]) replace command
                ids.push(...item[2].filter(id => typeof id === "number" && id > 0));
            } else if (Array.isArray(item) && item[0] === 4 && typeof item[1] === "number") {
                // (4, id) link command
                ids.push(item[1]);
            }
        }
        if (!ids.length) return;
        const missingIds = ids.filter((id) => !(id in this._userNames));
        if (!missingIds.length) return;
        const results = await this.orm.read("res.users", missingIds, ["display_name"]);
        for (const r of results) {
            this._userNames[r.id] = r.display_name;
        }
    }

    get userChips() {
        if (!this.props.record) return [];
        const userField = this.props.archInfo.userId || "user_ids";
        const ids = (this.props.record[userField] || []).filter((id) => id);
        return ids.map((id) => ({ id, name: this._userNames[id] || `#${id}` }));
    }

    async onUserSearchInput(ev) {
        const query = ev.target.value;
        this.state.userQuery = query;
        if (!query.trim()) {
            this.state.userResults = [];
            this.state.showUserDropdown = false;
            return;
        }
        const userField = this.props.archInfo.userId || "user_ids";
        const currentIds = this.props.record[userField] || [];
        const domain = [
            ["share", "=", false],
            ["active", "=", true],
            ["id", "not in", currentIds],
        ];
        const results = await this.orm.call("res.users", "name_search", [], {
            name: query,
            args: domain,
            limit: 8,
        });
        this.state.userResults = results;
        this.state.showUserDropdown = results.length > 0;
    }

    onUserSelect(userId, displayName) {
        if (!this.props.record) return;
        this._userNames[userId] = displayName;
        const userField = this.props.archInfo.userId || "user_ids";
        const currentIds = this.props.record[userField] || [];
        const newIds = [...currentIds, userId];
        this.state.userQuery = "";
        this.state.userResults = [];
        this.state.showUserDropdown = false;
        this.props.onFieldChange(this.props.record.id, userField, [[6, 0, newIds]]);
    }

    onUserRemove(userId) {
        if (!this.props.record) return;
        const userField = this.props.archInfo.userId || "user_ids";
        const currentIds = this.props.record[userField] || [];
        const newIds = currentIds.filter((id) => id !== userId);
        this.props.onFieldChange(this.props.record.id, userField, [[6, 0, newIds]]);
    }

    onUserInputFocus() {
        if (this.state.userResults.length) {
            this.state.showUserDropdown = true;
        }
    }

    onUserInputBlur() {
        setTimeout(() => {
            this.state.showUserDropdown = false;
        }, 200);
    }

    toggleSection(name) {
        this.state.expandedSections[name] = !this.state.expandedSections[name];
    }

    onFieldBlur(fieldName, ev) {
        if (!this.props.record) return;
        this.props.onFieldChange(this.props.record.id, fieldName, ev.target.value);
    }

    onDateTimeApply(fieldName, dt) {
        if (!this.props.record) return;
        const value = dt ? serializeDateTime(dt) : false;
        this.props.onFieldChange(this.props.record.id, fieldName, value);
    }

    onSelectChange(fieldName, ev) {
        if (!this.props.record) return;
        this.props.onFieldChange(this.props.record.id, fieldName, ev.target.value);
    }

    onCheckboxChange(fieldName, ev) {
        if (!this.props.record) return;
        this.props.onFieldChange(this.props.record.id, fieldName, ev.target.checked);
    }

    onProgressChange(ev) {
        if (!this.props.record) return;
        if (this.props.record._progressMode === 'timesheet') return;
        const val = Math.min(100, Math.max(0, parseInt(ev.target.value, 10) || 0));
        const progressField = this.props.archInfo.progress || "progress";
        this.props.onFieldChange(this.props.record.id, progressField, val);
    }

    onColorSelect(colorIndex) {
        if (!this.props.record) return;
        const colorField = this.props.archInfo.colorGantt || "color_gantt";
        this.props.onFieldChange(this.props.record.id, colorField, colorIndex);
    }

    get currentColorIndex() {
        if (!this.props.record) return 0;
        const colorField = this.props.archInfo.colorGantt || "color_gantt";
        return this.props.record[colorField] || 0;
    }

    /**
     * The swatches, in the order they are OFFERED: the colours first, "no
     * colour" last, because it is the fallback rather than the first choice.
     *
     * `index` stays the stored value of color_gantt — 0 is still "no colour" —
     * so reordering the picker changes nothing about existing data.
     *
     * Each swatch carries its own inline style. It used to get its colour from
     * a .o_gantt_color_N rule fed by --gantt-palette-N variables the renderer
     * published on mount; that whole loop was deleted as dead code (nothing
     * SEEMED to apply those classes — the template composes them with QWeb's
     * #{} interpolation, which the scan did not recognise) and the swatches went
     * blank. Drawing from GANTT_COLORS directly is what the bars already do, and
     * leaves nothing to go stale.
     */
    get ganttColorSwatches() {
        const swatches = [];
        for (let i = 1; i < GANTT_COLORS.length; i++) {
            swatches.push({
                index: i,
                style: `background:${GANTT_COLORS[i]};`,
                cls: "",
                name: this.ganttColorName(i),
            });
        }
        // "No colour" keeps its striped design, which cannot be an inline style
        // (an inline background would win over the gradient), so it carries a
        // class instead — keyed on what it IS, not on where it sits.
        swatches.push({ index: 0, style: "", cls: "o_gantt_color_none",
                        name: this.ganttColorName(0) });
        return swatches;
    }

    ganttColorName(index) {
        return getGanttColorNames()[index] || "";
    }

    get fixedCalcTypeLabel() {
        if (!this.props.record) return "";
        const field = this.props.archInfo.fixedCalcType || "fixed_calc_type";
        const val = this.props.record[field];
        const labels = { duration: _t("工期"), work: _t("工時") };
        return labels[val] || "";
    }

    get isMilestoneRecord() {
        return this.props.record && this.props.record._isMilestoneRecord;
    }

    get calendarActive() {
        return !!this.props.calendarInfo;
    }

    get workingDurationLabel() {
        if (!this.props.record || !this.props.calendarInfo) return "";
        const rec = this.props.record;
        // Same authority order as the gantt's duration column: a summary row
        // shows the roll-up of its leaves, a leaf shows the hours that were
        // scheduled for it — never a measurement of where it happens to sit.
        const twhField = this.props.archInfo.totalWorkHours || "total_work_hours";
        const field = this.props.archInfo.workingDuration || "working_duration";
        const hours = rec._hasChildren
            ? rec[twhField]
            : (rec._planDuration || rec[field]);
        if (!hours) return "";
        const hpd = this.props.calendarInfo.hours_per_day || 8;
        const ws = this.props.calendarInfo._workingWeekdays;
        const dpw = (ws && ws.size > 0) ? ws.size : 7;
        return humanizeHours(hours, hpd, dpw);
    }

    onMilestoneReachedChange(ev) {
        if (!this.props.record) return;
        this.props.onFieldChange(this.props.record.id, "is_reached", ev.target.checked);
    }

    onDetailPlanClick() {
        if (this.props.onDetailPlan && this.props.record) {
            this.props.onDetailPlan(this.props.record.id);
        }
    }

    lagDisplayLabel(pred) {
        const hpd = this.props.calendarInfo?.hours_per_day || 24;
        const ws = this.props.calendarInfo?._workingWeekdays;
        const dpw = (ws && ws.size > 0) ? ws.size : 7;
        return humanizeHours(pred.lag_hours, hpd, dpw);
    }

    lagInputValue(pred) {
        const hpd = this.props.calendarInfo?.hours_per_day || 24;
        return hoursToInputFormat(pred.lag_hours, hpd);
    }

    isEditingLag(pred) {
        return this.state.editingLagPredId === pred._predIdentifier;
    }

    onLagDisplayClick(pred) {
        this.state.editingLagPredId = pred._predIdentifier;
        // Auto-focus input on next tick after OWL re-renders
        requestAnimationFrame(() => {
            const el = document.querySelector(".o_gantt_inspector_lag_input");
            if (el) { el.focus(); el.select(); }
        });
    }

    onLagInputBlur(pred, ev) {
        this.state.editingLagPredId = null;
        if (!this.props.onUpdatePredecessor) return;
        const hpd = this.props.calendarInfo?.hours_per_day || 24;
        const ws = this.props.calendarInfo?._workingWeekdays;
        const dpw = (ws && ws.size > 0) ? ws.size : 7;
        const hours = parseLagInput(ev.target.value, hpd, dpw);
        if (hours !== (pred.lag_hours || 0)) {
            this.props.onUpdatePredecessor(pred._predIdentifier, { lag_hours: hours });
        }
    }

    onLagInputKeydown(pred, ev) {
        if (ev.key === "Enter" && !ev.isComposing) {
            ev.preventDefault();
            ev.target.blur();
        } else if (ev.key === "Escape") {
            this.state.editingLagPredId = null;
        }
    }
}
