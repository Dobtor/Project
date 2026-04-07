/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";

/**
 * Context menu for right-clicking on gantt bars.
 * Shows actions like: Open, Edit dates, Set schedule mode, etc.
 */
export class GanttContextMenu extends Component {
    static template = "dobtor_project.GanttContextMenu";

    static props = {
        archInfo: Object,
        getRecord: Function,
        onAction: Function,
    };

    setup() {
        this.menuRef = useRef("contextMenu");
        this.state = useState({
            visible: false,
            x: 0,
            y: 0,
            recordId: null,
        });

        this._onContextMenu = this._onContextMenu.bind(this);
        this._onClickOutside = this._onClickOutside.bind(this);
        this._container = null;

        onMounted(() => {
            const rootEl = this.menuRef.el?.closest(".o_gantt_content_wrapper");
            this._container = rootEl
                ? rootEl.querySelector(".o_gantt_timeline_data")
                : null;
            if (this._container) {
                this._container.addEventListener("contextmenu", this._onContextMenu);
            }
            document.addEventListener("click", this._onClickOutside);
        });

        onWillUnmount(() => {
            if (this._container) {
                this._container.removeEventListener("contextmenu", this._onContextMenu);
            }
            this._container = null;
            document.removeEventListener("click", this._onClickOutside);
        });
    }

    _onContextMenu(ev) {
        const bar = ev.target.closest(".o_gantt_bar");
        if (!bar) {
            this.state.visible = false;
            return;
        }

        ev.preventDefault();

        const recordId = parseInt(bar.dataset.recordId, 10);
        if (!recordId) return;

        const record = this.props.getRecord(recordId);
        if (!record) return;

        this.state.recordId = recordId;
        this.state.visible = true;

        // Position menu near cursor, keep in viewport
        let x = ev.clientX;
        let y = ev.clientY;
        this.state.x = x;
        this.state.y = y;

        // Adjust after render to stay in viewport
        requestAnimationFrame(() => {
            const el = this.menuRef.el;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            if (x + rect.width > window.innerWidth - 10) {
                this.state.x = x - rect.width;
            }
            if (y + rect.height > window.innerHeight - 10) {
                this.state.y = y - rect.height;
            }
        });
    }

    _onClickOutside() {
        if (this.state.visible) {
            this.state.visible = false;
        }
    }

    get record() {
        if (!this.state.recordId) return null;
        return this.props.getRecord(this.state.recordId);
    }

    get menuItems() {
        const record = this.record;
        if (!record) return [];

        // Milestone-specific menu
        if (record._isMilestoneRecord) {
            const items = [
                { id: "open_milestone", label: _t("開啟里程碑"), icon: "fa-external-link" },
            ];
            if (record.is_reached) {
                items.push({ id: "toggle_reached", label: _t("取消已達成"), icon: "fa-times-circle" });
            } else {
                items.push({ id: "toggle_reached", label: _t("標記已達成"), icon: "fa-check-circle" });
            }
            items.push({ id: "delete_milestone", label: _t("刪除里程碑"), icon: "fa-trash-o" });
            return items;
        }

        const items = [
            { id: "open", label: _t("開啟任務"), icon: "fa-external-link" },
        ];

        // Schedule mode toggle
        if (record._scheduleMode === "manual") {
            items.push({ id: "set_auto", label: _t("設為自動排程"), icon: "fa-bolt" });
        } else {
            items.push({ id: "set_manual", label: _t("設為手動排程"), icon: "fa-hand-paper-o" });
        }

        // Fold/unfold
        if (record._hasChildren) {
            if (record._isFolded) {
                items.push({ id: "unfold", label: _t("展開子任務"), icon: "fa-chevron-down" });
            } else {
                items.push({ id: "fold", label: _t("收合子任務"), icon: "fa-chevron-right" });
            }
        }

        // Remove constraint (if task has a non-default constraint)
        const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
        const currentConstraint = record[constrainTypeField];
        if (currentConstraint && currentConstraint !== "asap" && currentConstraint !== "alap") {
            items.push({ id: "remove_constraint", label: _t("移除限制"), icon: "fa-unlock" });
        }

        // on_gantt toggle (show/hide bar label)
        const onGanttField = this.props.archInfo.onGantt || "on_gantt";
        if (record[onGanttField] || record._showLabel) {
            items.push({ id: "hide_bar_label", label: _t("隱藏長條名稱"), icon: "fa-eye-slash" });
        } else {
            items.push({ id: "show_bar_label", label: _t("顯示長條名稱"), icon: "fa-eye" });
        }

        // Detail plans (if load bar model configured)
        if (this.props.archInfo.loadBarModel) {
            items.push({ id: "detail_plan", label: _t("細節計畫"), icon: "fa-tasks" });
        }

        // Add subtask
        items.push({ id: "add_subtask", label: _t("新增子任務"), icon: "fa-plus" });

        // Duplicate task
        items.push({ id: "duplicate", label: _t("複製任務"), icon: "fa-copy" });

        // Delete task
        items.push({ id: "delete", label: _t("刪除任務"), icon: "fa-trash-o", separator: true });

        return items;
    }

    onMenuItemClick(itemId) {
        this.state.visible = false;
        this.props.onAction(this.state.recordId, itemId);
    }
}
