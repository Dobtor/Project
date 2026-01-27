/** @odoo-module **/

import { registry } from "@web/core/registry";
import { GanttController } from "./gantt_controller";
import { GanttModel } from "./gantt_model";
import { GanttRenderer } from "./gantt_renderer";
import { GanttArchParser } from "./gantt_arch_parser";

export const ganttView = {
    type: "ganttaps",
    display_name: "Gantt APS",
    icon: "fa fa-tasks",
    multiRecord: true,

    searchMenuTypes: ["filter", "groupBy", "favorite"],

    ArchParser: GanttArchParser,
    Controller: GanttController,
    Model: GanttModel,
    Renderer: GanttRenderer,

    buttonTemplate: "dobtor_project.GanttController.Buttons",

    props: (genericProps, view) => {
        const { ArchParser } = view;
        const { arch, relatedModels, resModel } = genericProps;
        const archInfo = new ArchParser().parse(arch, relatedModels, resModel);

        return {
            ...genericProps,
            Model: view.Model,
            Renderer: view.Renderer,
            buttonTemplate: view.buttonTemplate,
            archInfo,
        };
    },
};

registry.category("views").add("ganttaps", ganttView);
