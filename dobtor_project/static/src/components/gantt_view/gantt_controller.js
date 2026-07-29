/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { useBus, useService, useOwnedDialogs } from "@web/core/utils/hooks";
import { Layout } from "@web/search/layout";
import { SearchBar } from "@web/search/search_bar/search_bar";
import { useSearchBarToggler } from "@web/search/search_bar/search_bar_toggler";
import { CogMenu } from "@web/search/cog_menu/cog_menu";
import { useModel } from "@web/model/model";
import { standardViewProps } from "@web/views/standard_view_props";
import { FormViewDialog } from "@web/views/view_dialogs/form_view_dialog";

import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { Component, useState, onWillUnmount } from "@odoo/owl";

export class GanttController extends Component {
    static template = "dobtor_project.GanttController";
    static components = { Layout, SearchBar, CogMenu };

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
        this._rendererApi = null;
        this.displayDialog = useOwnedDialogs();

        // Use useModel - it automatically handles load on props change
        this.model = useModel(this.props.Model, {
            archInfo: this.props.archInfo,
            resModel: this.props.resModel,
            fields: this.props.fields,
        });

        // useModel doesn't subscribe to model.notify() — add explicit subscription
        // so in-place mutations (toggleGroup, toggleTaskFold, rename, etc.) trigger re-render.
        useBus(this.model.bus, "update", () => this.render(true));

        // SearchBar toggler for responsive search
        this.searchBarToggler = useSearchBarToggler();

        // Restore persisted toolbar state from localStorage
        const savedScale = localStorage.getItem("gantt_scale") || "day";
        const savedSort = localStorage.getItem("gantt_sort_mode") || "seq";
        const savedWeekType = localStorage.getItem("gantt_week_type") || "iso";

        // Restore intersection toggle from localStorage
        const savedIntersection = localStorage.getItem("gantt_intersection") === "true";
        const savedHideNonWorking = localStorage.getItem("gantt_hide_non_working") === "true";

        this.state = useState({
            scale: savedScale,
            isLoading: false,
            // Toolbar options (Round 2)
            sortMode: savedSort,       // "seq" | "start" | "name"
            weekType: savedWeekType,   // "iso" (Mon start) | "us" (Sun start)
            showListDetail: false,
            showIntersection: savedIntersection,
            // Scale & Baseline dropdown menus
            showScaleMenu: false,
            showBaselineMenu: false,
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
            // Calendar: hide non-working days
            hideNonWorkingDays: savedHideNonWorking,
        });

        // Scale options — 8 zoom levels matching old module
        this.scales = [
            { value: "1h", label: _t("1\u6642") },
            { value: "2h", label: _t("2\u6642") },
            { value: "4h", label: _t("4\u6642") },
            { value: "8h", label: _t("8\u6642") },
            { value: "day", label: _t("\u65E5") },
            { value: "week", label: _t("\u9031") },
            { value: "month", label: _t("\u6708") },
        ];

        // Keyboard handler for Delete/Escape/Enter/Arrow navigation
        this._onKeyDown = this._onKeyDown.bind(this);
        document.addEventListener("keydown", this._onKeyDown);

        // Close dropdown menus on click outside
        this._onClickOutside = (ev) => {
            if (this.state.showScaleMenu && !ev.target.closest(".o_gantt_tb_scale_dropdown")) {
                this.state.showScaleMenu = false;
            }
            if (this.state.showBaselineMenu && !ev.target.closest(".o_gantt_tb_baseline_dropdown")) {
                this.state.showBaselineMenu = false;
            }
        };
        document.addEventListener("click", this._onClickOutside, true);

