/** @odoo-module **/

import { visitXML } from "@web/core/utils/xml";

export class GanttArchParser {
    parse(arch, models, modelName) {
        const archInfo = {
            resModel: modelName,
        };

        visitXML(arch, (node) => {
            if (node.tagName === "ganttaps") {
                // Parse all attributes from the ganttaps node
                for (const attr of node.attributes) {
                    archInfo[this._toCamelCase(attr.name)] = attr.value;
                }
            }
        });

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
        archInfo.scheduleMode = archInfo.scheduleMode || "schedule_mode";
        archInfo.constrainType = archInfo.constrainType || "constrain_type";
        archInfo.constrainDate = archInfo.constrainDate || "constrain_date";
        archInfo.duration = archInfo.duration || "duration";
        archInfo.planDuration = archInfo.planDuration || "plan_duration";
        archInfo.workingDuration = archInfo.workingDuration || "working_duration";
        // Rolled-up scheduled hours (leaf = own plan_duration, parent = sum of
        // its leaf descendants). Read-only on summary rows.
        archInfo.totalWorkHours = archInfo.totalWorkHours || "total_work_hours";
        archInfo.fixedCalcType = archInfo.fixedCalcType || "";

        // Dates
        archInfo.dateDeadline = archInfo.dateDeadline || "";
        archInfo.dateDone = archInfo.dateDone || "";

        // Summary dates
        archInfo.summaryDateStart = archInfo.summaryDateStart || "";
        archInfo.summaryDateEnd = archInfo.summaryDateEnd || "";

        // Color
        archInfo.colorGantt = archInfo.colorGantt || "";

        // Sorting
        archInfo.sortingSeq = archInfo.sortingSeq || "sorting_seq";
        archInfo.sortingLevel = archInfo.sortingLevel || "sorting_level";

        // Critical path & loop detection
        archInfo.criticalPath = archInfo.criticalPath || "";
        archInfo.cpShows = archInfo.cpShows || "";
        archInfo.cpDetail = archInfo.cpDetail || "";
        archInfo.pLoop = archInfo.pLoop || "";

        // Parent/child
        archInfo.parentId = archInfo.parentId || "parent_id";
        archInfo.subtaskCount = archInfo.subtaskCount || "subtask_count";

        // Fold
        archInfo.fold = archInfo.fold || "fold";

        // Show on gantt
        archInfo.onGantt = archInfo.onGantt || "on_gantt";

        // Progress
        archInfo.progress = archInfo.progress || "";

        // Action/plan
        archInfo.planAction = archInfo.planAction || "";
        archInfo.actionMenu = archInfo.actionMenu || "";

        // User/project identity
        archInfo.userId = archInfo.userId || "";
        archInfo.projectId = archInfo.projectId || "";
        archInfo.subtaskProjectId = archInfo.subtaskProjectId || "";
        archInfo.mainGroupModel = archInfo.mainGroupModel || "";

        // Sequence
        archInfo.defaultSeq = archInfo.defaultSeq || "";
        archInfo.defaultOrder = archInfo.defaultOrder || "";

        // Document count
        archInfo.docCount = archInfo.docCount || "";

        // Duration scale
        archInfo.durationScale = archInfo.durationScale || "";

        // Load bar (resource detail plan)
        archInfo.loadBarModel = archInfo.loadBarModel || "";
        archInfo.loadId = archInfo.loadId || "";
        archInfo.loadIdFrom = archInfo.loadIdFrom || "";
        archInfo.loadIdsFrom = archInfo.loadIdsFrom || "";

        // Info model (critical path info overlay)
        archInfo.infoModel = archInfo.infoModel || "";
        archInfo.infoIds = archInfo.infoIds || "";

        // Ghost/Baseline model (snapshot comparison)
        archInfo.ghostModel = archInfo.ghostModel || "";
        archInfo.ghostDateStart = archInfo.ghostDateStart || "";
        archInfo.ghostDateEnd = archInfo.ghostDateEnd || "";
        archInfo.ghostDurations = archInfo.ghostDurations || "";
        archInfo.ghostName = archInfo.ghostName || "";
        archInfo.ghostTaskId = archInfo.ghostTaskId || "task_id";

        // Resource intersection
        archInfo.resourceField = archInfo.resourceField || "";
        archInfo.resourceModel = archInfo.resourceModel || "";

        // Planning mode
        archInfo.planOffset = archInfo.planOffset || "plan_offset";

        // Milestone
        archInfo.milestoneId = archInfo.milestoneId || "";

        // Progress mode
        archInfo.progressMode = archInfo.progressMode || "";

        return archInfo;
    }

    _toCamelCase(str) {
        return str.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    }
}
