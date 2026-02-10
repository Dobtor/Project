/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { useService, useOwnedDialogs } from "@web/core/utils/hooks";
import { Layout } from "@web/search/layout";
import { useModel } from "@web/model/model";
import { standardViewProps } from "@web/views/standard_view_props";
import { FormViewDialog } from "@web/views/view_dialogs/form_view_dialog";

import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { Component, useState, useRef, onWillUnmount } from "@odoo/owl";

export class GanttController extends Component {
    static template = "dobtor_project.GanttController";
    static components = { Layout };

    static props = {
        ...standardViewProps,
        Model: Function,
        Renderer: Function,
        archInfo: Object,
        buttonTemplate: { type: String, optional: true },
    };

    setup() {
        this.action = useService("action");
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.rendererRef = useRef("renderer");
        this.displayDialog = useOwnedDialogs();

        // Use useModel - it automatically handles load on props change
        this.model = useModel(this.props.Model, {
            archInfo: this.props.archInfo,
            resModel: this.props.resModel,
            fields: this.props.fields,
        });

        // Restore persisted toolbar state from localStorage
        const savedScale = localStorage.getItem("gantt_scale") || "day";
        const savedSort = localStorage.getItem("gantt_sort_mode") || "seq";
        const savedWeekType = localStorage.getItem("gantt_week_type") || "iso";

        // Restore intersection toggle from localStorage
        const savedIntersection = localStorage.getItem("gantt_intersection") === "true";

        this.state = useState({
            scale: savedScale,
            isLoading: false,
            // Toolbar options (Round 2)
            sortMode: savedSort,       // "seq" | "start" | "name"
            weekType: savedWeekType,   // "iso" (Mon start) | "us" (Sun start)
            showListDetail: false,
            showIntersection: savedIntersection,
            // More menu dropdown (Phase 1)
            showMoreMenu: false,
            // Violation panel (Phase 2)
            showViolationPanel: false,
            violations: [],
            violationCount: 0,
            // Inspector panel (Phase 3A)
            showInspectorPanel: false,
            inspectorRecordId: null,
            // Baseline (Phase 3D)
            baselines: [],
            selectedBaselineId: null,
            // Filter (Phase 3D)
            filterCriticalPath: false,
            filterOverdue: false,
            filterUnlinked: false,
        });

        // Scale options — 8 zoom levels matching old module
        this.scales = [
            { value: "1h", label: _t("1H") },
            { value: "2h", label: _t("2H") },
            { value: "4h", label: _t("4H") },
            { value: "8h", label: _t("8H") },
            { value: "day", label: _t("Day") },
            { value: "week", label: _t("Week") },
            { value: "month", label: _t("Month") },
            { value: "quarter", label: _t("Quarter") },
        ];

        // Keyboard handler for Delete/Escape/Enter/Arrow navigation
        this._onKeyDown = this._onKeyDown.bind(this);
        document.addEventListener("keydown", this._onKeyDown);

        // Close More menu on click outside
        this._onClickOutside = (ev) => {
            if (this.state.showMoreMenu && !ev.target.closest(".o_gantt_more_menu_wrapper")) {
                this.state.showMoreMenu = false;
            }
        };
        document.addEventListener("click", this._onClickOutside, true);

        onWillUnmount(() => {
            document.removeEventListener("keydown", this._onKeyDown);
            document.removeEventListener("click", this._onClickOutside, true);
        });
    }

    get rendererProps() {
        return {
            model: this.model,
            archInfo: this.props.archInfo,
            onRecordClick: this.onRecordClick.bind(this),
            onAddTask: this.openNewTaskDialog.bind(this),
            onScrollToToday: this.scrollToToday.bind(this),
            scale: this.state.scale,
            sortMode: this.state.sortMode,
            weekType: this.state.weekType,
            showListDetail: this.state.showListDetail,
            showIntersection: this.state.showIntersection,
            showViolationPanel: this.state.showViolationPanel,
            violations: this.state.violations,
            onViolationClose: () => { this.state.showViolationPanel = false; },
            onViolationTaskClick: (taskId) => this.onViolationTaskClick(taskId),
            // Inspector (Phase 3A)
            showInspectorPanel: this.state.showInspectorPanel,
            inspectorRecordId: this.state.inspectorRecordId,
            onInspectorClose: () => this.onInspectorClose(),
            onInspectorFieldChange: async (rid, field, val) => this.onInspectorFieldChange(rid, field, val),
            onInspectorOpen: (recordId) => this.onInspectorToggle(recordId),
            // Filter (Phase 3D)
            filterCriticalPath: this.state.filterCriticalPath,
            filterOverdue: this.state.filterOverdue,
            filterUnlinked: this.state.filterUnlinked,
        };
    }