        onWillUnmount(() => {
            document.removeEventListener("keydown", this._onKeyDown);
            document.removeEventListener("click", this._onClickOutside, true);
            clearTimeout(this._printTimeout);
        });
    }

    get rendererProps() {
        return {
            onRendererReady: (api) => {
                this._rendererApi = api;
            },
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
            // Reload callback (uses controller's props with proper domain/context)
            onReload: () => this._loadWithScrollRestore(this.props),
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
            // PDF report
            onReportClick: this.onReportClick.bind(this),
            // Calendar
            hideNonWorkingDays: this.state.hideNonWorkingDays,
        };
    }

    get display() {
        return {
            ...this.props.display,
            controlPanel: {
                ...this.props.display?.controlPanel,
            },
        };
    }

    get isLoading() {
        return this.state.isLoading;
    }

    get isPlanningMode() {
        const groups = this.model.data?.groups || [];
        return groups.length > 0 && groups.every(g => g._isPlanningMode);
    }

    get pagerText() {
        const records = this.model.data?.records;
        if (!records || records.length === 0) return "";
        const limit = this.props.archInfo.limitView || 250;
        if (records.length >= limit) {
            return _t("%(count)s+ 筆 (上限: %(limit)s)", { count: records.length, limit });
        }
        return _t("%(count)s 筆", { count: records.length });
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

    async onCompactLeftClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(_t("請先選擇專案。"), { type: "warning" });
            return;
        }
        this.state.isLoading = true;
        try {
            await this.model.compactLeft(projectId);
            await this._loadWithScrollRestore(this.props);
            this.notification.add(_t("壓縮完成。"), { type: "success" });
        } catch (error) {
            this.notification.add(
                _t("壓縮失敗: %(error)s", { error: error.message || "" }),
                { type: "danger" }
            );
        } finally {
            this.state.isLoading = false;
        }
    }

    async onSchedulerClick() {
        const projectId = this._getProjectIdFromContext();

        if (!projectId) {
            this.notification.add(
                _t("請先選擇專案以執行排程器。"),
                { type: "warning" }
            );
            return;
        }

        this.state.isLoading = true;

        try {
            await this.orm.call(this.props.resModel, "scheduler_plan", [projectId]);
            await this._loadWithScrollRestore(this.props);
            this.notification.add(_t("排程完成。"), { type: "success" });
        } catch (error) {
            console.error("Scheduler error:", error);
            this.notification.add(
                _t("排程失敗: %(error)s", { error: error.message || _t("未知錯誤") }),
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
        const scrollState = this._rendererApi?.saveScroll?.();
        await this.model.load(loadProps);
        this._rendererApi?.restoreScroll?.(scrollState);
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
                    name: _t("細節計畫"),
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
            const rec = this.model.getRecord(record.id);
            const name = rec?.display_name || `\u4EFB\u52D9 #${record.id}`;
            this.displayDialog(ConfirmationDialog, {
                body: _t("\u522A\u9664\u300C%(name)s\u300D\uFF1F", { name }),
                confirm: async () => {
                    await this.model.deleteRecord(record.id);
                    this._rendererApi?.setSelectedRowId?.(null);
                },
                dismiss: () => {},
            });
            return;
        }

        // Handle duplicate action from context menu
        if (record.action === "duplicate") {
            try {
                // orm.call("copy") returns the new record ID (integer)
                await this.orm.call(this.props.resModel, "copy", [record.id]);
                await this._loadWithScrollRestore(this.props);
                this.notification.add(_t("任務已複製。"), { type: "success" });
            } catch (e) {
                this.notification.add(_t("複製失敗: %(error)s", { error: e.message || "" }), { type: "danger" });
            }
            return;
        }

        // Milestone records use negative IDs → open project.milestone form
        const isMilestone = record._isMilestoneRecord || record.id < 0;
        const resModel = isMilestone ? "project.milestone" : this.props.resModel;
        const resId = isMilestone ? Math.abs(record.id) : record.id;

        this.displayDialog(
            FormViewDialog,
            {
                resModel,
                resId,
                title: record.display_name || (isMilestone ? _t("里程碑") : _t("任務")),
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
                title: _t("新增任務"),
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
        const labels = { seq: _t("序號"), start: _t("開始"), name: _t("名稱") };
        return labels[this.state.sortMode] || _t("序號");
    }

    get currentScaleLabel() {
        const found = this.scales.find(s => s.value === this.state.scale);
        return found ? found.label : this.state.scale;
    }

    onWeekTypeToggle() {
        this.state.weekType = this.state.weekType === "iso" ? "us" : "iso";
        localStorage.setItem("gantt_week_type", this.state.weekType);
    }

    get weekTypeLabel() {
        return this.state.weekType === "iso" ? _t("週一") : _t("週日");
    }

    onListDetailToggle() {
        this.state.showListDetail = !this.state.showListDetail;
    }

    onIntersectionToggle() {
        this.state.showIntersection = !this.state.showIntersection;
        localStorage.setItem("gantt_intersection", this.state.showIntersection);
    }

    onHideNonWorkingDaysToggle() {
        this.state.hideNonWorkingDays = !this.state.hideNonWorkingDays;
        localStorage.setItem("gantt_hide_non_working", this.state.hideNonWorkingDays);
    }

    onScaleMenuToggle() {
        this.state.showScaleMenu = !this.state.showScaleMenu;
        this.state.showBaselineMenu = false;
    }

    async onBaselineMenuToggle() {
        this.state.showBaselineMenu = !this.state.showBaselineMenu;
        this.state.showScaleMenu = false;
        if (this.state.showBaselineMenu) {
            await this.loadBaselines();
        }
    }

    // -------------------------------------------------------------------------
    // Batch Operations (multi-select)
    // -------------------------------------------------------------------------

    _getSelectedIds() {
        const api = this._rendererApi;
        const multiIds = api?.getSelectedRowIds?.();
        const keys = multiIds ? Object.keys(multiIds).map(Number) : [];
        if (keys.length > 0) return keys;
        const singleId = api?.getSelectedRowId?.();
        return singleId ? [singleId] : [];
    }

    async onBatchSetAuto() {
        const ids = this._getSelectedIds();
        if (!ids.length) {
            this.notification.add(_t("\u8ACB\u5148\u9078\u64C7\u4EFB\u52D9"), { type: "warning" });
            return;
        }
        const field = this.props.archInfo.scheduleMode || "schedule_mode";
        await this.orm.write(this.props.resModel, ids, { [field]: "auto" });
        await this._loadWithScrollRestore(this.props);
        this.notification.add(_t("\u5DF2\u5C07 %(count)s \u7B46\u4EFB\u52D9\u8A2D\u70BA\u81EA\u52D5\u6392\u7A0B", { count: ids.length }), { type: "success" });
    }

    async onBatchSetManual() {
        const ids = this._getSelectedIds();
        if (!ids.length) {
            this.notification.add(_t("\u8ACB\u5148\u9078\u64C7\u4EFB\u52D9"), { type: "warning" });
            return;
        }
        const field = this.props.archInfo.scheduleMode || "schedule_mode";
        await this.orm.write(this.props.resModel, ids, { [field]: "manual" });
        await this._loadWithScrollRestore(this.props);
        this.notification.add(_t("\u5DF2\u5C07 %(count)s \u7B46\u4EFB\u52D9\u8A2D\u70BA\u624B\u52D5\u6392\u7A0B", { count: ids.length }), { type: "success" });
    }

    async onBatchRemoveConstraints() {
        const ids = this._getSelectedIds();
        if (!ids.length) {
            this.notification.add(_t("\u8ACB\u5148\u9078\u64C7\u4EFB\u52D9"), { type: "warning" });
            return;
        }
        const typeField = this.props.archInfo.constrainType || "constrain_type";
        const dateField = this.props.archInfo.constrainDate || "constrain_date";
        await this.orm.write(this.props.resModel, ids, { [typeField]: "asap", [dateField]: false });
        await this._loadWithScrollRestore(this.props);
        this.notification.add(_t("\u5DF2\u79FB\u9664 %(count)s \u7B46\u4EFB\u52D9\u7684\u9650\u5236", { count: ids.length }), { type: "success" });
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

    // Print / PDF Report buttons
    onPrintClick() {
        // Expand all groups before printing
        if (this.model.expandAllGroups) {
            this.model.expandAllGroups();
        }
        this._printTimeout = setTimeout(() => window.print(), 300);
    }

    async onReportClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(
                _t("請先選擇專案。"),
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
                _t("請先選擇專案以匯出。"),
                { type: "warning" }
            );
            return;
        }

        try {
            const ids = await this.orm.create("project.exchange", [{ project_id: projectId }]);
            await this.action.doAction({
                type: "ir.actions.act_window",
                name: _t("匯出專案 (XML)"),
                res_model: "project.exchange",
                res_id: ids[0],
                views: [[false, "form"]],
                target: "new",
            });
        } catch (error) {
            console.error("Export error:", error);
            this.notification.add(
                _t("無法開啟匯出精靈。"),
                { type: "danger" }
            );
        }
    }

    async onImportClick() {
        await this.action.doAction({
            type: "ir.actions.act_window",
            name: _t("匯入專案 (XML)"),
            res_model: "project.exchange.import",
            views: [[false, "form"]],
            target: "new",
        });
    }

    // -------------------------------------------------------------------------
    // Keyboard Handler (Delete/Escape/Enter/Arrow)
    // -------------------------------------------------------------------------

    async _onKeyDown(ev) {
        if (ev.isComposing) return; // IME composition (e.g. 注音選字)
        // Only act when Gantt view is focused (not inside input/dialog)
        if (ev.target.closest("input, textarea, [contenteditable], .modal")) return;

        const api = this._rendererApi;
        const selectedId = api?.getSelectedRowId?.();

        if (ev.key === "Delete" && selectedId) {
            ev.preventDefault();
            // Multi-select delete
            const multiIds = api?.getSelectedRowIds?.();
            const multiKeys = multiIds ? Object.keys(multiIds).map(Number) : [];
            if (multiKeys.length > 1) {
                const count = multiKeys.length;
                this.displayDialog(ConfirmationDialog, {
                    body: _t("\u522A\u9664\u5DF2\u9078\u53D6\u7684 %(count)s \u500B\u4EFB\u52D9\uFF1F", { count }),
                    confirm: async () => {
                        await this.model.deleteRecords(multiKeys);
                        api?.clearMultiSelect?.();
                        api?.setSelectedRowId?.(null);
                        await this._loadWithScrollRestore(this.props);
                    },
                    dismiss: () => {},
                });
            } else {
                const record = this.model.getRecord(selectedId);
                const name = record?.display_name || _t("任務 #%(id)s", { id: selectedId });
                this.displayDialog(ConfirmationDialog, {
                    body: _t("\u522A\u9664\u300C%(name)s\u300D\uFF1F", { name }),
                    confirm: async () => {
                        await this.model.deleteRecord(selectedId);
                        api?.setSelectedRowId?.(null);
                    },
                    dismiss: () => {},
                });
            }
        }

        if (ev.key === "Escape") {
            api?.setSelectedRowId?.(null);
            api?.clearMultiSelect?.();
            // Also close panels
            if (this.state.showInspectorPanel) {
                this.state.showInspectorPanel = false;
                this.state.inspectorRecordId = null;
            }
            if (this.state.showViolationPanel) {
                this.state.showViolationPanel = false;
            }
        }

        // Enter key: handled in GanttRenderer directly (avoids cross-component API timing issues)

        if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && api) {
            ev.preventDefault();
            const rows = api.getFlattenedRows?.()?.filter(r => !r._isGroup) || [];
            if (!rows.length) return;
            const currentIdx = rows.findIndex(r => r.id === selectedId);
            let nextIdx;
            if (ev.key === "ArrowDown") {
                nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, rows.length - 1);
            } else {
                nextIdx = currentIdx < 0 ? 0 : Math.max(currentIdx - 1, 0);
            }
            api.setSelectedRowId?.(rows[nextIdx].id);
        }

        // Ctrl+A: select all visible tasks
        if (ev.key === "a" && (ev.ctrlKey || ev.metaKey) && api) {
            ev.preventDefault();
            const rows = api.getFlattenedRows?.()?.filter(r => !r._isGroup) || [];
            const multiIds = api.getSelectedRowIds?.();
            if (multiIds) {
                rows.forEach(r => { multiIds[r.id] = true; });
            }
        }

        // Item 11: Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "z" && !ev.shiftKey) {
            ev.preventDefault();
            this.model.undo();
        } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || (ev.key === "z" && ev.shiftKey) || (ev.key === "Z" && ev.shiftKey))) {
            ev.preventDefault();
            this.model.redo();
        }
    }

    // -------------------------------------------------------------------------
    // Phase 2: Catch Up / Reschedule
    // -------------------------------------------------------------------------

    async onCatchUpClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(_t("請先選擇專案。"), { type: "warning" });
            return;
        }
        this.displayDialog(ConfirmationDialog, {
            body: _t("根據今日日期更新任務進度並重新排程？"),
            confirm: async () => {
                this.state.isLoading = true;
                try {
                    await this.model.catchUp(projectId);
                    await this._loadWithScrollRestore(this.props);
                    this.notification.add(_t("追趕進度完成。"), { type: "success" });
                } catch (e) {
                    this.notification.add(_t("追趕進度失敗: %(error)s", { error: e.message || "" }), { type: "danger" });
                } finally {
                    this.state.isLoading = false;
                }
            },
            dismiss: () => {},
        });
    }

    async onRescheduleClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(_t("請先選擇專案。"), { type: "warning" });
            return;
        }
        this.displayDialog(ConfirmationDialog, {
            body: _t("將逾期任務的剩餘工作移至今天並重新排程？"),
            confirm: async () => {
                this.state.isLoading = true;
                try {
                    await this.model.rescheduleIncomplete(projectId);
                    await this._loadWithScrollRestore(this.props);
                    this.notification.add(_t("重新排程完成。"), { type: "success" });
                } catch (e) {
                    this.notification.add(_t("重新排程失敗: %(error)s", { error: e.message || "" }), { type: "danger" });
                } finally {
                    this.state.isLoading = false;
                }
            },
            dismiss: () => {},
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
        this._rendererApi?.setSelectedRowId?.(taskId);
        this._rendererApi?.scrollToRecord?.(taskId);
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
        // Date fields: use moveAndCascade (single RPC + server-side cascade)
        // instead of updateRecord (multiple RPCs for cascade)
        const dateFields = new Set([
            this.model.archInfo?.dateStart || "date_start",
            this.model.archInfo?.dateStop || "date_end",
            this.model.archInfo?.planOffset || "plan_offset",
            "plan_duration", "constrain_type", "constrain_date",
        ]);
        if (dateFields.has(fieldName)) {
            await this.model.moveAndCascade(recordId, { [fieldName]: newValue });
        } else {
            await this.model.updateRecord(recordId, { [fieldName]: newValue });
        }
        await this._loadWithScrollRestore(this.props);
    }

    // -------------------------------------------------------------------------
    // Phase 3B: Level Resources
    // -------------------------------------------------------------------------

    async onLevelResourcesClick() {
        const projectId = this._getProjectIdFromContext();
        if (!projectId) {
            this.notification.add(_t("請先選擇專案。"), { type: "warning" });
            return;
        }
        this.displayDialog(ConfirmationDialog, {
            body: _t("執行資源平準化？非關鍵任務將被延遲以解決衝突。"),
            confirm: async () => {
                this.state.isLoading = true;
                try {
                    const count = await this.model.levelResources(projectId);
                    await this._loadWithScrollRestore(this.props);
                    this.notification.add(
                        count > 0 ? _t("%(count)s \u500B\u4EFB\u52D9\u5DF2\u8ABF\u6574\u3002", { count }) : _t("未發現衝突。"),
                        { type: count > 0 ? "success" : "info" }
                    );
                } catch (e) {
                    this.notification.add(_t("平準化失敗: %(error)s", { error: e.message || "" }), { type: "danger" });
                } finally {
                    this.state.isLoading = false;
                }
            },
            dismiss: () => {},
        });
    }

    async onAlignConstraintsClick() {
        this.state.isLoading = true;
        try {
            const count = await this.model._enforceConstraintAlignment({ silent: false });
            if (count > 0) {
                await this._loadWithScrollRestore(this.props);
            } else {
                this.notification.add(_t("所有任務已符合前置限制"), { type: "info" });
            }
        } catch (e) {
            this.notification.add(_t("對齊失敗: %(error)s", { error: e.message || "" }), { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
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
            this.notification.add(_t("\u57FA\u7DDA\u5DF2\u5132\u5B58: %(name)s", { name: result.name }), { type: "success" });
            this.state.baselines = await this.model.getBaselines(projectId);
        } catch (e) {
            this.notification.add(_t("基線儲存失敗: %(error)s", { error: e.message || "" }), { type: "danger" });
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
        const selectedId = this._rendererApi?.getSelectedRowId?.();
        if (!selectedId) {
            this.notification.add(_t("請先選擇任務。"), { type: "info" });
            return;
        }

        const loadBarModel = this.props.archInfo.loadBarModel;
        if (!loadBarModel) {
            this.notification.add(_t("未設定細節計畫模型。"), { type: "warning" });
            return;
        }

        const loadIdField = this.props.archInfo.loadId || "task_id";
        await this.action.doAction({
            type: "ir.actions.act_window",
            name: _t("細節計畫"),
            res_model: loadBarModel,
            views: [[false, "list"], [false, "form"]],
            domain: [[loadIdField, "=", selectedId]],
            target: "current",
        });
    }
}
