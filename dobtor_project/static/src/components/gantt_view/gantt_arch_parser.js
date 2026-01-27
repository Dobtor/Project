/** @odoo-module **/

import { XMLParser } from "@web/core/utils/xml";

export class GanttArchParser {
    parse(arch, models, modelName) {
        const xmlDoc = new XMLParser().parseXML(arch);
        const ganttNode = xmlDoc.querySelector("ganttaps");

        if (!ganttNode) {
            throw new Error("Invalid ganttaps arch: missing ganttaps node");
        }

        const attrs = ganttNode.attributes;
        const archInfo = {
            resModel: modelName,
        };

        // Parse all attributes from the ganttaps node
        for (let i = 0; i < attrs.length; i++) {
            const attr = attrs[i];
            archInfo[this._toCamelCase(attr.name)] = attr.value;
        }

        // Set defaults
        archInfo.dateStart = archInfo.dateStart || "date_start";
        archInfo.dateStop = archInfo.dateStop || "date_end";
        archInfo.name = archInfo.name || "name";
        archInfo.defaultGroupBy = archInfo.defaultGroupBy || "project_id";
        archInfo.mainGroupIdName = archInfo.mainGroupIdName || "project_id";
        // Parse limitView with explicit handling - minimum 1, default 250
        const parsedLimit = parseInt(archInfo.limitView, 10);
        archInfo.limitView = (!isNaN(parsedLimit) && parsedLimit > 0) ? parsedLimit : 250;

        // Predecessor model configuration
        archInfo.predecessorModel = archInfo.predecessorModel || "";
        archInfo.predecessorTaskId = archInfo.predecessorTaskId || "";
        archInfo.predecessorParentTaskId = archInfo.predecessorParentTaskId || "";
        archInfo.predecessorType = archInfo.predecessorType || "";

        // Other configurations
        archInfo.isMilestone = archInfo.isMilestone || "is_milestone";
        archInfo.scheduleMode = archInfo.scheduleMode || "schedule_mode";
        archInfo.constrainType = archInfo.constrainType || "constrain_type";
        archInfo.constrainDate = archInfo.constrainDate || "constrain_date";
        archInfo.duration = archInfo.duration || "duration";
        archInfo.planDuration = archInfo.planDuration || "plan_duration";

        // Summary dates
        archInfo.summaryDateStart = archInfo.summaryDateStart || "";
        archInfo.summaryDateEnd = archInfo.summaryDateEnd || "";

        // Color
        archInfo.colorGanttSet = archInfo.colorGanttSet || "";
        archInfo.colorGantt = archInfo.colorGantt || "";

        // Sorting
        archInfo.sortingSeq = archInfo.sortingSeq || "sorting_seq";
        archInfo.sortingLevel = archInfo.sortingLevel || "sorting_level";

        // Critical path
        archInfo.criticalPath = archInfo.criticalPath || "";
        archInfo.cpShows = archInfo.cpShows || "";
        archInfo.cpDetail = archInfo.cpDetail || "";

        // Parent/child
        archInfo.parentId = archInfo.parentId || "parent_id";
        archInfo.subtaskCount = archInfo.subtaskCount || "subtask_count";

        // Fold
        archInfo.fold = archInfo.fold || "fold";

        // Show on gantt
        archInfo.onGantt = archInfo.onGantt || "on_gantt";

        return archInfo;
    }

    _toCamelCase(str) {
        return str.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    }
}