    get display() {
        return {
            controlPanel: {},
        };
    }

    get isLoading() {
        return this.state.isLoading;
    }

    get pagerText() {
        const records = this.model.data?.records;
        if (!records || records.length === 0) return "";
        const limit = this.props.archInfo.limitView || 250;
        if (records.length >= limit) {
            return `${records.length}+ records (limit: ${limit})`;
        }
        return `${records.length} records`;
    }

    // Button handlers
    onTodayClick() {
        // Find the today marker in the timeline and scroll to it
        const timeline = document.querySelector(".o_gantt_timeline");
        const todayMarker = document.querySelector(".o_gantt_today_marker");

        if (timeline && todayMarker) {
            const markerLeft = parseInt(todayMarker.style.left) || 0;
            const timelineWidth = timeline.clientWidth;
            // Center the today marker in the viewport
            timeline.scrollLeft = markerLeft - (timelineWidth / 2);
        }
    }

    scrollToToday() {
        this.onTodayClick();
    }

    onScaleChange(scale) {
        this.state.scale = scale;
        localStorage.setItem("gantt_scale", scale);
        if (this.model.setScale) {
            this.model.setScale(scale);
        }
    }

    async onSchedulerClick() {
        const projectId = this._getProjectIdFromContext();

        if (!projectId) {
            this.notification.add(
                _t("Please select a project first to run the scheduler."),
                { type: "warning" }
            );
            return;
        }

        this.state.isLoading = true;

        try {
            await this.orm.call(this.props.resModel, "scheduler_plan", [projectId]);
            await this._loadWithScrollRestore(this.props);
            this.notification.add(_t("Scheduler completed successfully."), { type: "success" });
        } catch (error) {
            console.error("Scheduler error:", error);
            this.notification.add(
                _t("Scheduler failed: ") + (error.message || "Unknown error"),
                { type: "danger" }
            );
        } finally {
            this.state.isLoading = false;
        }
    }

    /**
     * Wrap model.load() with scroll position save/restore so the viewport
     * does not jump back to the top-left corner after a data reload.
     */
    async _loadWithScrollRestore(loadProps) {
        const renderer = this.rendererRef?.comp;
        const scrollState = renderer?.saveScroll?.();
        await this.model.load(loadProps);
        renderer?.restoreScroll?.(scrollState);
    }

    _getProjectIdFromContext() {
        for (const condition of this.props.domain || []) {
            if (Array.isArray(condition) && condition[0] === "project_id" && condition[1] === "=") {
                return condition[2];
            }
        }
        return this.props.context?.default_project_id || this.props.context?.active_id || null;
    }

    async onRecordClick(record) {
        // Handle detail_plan action from context menu
        if (record.action === "detail_plan") {
            const loadBarModel = this.props.archInfo.loadBarModel;
            if (loadBarModel) {
                const loadIdField = this.props.archInfo.loadId || "task_id";
                await this.action.doAction({
                    type: "ir.actions.act_window",
                    name: _t("Detail Plans"),
                    res_model: loadBarModel,
                    views: [[false, "list"], [false, "form"]],
                    domain: [[loadIdField, "=", record.id]],
                    target: "current",
                });
                return;
            }
        }

        // Handle delete action from context menu
        if (record.action === "delete") {
            const rec = this.model.data?.records?.find(r => r.id === record.id);
            const name = rec?.display_name || `Task #${record.id}`;
            this.displayDialog(ConfirmationDialog, {
                body: _t("Delete \"%s\"?", name),
                confirm: async () => {
                    await this.model.deleteRecord(record.id);
                    const renderer = this.rendererRef?.comp;
                    if (renderer) renderer.state.selectedRowId = null;
                },
            });
            return;
        }

        this.displayDialog(
            FormViewDialog,
            {
                resModel: this.props.resModel,
                resId: record.id,
                title: record.display_name || _t("Task"),
                onRecordSaved: async () => {
                    await this._loadWithScrollRestore(this.props);
                },
            },
        );
    }

