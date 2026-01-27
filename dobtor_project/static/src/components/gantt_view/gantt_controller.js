/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { Layout } from "@web/search/layout";
import { useModelWithSampleData } from "@web/model/model";
import { SearchBar } from "@web/search/search_bar/search_bar";
import { useSearchBarToggler } from "@web/search/search_bar/search_bar_toggler";
import { CogMenu } from "@web/search/cog_menu/cog_menu";
import { standardViewProps } from "@web/views/standard_view_props";
import { useSetupAction } from "@web/search/action_hook";

import { Component, useState, onWillStart, onMounted } from "@odoo/owl";

export class GanttController extends Component {
    static template = "dobtor_project.GanttController";
    static components = {
        Layout,
        SearchBar,
        CogMenu,
    };

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

        this.model = useModelWithSampleData(
            this.props.Model,
            {
                archInfo: this.props.archInfo,
                resModel: this.props.resModel,
                fields: this.props.fields,
            }
        );

        useSetupAction({
            getLocalState: () => ({
                scale: this.model.scale,
            }),
        });

        this.state = useState({
            scale: "day",
            isLoading: false,
        });

        this.searchBarToggler = useSearchBarToggler();

        // Scale options for the segmented control
        this.scales = [
            { value: "1h", label: _t("1 Hour") },
            { value: "2h", label: _t("2 Hours") },
            { value: "4h", label: _t("4 Hours") },
            { value: "8h", label: _t("8 Hours") },
            { value: "day", label: _t("Day") },
            { value: "week", label: _t("Week") },
            { value: "month", label: _t("Month") },
            { value: "quarter", label: _t("Quarter") },
        ];

        // Load initial data using onWillStart hook
        onWillStart(async () => {
            await this.model.load({
                domain: this.props.domain,
                groupBy: this.props.info?.groupBy || [],
                context: this.props.context,
            });
        });
    }

    get rendererProps() {
        return {
            model: this.model,
            archInfo: this.props.archInfo,
            onRecordClick: this.onRecordClick.bind(this),
            onRecordUpdate: this.onRecordUpdate.bind(this),
            onGroupToggle: this.onGroupToggle.bind(this),
            scale: this.state.scale,
        };
    }

    // Button handlers
    onTodayClick() {
        this.model.scrollToToday();
    }

    onScaleChange(scale) {
        this.state.scale = scale;
        this.model.setScale(scale);
    }

    async onSchedulerClick() {
        // Get the project ID from domain or context
        let projectId = this._getProjectIdFromContext();

        if (!projectId) {
            this.notification.add(
                _t("Please select a project first to run the scheduler."),
                { type: "warning", title: _t("No Project Selected") }
            );
            return;
        }

        this.state.isLoading = true;

        try {
            await this.orm.call(
                this.props.resModel,
                "scheduler_plan",
                [projectId]
            );

            await this.model.reload();

            this.notification.add(
                _t("Scheduler completed successfully."),
                { type: "success", title: _t("Scheduler") }
            );
        } catch (error) {
            console.error("Scheduler error:", error);
            this.notification.add(
                _t("Scheduler failed: ") + (error.message || error.data?.message || "Unknown error"),
                { type: "danger", title: _t("Scheduler Error") }
            );
        } finally {
            this.state.isLoading = false;
        }
    }

    _getProjectIdFromContext() {
        // Try to get project_id from domain
        for (const condition of this.props.domain || []) {
            if (Array.isArray(condition)) {
                if (condition[0] === "project_id" && condition[1] === "=") {
                    return condition[2];
                }
                if (condition[0] === "project_id" && condition[1] === "in" && Array.isArray(condition[2]) && condition[2].length === 1) {
                    return condition[2][0];
                }
            }
        }

        // Try to get from context
        if (this.props.context?.default_project_id) {
            return this.props.context.default_project_id;
        }

        if (this.props.context?.active_id && this.props.context?.active_model === "project.project") {
            return this.props.context.active_id;
        }

        return null;
    }

    async onRecordClick(record) {
        try {
            await this.action.doAction({
                type: "ir.actions.act_window",
                res_model: this.props.resModel,
                res_id: record.id,
                views: [[false, "form"]],
                target: "current",
            });
        } catch (error) {
            console.error("Failed to open record:", error);
            this.notification.add(
                _t("Failed to open the task."),
                { type: "danger", title: _t("Navigation Error") }
            );
        }
    }

    async onRecordUpdate(recordId, values) {
        try {
            const success = await this.model.updateRecord(recordId, values);
            if (!success) {
                this.notification.add(
                    _t("Failed to update the task."),
                    { type: "danger", title: _t("Update Error") }
                );
            }
            return success;
        } catch (error) {
            console.error("Error updating record:", error);
            this.notification.add(
                _t("An error occurred while updating the task."),
                { type: "danger", title: _t("Update Error") }
            );
            return false;
        }
    }

    onGroupToggle(groupId) {
        this.model.toggleGroup(groupId);
    }

    onExpandAll() {
        this.model.expandAllGroups();
    }

    onCollapseAll() {
        this.model.collapseAllGroups();
    }

    get display() {
        return {
            controlPanel: {
                "top-right": false,
            },
        };
    }

    get isLoading() {
        return this.state.isLoading;
    }
}
