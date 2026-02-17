/** @odoo-module **/

import { Component, useState, useRef, onMounted, onWillUnmount } from "@odoo/owl";

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

        onMounted(() => {
            const container = document.querySelector(".o_gantt_timeline_data");
            if (container) {
                container.addEventListener("contextmenu", this._onContextMenu);
            }
            document.addEventListener("click", this._onClickOutside);
        });

        onWillUnmount(() => {
            const container = document.querySelector(".o_gantt_timeline_data");
            if (container) {
                container.removeEventListener("contextmenu", this._onContextMenu);
            }
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
                { id: "open_milestone", label: "\u958B\u555F\u91CC\u7A0B\u7891", icon: "fa-external-link" },
            ];
            if (record.is_reached) {
                items.push({ id: "toggle_reached", label: "\u53D6\u6D88\u5DF2\u9054\u6210", icon: "fa-times-circle" });
            } else {
                items.push({ id: "toggle_reached", label: "\u6A19\u8A18\u5DF2\u9054\u6210", icon: "fa-check-circle" });
            }
            items.push({ id: "delete_milestone", label: "\u522A\u9664\u91CC\u7A0B\u7891", icon: "fa-trash-o" });
            return items;
        }

        const items = [
            { id: "open", label: "\u958B\u555F\u4EFB\u52D9", icon: "fa-external-link" },
        ];

        // Schedule mode toggle
        if (record._scheduleMode === "manual") {
            items.push({ id: "set_auto", label: "\u8A2D\u70BA\u81EA\u52D5\u6392\u7A0B", icon: "fa-bolt" });
        } else {
            items.push({ id: "set_manual", label: "\u8A2D\u70BA\u624B\u52D5\u6392\u7A0B", icon: "fa-hand-paper-o" });
        }

        // Fold/unfold
        if (record._hasChildren) {
            if (record._isFolded) {
                items.push({ id: "unfold", label: "\u5C55\u958B\u5B50\u4EFB\u52D9", icon: "fa-chevron-down" });
            } else {
                items.push({ id: "fold", label: "\u6536\u5408\u5B50\u4EFB\u52D9", icon: "fa-chevron-right" });
            }
        }

        // Remove constraint (if task has a non-default constraint)
        const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
        const currentConstraint = record[constrainTypeField];
        if (currentConstraint && currentConstraint !== "asap" && currentConstraint !== "alap") {
            items.push({ id: "remove_constraint", label: "\u79FB\u9664\u9650\u5236", icon: "fa-unlock" });
        }

        // on_gantt toggle (show/hide bar label)
        const onGanttField = this.props.archInfo.onGantt || "on_gantt";
        if (record[onGanttField] || record._showLabel) {
            items.push({ id: "hide_bar_label", label: "\u96B1\u85CF\u9577\u689D\u540D\u7A31", icon: "fa-eye-slash" });
        } else {
            items.push({ id: "show_bar_label", label: "\u986F\u793A\u9577\u689D\u540D\u7A31", icon: "fa-eye" });
        }

        // Detail plans (if load bar model configured)
        if (this.props.archInfo.loadBarModel) {
            items.push({ id: "detail_plan", label: "\u7D30\u7BC0\u8A08\u756B", icon: "fa-tasks" });
        }

        // Add subtask
        items.push({ id: "add_subtask", label: "\u65B0\u589E\u5B50\u4EFB\u52D9", icon: "fa-plus" });

        // Duplicate task
        items.push({ id: "duplicate", label: "\u8907\u88FD\u4EFB\u52D9", icon: "fa-copy" });

        // Delete task
        items.push({ id: "delete", label: "\u522A\u9664\u4EFB\u52D9", icon: "fa-trash-o", separator: true });

        return items;
    }

    onMenuItemClick(itemId) {
        this.state.visible = false;
        this.props.onAction(this.state.recordId, itemId);
    }
}