    openNewTaskDialog(defaults = {}) {
        this.displayDialog(
            FormViewDialog,
            {
                resModel: this.props.resModel,
                context: { ...this.props.context, ...defaults },
                title: _t("New Task"),
                onRecordSaved: async () => {
                    await this._loadWithScrollRestore(this.props);
                },
            },
        );
    }

    onExpandAll() {
        if (this.model.expandAllGroups) {
            this.model.expandAllGroups();
        }
    }

    onCollapseAll() {
        if (this.model.collapseAllGroups) {
            this.model.collapseAllGroups();
        }
    }

    async onRefresh() {
        this.state.isLoading = true;
        try {
            await this._loadWithScrollRestore(this.props);
        } finally {
            this.state.isLoading = false;
        }
    }

    // -------------------------------------------------------------------------
    // Toolbar Options (Round 2)
    // -------------------------------------------------------------------------

    onSortToggle() {
        const modes = ["seq", "start", "name"];
        const idx = modes.indexOf(this.state.sortMode);
        this.state.sortMode = modes[(idx + 1) % modes.length];
        localStorage.setItem("gantt_sort_mode", this.state.sortMode);
        // Trigger re-sort in model
        if (this.model.setSortMode) {
            this.model.setSortMode(this.state.sortMode);
        }
    }

    get sortLabel() {
        const labels = { seq: "Seq", start: "Start", name: "Name" };
        return labels[this.state.sortMode] || "Seq";
    }

    onWeekTypeToggle() {
        this.state.weekType = this.state.weekType === "iso" ? "us" : "iso";
        localStorage.setItem("gantt_week_type", this.state.weekType);
    }

    get weekTypeLabel() {
        return this.state.weekType === "iso" ? "Mon" : "Sun";
    }

    onListDetailToggle() {
        this.state.showListDetail = !this.state.showListDetail;
    }

    onIntersectionToggle() {
        this.state.showIntersection = !this.state.showIntersection;
        localStorage.setItem("gantt_intersection", this.state.showIntersection);
    }

    // "More" dropdown menu toggle
    async onMoreMenuToggle() {
        this.state.showMoreMenu = !this.state.showMoreMenu;
        if (this.state.showMoreMenu) {
            await this.loadBaselines();
        }
    }

    onMoreMenuClose() {
        this.state.showMoreMenu = false;
    }

    // -------------------------------------------------------------------------
    // Round 3 Features
    // -------------------------------------------------------------------------

    // Feature 14: Editable pager — navigate to page
    onPagerClick() {
        const currentLimit = this.props.archInfo.limitView || 250;
        const total = this.model.data?.records?.length || 0;
        // Toggle limit between 250/500/1000/all
        const nextLimits = [250, 500, 1000, 5000];
        const idx = nextLimits.indexOf(currentLimit);
        const newLimit = nextLimits[(idx + 1) % nextLimits.length];
        this.props.archInfo.limitView = newLimit;
        this.onRefresh();
    }

    // Feature 22: Fast refresh — incremental update without full reload
    async onFastRefresh() {
        if (!this.model.data?.records?.length) {
            return this.onRefresh();
        }

        this.state.isLoading = true;
        try {
            // Only reload records that were recently modified (last 5 min)
            const recentDomain = [
                ...this.props.domain || [],
                ["write_date", ">=", new Date(Date.now() - 5 * 60 * 1000).toISOString()],
            ];
            await this._loadWithScrollRestore({
                ...this.props,
                domain: recentDomain,
            });
        } catch {
            // Fallback to full reload
            await this._loadWithScrollRestore(this.props);
        } finally {
            this.state.isLoading = false;
        }
    }

    // Print / PDF Report buttons
    onPrintClick() {
        // Expand all groups before printing
        if (this.model.expandAllGroups) {
            this.model.expandAllGroups();
        }
        setTimeout(() => window.print(), 300);
    }

