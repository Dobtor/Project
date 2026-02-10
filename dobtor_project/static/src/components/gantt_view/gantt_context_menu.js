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

        const items = [
            { id: "open", label: "Open Task", icon: "fa-external-link" },
        ];

        // Schedule mode toggle
        if (record._scheduleMode === "manual") {
            items.push({ id: "set_auto", label: "Set Auto Schedule", icon: "fa-bolt" });
        } else {
            items.push({ id: "set_manual", label: "Set Manual Schedule", icon: "fa-hand-paper-o" });
        }

        // Fold/unfold
        if (record._hasChildren) {
            if (record._isFolded) {
                items.push({ id: "unfold", label: "Expand Children", icon: "fa-chevron-down" });
            } else {
                items.push({ id: "fold", label: "Collapse Children", icon: "fa-chevron-right" });
            }
        }

        // Remove constraint (if task has a non-default constraint)
        const constrainTypeField = this.props.archInfo.constrainType || "constrain_type";
        const currentConstraint = record[constrainTypeField];
        if (currentConstraint && currentConstraint !== "asap" && currentConstraint !== "alap") {
            items.push({ id: "remove_constraint", label: "Remove Constraint", icon: "fa-unlock" });
        }

        // Detail plans (if load bar model configured)
        if (this.props.archInfo.loadBarModel) {
            items.push({ id: "detail_plan", label: "Detail Plans", icon: "fa-tasks" });
        }

        // Add subtask
        items.push({ id: "add_subtask", label: "Add Subtask", icon: "fa-plus" });

        // Delete task
        items.push({ id: "delete", label: "Delete Task", icon: "fa-trash-o" });

        return items;
    }

    onMenuItemClick(itemId) {
        this.state.visible = false;
        this.props.onAction(this.state.recordId, itemId);
    }
}