    async onReportClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(
                _t("Please select a project first."),
                { type: "warning" }
            );
            return;
        }
        await this.action.doAction({
            type: "ir.actions.report",
            report_type: "qweb-pdf",
            report_name: "dobtor_project.gantt_report",
            report_file: "dobtor_project.gantt_report",
            data: { project_id: projectId },
        });
    }

    // Export/Import toolbar buttons
    async onExportClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(
                _t("Please select a project first to export."),
                { type: "warning" }
            );
            return;
        }

        try {
            const ids = await this.orm.create("project.exchange", [{ project_id: projectId }]);
            await this.action.doAction({
                type: "ir.actions.act_window",
                name: _t("Export Project (XML)"),
                res_model: "project.exchange",
                res_id: ids[0],
                views: [[false, "form"]],
                target: "new",
            });
        } catch (error) {
            console.error("Export error:", error);
            this.notification.add(
                _t("Failed to open export wizard."),
                { type: "danger" }
            );
        }
    }

    async onImportClick() {
        await this.action.doAction({
            type: "ir.actions.act_window",
            name: _t("Import Project (XML)"),
            res_model: "project.exchange.import",
            views: [[false, "form"]],
            target: "new",
        });
    }

    // -------------------------------------------------------------------------
    // Keyboard Handler (Delete/Escape/Enter/Arrow)
    // -------------------------------------------------------------------------

    async _onKeyDown(ev) {
        // Only act when Gantt view is focused (not inside input/dialog)
        if (ev.target.closest("input, textarea, [contenteditable], .modal")) return;

        const renderer = this.rendererRef?.comp;
        const selectedId = renderer?.state?.selectedRowId;

        if (ev.key === "Delete" && selectedId) {
            ev.preventDefault();
            const record = this.model.data?.records?.find(r => r.id === selectedId);
            const name = record?.display_name || `Task #${selectedId}`;
            this.displayDialog(ConfirmationDialog, {
                body: _t("Delete \"%s\"?", name),
                confirm: async () => {
                    await this.model.deleteRecord(selectedId);
                    if (renderer) renderer.state.selectedRowId = null;
                },
            });
        }

        if (ev.key === "Escape") {
            if (renderer) renderer.state.selectedRowId = null;
        }

        if (ev.key === "Enter" && selectedId) {
            ev.preventDefault();
            const record = this.model.data?.records?.find(r => r.id === selectedId);
            if (record) {
                this.onRecordClick(record);
            }
        }

        if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && renderer) {
            ev.preventDefault();
            const rows = renderer.flattenedRows.filter(r => !r._isGroup);
            if (!rows.length) return;
            const currentIdx = rows.findIndex(r => r.id === selectedId);
            let nextIdx;
            if (ev.key === "ArrowDown") {
                nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, rows.length - 1);
            } else {
                nextIdx = currentIdx < 0 ? 0 : Math.max(currentIdx - 1, 0);
            }
            renderer.state.selectedRowId = rows[nextIdx].id;
        }
    }

    // -------------------------------------------------------------------------
    // Phase 2: Catch Up / Reschedule
    // -------------------------------------------------------------------------

    async onCatchUpClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(_t("Please select a project first."), { type: "warning" });
            return;
        }
        this.displayDialog(ConfirmationDialog, {
            body: _t("Update task progress based on today's date and re-schedule?"),
            confirm: async () => {
                this.state.isLoading = true;
                try {
                    await this.model.catchUp(projectId);
                    await this._loadWithScrollRestore(this.props);
                    this.notification.add(_t("Catch up completed."), { type: "success" });
                } catch (e) {
                    this.notification.add(_t("Catch up failed: ") + e.message, { type: "danger" });
                } finally {
                    this.state.isLoading = false;
                }
            },
        });
    }

    async onRescheduleClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(_t("Please select a project first."), { type: "warning" });
            return;
        }
        this.displayDialog(ConfirmationDialog, {
            body: _t("Move remaining work of overdue tasks to today and re-schedule?"),
            confirm: async () => {
                this.state.isLoading = true;
                try {
                    await this.model.rescheduleIncomplete(projectId);
                    await this._loadWithScrollRestore(this.props);
                    this.notification.add(_t("Reschedule completed."), { type: "success" });
                } catch (e) {
                    this.notification.add(_t("Reschedule failed: ") + e.message, { type: "danger" });
                } finally {
                    this.state.isLoading = false;
                }
            },
        });
    }

    // -------------------------------------------------------------------------
    // Phase 2: Violation Panel
    // -------------------------------------------------------------------------

    async onViolationToggle() {
        // Mutual exclusion with inspector panel
        if (this.state.showInspectorPanel) {
            this.state.showInspectorPanel = false;
            this.state.inspectorRecordId = null;
        }
        this.state.showViolationPanel = !this.state.showViolationPanel;
        if (this.state.showViolationPanel) {
            await this.loadViolations();
        }
    }

    async loadViolations() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) return;
        const violations = await this.model.loadViolations(projectId);
        this.state.violations = violations;
        this.state.violationCount = violations.length;
    }

    onViolationTaskClick(taskId) {
        const renderer = this.rendererRef?.comp;
        if (renderer) {
            renderer.state.selectedRowId = taskId;
            renderer.scrollToRecord(taskId);
        }
    }

    // -------------------------------------------------------------------------
    // Phase 3A: Inspector Panel
    // -------------------------------------------------------------------------

    onInspectorToggle(recordId) {
        if (this.state.showViolationPanel) {
            this.state.showViolationPanel = false;
        }
        if (this.state.inspectorRecordId === recordId && this.state.showInspectorPanel) {
            this.state.showInspectorPanel = false;
            this.state.inspectorRecordId = null;
        } else {
            this.state.inspectorRecordId = recordId;
            this.state.showInspectorPanel = true;
        }
    }

    onInspectorClose() {
        this.state.showInspectorPanel = false;
        this.state.inspectorRecordId = null;
    }

    async onInspectorFieldChange(recordId, fieldName, newValue) {
        await this.model.updateRecord(recordId, { [fieldName]: newValue });
        await this._loadWithScrollRestore(this.props);
    }

    // -------------------------------------------------------------------------
    // Phase 3B: Level Resources
    // -------------------------------------------------------------------------

    async onLevelResourcesClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(_t("Please select a project first."), { type: "warning" });
            return;
        }
        this.displayDialog(ConfirmationDialog, {
            body: _t("Level resources? Non-critical tasks will be delayed to resolve conflicts."),
            confirm: async () => {
                this.state.isLoading = true;
                try {
                    const count = await this.model.levelResources(projectId);
                    await this._loadWithScrollRestore(this.props);
                    this.notification.add(
                        count > 0 ? _t("%s tasks adjusted.", count) : _t("No conflicts found."),
                        { type: count > 0 ? "success" : "info" }
                    );
                } catch (e) {
                    this.notification.add(_t("Leveling failed: ") + e.message, { type: "danger" });
                } finally {
                    this.state.isLoading = false;
                }
            },
        });
    }

    // -------------------------------------------------------------------------
    // Phase 3D: Baseline + Filter
    // -------------------------------------------------------------------------

    async onSaveBaselineClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) return;
        this.state.isLoading = true;
        try {
            const result = await this.model.saveBaseline(projectId);
            this.notification.add(_t("Baseline saved: %s", result.name), { type: "success" });
            this.state.baselines = await this.model.getBaselines(projectId);
        } finally {
            this.state.isLoading = false;
        }
    }

    async onBaselineSelect(baselineId) {
        this.state.selectedBaselineId = baselineId;
        await this.model.loadBaselineAsGhosts(baselineId);
    }

    onBaselineClear() {
        this.state.selectedBaselineId = null;
        this.model.data.ghostBars = [];
        this.model.notify();
    }

    onFilterToggle(filterName) {
        this.state[filterName] = !this.state[filterName];
    }

    async loadBaselines() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) return;
        this.state.baselines = await this.model.getBaselines(projectId);
    }

    // Feature 20: Detail plan stat button — open detail plans for selected task
    async onDetailPlanClick() {
        const selectedId = this.rendererRef?.comp?.state?.selectedRowId;
        if (!selectedId) {
            this.notification.add(_t("Please select a task first."), { type: "info" });
            return;
        }

        const loadBarModel = this.props.archInfo.loadBarModel;
        if (!loadBarModel) {
            this.notification.add(_t("No detail plan model configured."), { type: "warning" });
            return;
        }

        const loadIdField = this.props.archInfo.loadId || "task_id";
        await this.action.doAction({
            type: "ir.actions.act_window",
            name: _t("Detail Plans"),
            res_model: loadBarModel,
            views: [[false, "list"], [false, "form"]],
            domain: [[loadIdField, "=", selectedId]],
            target: "current",
        });
    }
}
