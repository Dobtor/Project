/** @odoo-module **/

import { Model } from "@web/model/model";

const { DateTime } = luxon;

export class GanttModel extends Model {
    static services = ["orm"];

    setup(params, services) {
        this.orm = services.orm;
        this.archInfo = params.archInfo;
        this.resModel = params.resModel;
        this.fields = params.fields;

        this.data = {
            records: [],
            groups: [],
            timeStart: null,
            timeEnd: null,
            predecessors: [],
            loadBars: [],     // Resource load/detail plan bars
            taskInfos: [],    // Critical path info (ES/LS/EF/LF)
            ghostBars: [],    // Baseline/ghost bars for comparison
        };

        // Track fold state across reloads: recordId → boolean
        this._foldState = new Map();

        this.scale = "day";
        this.sortMode = "seq";  // "seq" | "start" | "name"
        this._isFirstLoadDone = false;
    }

    async load(props) {
        const domain = props.domain || [];
        const context = props.context || {};

        try {
            const fields = this._getFieldsToFetch();
            const limit = this.archInfo.limitView || 250;
            const orderField = this.archInfo.dateStart || "date_start";

            const records = await this.orm.searchRead(
                this.resModel,
                domain,
                fields,
                { limit, order: `${orderField} asc`, context }
            );

            this.data.records = this._processRecords(records);
            this._calculateTimeRange();
            this._groupRecords();
            this._buildTree();
            await Promise.all([
                this._loadPredecessors(),
                this._loadResourceBars(),
                this._loadTaskInfos(),
                this._loadGhostBars(),
            ]);
            this._isFirstLoadDone = true;
            this.notify();
        } catch (error) {
            console.error("Failed to fetch Gantt data:", error);
            this.data.records = [];
            this.data.groups = [];
            this.notify();
        }
    }

    hasData() {
        return this.data.records.length > 0;
    }

    _getFieldsToFetch() {
        const fields = new Set([
            "id",
            "display_name",
            this.archInfo.name || "name",
            this.archInfo.dateStart || "date_start",
            this.archInfo.dateStop || "date_end",
            this.archInfo.mainGroupIdName || "project_id",
        ]);

        // Add optional fields (key = archInfo key, value = field name)
        const optionalFields = [
            "duration", "isMilestone", "scheduleMode", "parentId",
            "colorGantt", "colorGanttSet", "onGantt", "fold",
            "criticalPath", "subtaskCount", "sortingSeq",
            "summaryDateStart", "summaryDateEnd",
            // Phase 0 additions
            "progress", "dateDeadline", "dateDone", "pLoop",
            "constrainType", "constrainDate", "planAction",
            "sortingLevel", "fixedCalcType", "planDuration",
            "durationScale", "docCount",
        ];

        for (const key of optionalFields) {
            if (this.archInfo[key]) {
                fields.add(this.archInfo[key]);
            }
        }

        return Array.from(fields);
    }

    _processRecords(records) {
        const dateStartField = this.archInfo.dateStart || "date_start";
        const dateStopField = this.archInfo.dateStop || "date_end";
        const milestoneField = this.archInfo.isMilestone || "is_milestone";
        const onGanttField = this.archInfo.onGantt || "on_gantt";
        const deadlineField = this.archInfo.dateDeadline || "";
        const doneField = this.archInfo.dateDone || "";
        const progressField = this.archInfo.progress || "";
        const scheduleModeField = this.archInfo.scheduleMode || "schedule_mode";

        return records.map(record => {
            const dateStart = record[dateStartField];
            const dateEnd = record[dateStopField];

            const processed = {
                ...record,
                _dateStart: dateStart ? DateTime.fromISO(dateStart) : null,
                _dateEnd: dateEnd ? DateTime.fromISO(dateEnd) : null,
                _isMilestone: Boolean(record[milestoneField]),
                _showLabel: Boolean(record[onGanttField]),
                _scheduleMode: record[scheduleModeField] || "manual",
            };

            // Parse deadline date
            if (deadlineField && record[deadlineField]) {
                processed._dateDeadline = DateTime.fromISO(record[deadlineField]);
            }

            // Parse done date
            if (doneField && record[doneField]) {
                processed._dateDone = DateTime.fromISO(record[doneField]);
            }

            // Parse progress (0-100 range)
            if (progressField && record[progressField] != null) {
                processed._progress = Number(record[progressField]) || 0;
            }

            return processed;
        });
    }

    _calculateTimeRange() {
        let minDate = null;
        let maxDate = null;

        for (const record of this.data.records) {
            if (record._dateStart) {
                if (!minDate || record._dateStart < minDate) {
                    minDate = record._dateStart;
                }
            }
            if (record._dateEnd) {
                if (!maxDate || record._dateEnd > maxDate) {
                    maxDate = record._dateEnd;
                }
            }
        }

        // Default to current month if no dates
        if (!minDate) {
            minDate = DateTime.now().startOf("month");
        }
        if (!maxDate) {
            maxDate = DateTime.now().endOf("month");
        }

        // Add padding
        this.data.timeStart = minDate.minus({ days: 2 }).startOf("day");
        this.data.timeEnd = maxDate.plus({ days: 5 }).endOf("day");
    }

    _groupRecords() {
        const groupField = this.archInfo.mainGroupIdName || "project_id";
        const groups = new Map();

        for (const record of this.data.records) {
            const groupValue = record[groupField];
            const groupId = Array.isArray(groupValue) ? groupValue[0] : (groupValue || 0);
            const groupName = Array.isArray(groupValue) ? groupValue[1] : String(groupValue || "No Project");

            if (!groups.has(groupId)) {
                groups.set(groupId, {
                    id: groupId,
                    name: groupName,
                    records: [],
                    fold: false,
                    _isGroup: true,
                });
            }
            groups.get(groupId).records.push(record);
        }

        this.data.groups = Array.from(groups.values());
    }

    // Interactive methods
    setScale(scale) {
        this.scale = scale;
        this.notify();
    }

    setSortMode(sortMode) {
        this.sortMode = sortMode;
        this._rebuildTreeRecords();
        this.notify();
    }

    toggleGroup(groupId) {
        const group = this.data.groups.find(g => g.id === groupId);
        if (group) {
            group.fold = !group.fold;
            this.notify();
        }
    }

    expandAllGroups() {
        for (const group of this.data.groups) {
            group.fold = false;
        }
        this.notify();
    }

    collapseAllGroups() {
        for (const group of this.data.groups) {
            group.fold = true;
        }
        this.notify();
    }

    // -------------------------------------------------------------------------
    // Tree Hierarchy
    // -------------------------------------------------------------------------

    _buildTree() {
        const parentField = this.archInfo.parentId || "parent_id";
        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const foldField = this.archInfo.fold || "fold";
        const subtaskCountField = this.archInfo.subtaskCount || "subtask_count";
        const summaryStartField = this.archInfo.summaryDateStart || "";
        const summaryEndField = this.archInfo.summaryDateEnd || "";

        for (const group of this.data.groups) {
            // Build parent→children map
            const childrenMap = new Map(); // parentId → [records]
            const recordMap = new Map(); // id → record

            for (const record of group.records) {
                recordMap.set(record.id, record);

                const parentVal = record[parentField];
                const parentId = Array.isArray(parentVal) ? parentVal[0] : (parentVal || 0);

                if (!childrenMap.has(parentId)) {
                    childrenMap.set(parentId, []);
                }
                childrenMap.get(parentId).push(record);
            }

            // Sort children by current sort mode
            const comparator = this._getSortComparator(sortField);
            for (const [, children] of childrenMap) {
                children.sort(comparator);
            }

            // Annotate each record
            for (const record of group.records) {
                const children = childrenMap.get(record.id) || [];
                const hasChildren = children.length > 0 ||
                    (record[subtaskCountField] && record[subtaskCountField] > 0);

                const parentVal = record[parentField];
                const parentId = Array.isArray(parentVal) ? parentVal[0] : (parentVal || 0);

                record._hasChildren = hasChildren;
                record._children = children;
                record._parentId = parentId;

                // Restore fold state, fallback to DB field
                if (this._foldState.has(record.id)) {
                    record._isFolded = this._foldState.get(record.id);
                } else {
                    record._isFolded = hasChildren ? Boolean(record[foldField]) : false;
                }

                // Summary dates for parent tasks
                if (hasChildren && summaryStartField && record[summaryStartField]) {
                    record._summaryDateStart = DateTime.fromISO(record[summaryStartField]);
                }
                if (hasChildren && summaryEndField && record[summaryEndField]) {
                    record._summaryDateEnd = DateTime.fromISO(record[summaryEndField]);
                }
            }

            // Compute indent levels
            const computeIndent = (id, level) => {
                const children = childrenMap.get(id) || [];
                for (const child of children) {
                    child._indent = level;
                    computeIndent(child.id, level + 1);
                }
            };
            // Root tasks (parentId = 0 or parent not in this group)
            for (const record of group.records) {
                if (record._parentId === 0 || !recordMap.has(record._parentId)) {
                    record._indent = 0;
                    computeIndent(record.id, 1);
                }
            }

            // Flatten into tree-ordered list respecting fold state
            group._treeRecords = this._flattenTree(group.records, childrenMap, recordMap);
        }
    }

    _flattenTree(records, childrenMap, recordMap) {
        const result = [];

        // Find root records (parent not in group)
        const roots = records.filter(r =>
            r._parentId === 0 || !recordMap.has(r._parentId)
        );

        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const comparator = this._getSortComparator(sortField);
        roots.sort(comparator);

        const visit = (record) => {
            result.push(record);
            if (record._hasChildren && !record._isFolded) {
                const children = childrenMap.get(record.id) || [];
                for (const child of children) {
                    visit(child);
                }
            }
        };

        for (const root of roots) {
            visit(root);
        }

        return result;
    }

    toggleTaskFold(recordId) {
        const record = this.data.records.find(r => r.id === recordId);
        if (!record || !record._hasChildren) return;

        record._isFolded = !record._isFolded;
        this._foldState.set(recordId, record._isFolded);

        // Write fold state to backend (fire and forget)
        const foldField = this.archInfo.fold || "fold";
        this.orm.write(this.resModel, [recordId], { [foldField]: record._isFolded }).catch(() => {});

        // Rebuild tree lists for affected group
        this._rebuildTreeRecords();
        this.notify();
    }

    _rebuildTreeRecords() {
        const parentField = this.archInfo.parentId || "parent_id";

        for (const group of this.data.groups) {
            const childrenMap = new Map();
            const recordMap = new Map();

            for (const record of group.records) {
                recordMap.set(record.id, record);
                const parentVal = record[parentField];
                const parentId = Array.isArray(parentVal) ? parentVal[0] : (parentVal || 0);
                if (!childrenMap.has(parentId)) {
                    childrenMap.set(parentId, []);
                }
                childrenMap.get(parentId).push(record);
            }

            const sortField = this.archInfo.sortingSeq || "sorting_seq";
            const comparator = this._getSortComparator(sortField);
            for (const [, children] of childrenMap) {
                children.sort(comparator);
            }

            group._treeRecords = this._flattenTree(group.records, childrenMap, recordMap);
        }
    }

    /**
     * Return a sort comparator function based on current sortMode.
     */
    _getSortComparator(sortField) {
        if (this.sortMode === "start") {
            return (a, b) => {
                const aMs = a._dateStart ? a._dateStart.toMillis() : Infinity;
                const bMs = b._dateStart ? b._dateStart.toMillis() : Infinity;
                return aMs - bMs;
            };
        }
        if (this.sortMode === "name") {
            return (a, b) => (a.display_name || "").localeCompare(b.display_name || "");
        }
        // Default: "seq" — sort by sorting_seq field
        return (a, b) => (a[sortField] || 0) - (b[sortField] || 0);
    }

    // -------------------------------------------------------------------------
    // Predecessors
    // -------------------------------------------------------------------------

    async _loadPredecessors() {
        const predModel = this.archInfo.predecessorModel;
        if (!predModel) {
            this.data.predecessors = [];
            return;
        }

        const taskIdField = this.archInfo.predecessorTaskId || "task_id";
        const parentTaskIdField = this.archInfo.predecessorParentTaskId || "parent_task_id";
        const typeField = this.archInfo.predecessorType || "type";

        // Collect visible task IDs
        const taskIds = new Set(this.data.records.map(r => r.id));
        if (taskIds.size === 0) {
            this.data.predecessors = [];
            return;
        }

        try {
            const domain = [
                "|",
                [taskIdField, "in", Array.from(taskIds)],
                [parentTaskIdField, "in", Array.from(taskIds)],
            ];

            const fields = [taskIdField, parentTaskIdField, typeField, "lag_qty", "lag_type"];
            const results = await this.orm.searchRead(predModel, domain, fields, { limit: 1000 });

            // Normalize: extract [id, name] → id for many2one fields
            this.data.predecessors = results
                .map(r => ({
                    task_id: Array.isArray(r[taskIdField]) ? r[taskIdField][0] : r[taskIdField],
                    parent_task_id: Array.isArray(r[parentTaskIdField]) ? r[parentTaskIdField][0] : r[parentTaskIdField],
                    type: r[typeField] || "FS",
                    lag_qty: r.lag_qty || 0,
                    lag_type: r.lag_type || "day",
                }))
                .filter(p => taskIds.has(p.task_id) && taskIds.has(p.parent_task_id));
        } catch (error) {
            console.warn("Failed to load predecessors:", error);
            this.data.predecessors = [];
        }
    }

    // -------------------------------------------------------------------------
    // Resource Load Bars (Detail Plans)
    // -------------------------------------------------------------------------

    async _loadResourceBars() {
        const loadModel = this.archInfo.loadBarModel;
        if (!loadModel) {
            this.data.loadBars = [];
            return;
        }

        const loadIdField = this.archInfo.loadId || "task_id";
        const loadIdsFromField = this.archInfo.loadIdsFrom || "id";

        // Collect task IDs
        const taskIds = new Set(this.data.records.map(r => r[loadIdsFromField] || r.id));
        if (taskIds.size === 0) {
            this.data.loadBars = [];
            return;
        }

        try {
            const domain = [
                [loadIdField, "in", Array.from(taskIds)],
            ];

            const fields = [
                loadIdField, "name", "data_from", "data_to",
                "duration", "resource_id", "type_level",
                "color_gantt_set", "color_gantt", "data_aggr",
            ];
            const results = await this.orm.searchRead(loadModel, domain, fields, { limit: 5000 });

            this.data.loadBars = results.map(r => {
                const taskVal = r[loadIdField];
                return {
                    id: r.id,
                    taskId: Array.isArray(taskVal) ? taskVal[0] : taskVal,
                    name: r.name || "",
                    dateStart: r.data_from ? DateTime.fromISO(r.data_from) : null,
                    dateEnd: r.data_to ? DateTime.fromISO(r.data_to) : null,
                    duration: r.duration || 0,
                    resourceId: Array.isArray(r.resource_id) ? r.resource_id[0] : r.resource_id,
                    resourceName: Array.isArray(r.resource_id) ? r.resource_id[1] : "",
                    typeLevel: r.type_level || "cut",
                    colorSet: r.color_gantt_set,
                    color: r.color_gantt,
                    dateAggr: r.data_aggr || null,
                };
            });
        } catch (error) {
            console.warn("Failed to load resource bars:", error);
            this.data.loadBars = [];
        }
    }

    // -------------------------------------------------------------------------
    // Task Info (ES/LS/EF/LF from critical path analysis)
    // -------------------------------------------------------------------------

    async _loadTaskInfos() {
        const infoModel = this.archInfo.infoModel;
        const infoIdsField = this.archInfo.infoIds;
        if (!infoModel || !infoIdsField) {
            this.data.taskInfos = [];
            return;
        }

        const taskIds = new Set(this.data.records.map(r => r.id));
        if (taskIds.size === 0) {
            this.data.taskInfos = [];
            return;
        }

        try {
            const domain = [
                ["task_id", "in", Array.from(taskIds)],
                ["show", "=", true],
            ];
            const fields = [
                "task_id", "name", "start", "end",
                "left_up", "left_down", "right_up", "right_down",
            ];
            const results = await this.orm.searchRead(infoModel, domain, fields, { limit: 2000 });

            // Group by task_id
            const infoMap = new Map();
            for (const r of results) {
                const tid = Array.isArray(r.task_id) ? r.task_id[0] : r.task_id;
                if (!infoMap.has(tid)) {
                    infoMap.set(tid, []);
                }
                infoMap.get(tid).push({
                    name: r.name,
                    start: r.start,
                    end: r.end,
                    leftUp: r.left_up || "",
                    leftDown: r.left_down || "",
                    rightUp: r.right_up || "",
                    rightDown: r.right_down || "",
                });
            }

            this.data.taskInfos = infoMap;
        } catch (error) {
            console.warn("Failed to load task infos:", error);
            this.data.taskInfos = new Map();
        }
    }

    // -------------------------------------------------------------------------
    // Ghost/Baseline Bars (snapshot comparison)
    // -------------------------------------------------------------------------

    async _loadGhostBars() {
        const ghostModel = this.archInfo.ghostModel;
        if (!ghostModel) {
            this.data.ghostBars = [];
            return;
        }

        const ghostTaskIdField = this.archInfo.ghostTaskId || "task_id";
        const ghostStartField = this.archInfo.ghostDateStart || "date_start";
        const ghostEndField = this.archInfo.ghostDateEnd || "";
        const ghostDurationsField = this.archInfo.ghostDurations || "";
        const ghostNameField = this.archInfo.ghostName || "";

        const taskIds = new Set(this.data.records.map(r => r.id));
        if (taskIds.size === 0) {
            this.data.ghostBars = [];
            return;
        }

        try {
            const domain = [
                [ghostTaskIdField, "in", Array.from(taskIds)],
            ];
            const fields = [ghostTaskIdField, ghostStartField];
            if (ghostEndField) fields.push(ghostEndField);
            if (ghostDurationsField) fields.push(ghostDurationsField);
            if (ghostNameField) fields.push(ghostNameField);
            if (!ghostNameField || ghostNameField !== "name") fields.push("name");
            const results = await this.orm.searchRead(ghostModel, domain, fields, { limit: 2000 });

            this.data.ghostBars = results
                .map(r => {
                    const taskVal = r[ghostTaskIdField];
                    const displayName = (ghostNameField && r[ghostNameField]) || r.name || "";

                    // Parse start date — handle date-only (YYYY-MM-DD) by assuming 08:00 workday start
                    let dateStart = null;
                    const rawStart = r[ghostStartField];
                    if (rawStart) {
                        if (typeof rawStart === "string" && rawStart.length === 10) {
                            // Date-only field (e.g. "2026-01-15") → start at 08:00
                            dateStart = DateTime.fromISO(rawStart + "T08:00:00");
                        } else {
                            dateStart = DateTime.fromISO(rawStart);
                        }
                    }

                    // Determine end date
                    let dateEnd = null;
                    if (ghostEndField && r[ghostEndField]) {
                        dateEnd = DateTime.fromISO(r[ghostEndField]);
                    } else if (ghostDurationsField && r[ghostDurationsField] && dateStart) {
                        dateEnd = dateStart.plus({ hours: r[ghostDurationsField] });
                    }

                    if (!dateStart || !dateEnd) return null;

                    return {
                        id: r.id,
                        taskId: Array.isArray(taskVal) ? taskVal[0] : taskVal,
                        name: displayName,
                        dateStart,
                        dateEnd,
                    };
                })
                .filter(Boolean);
        } catch (error) {
            console.warn("Failed to load ghost bars:", error);
            this.data.ghostBars = [];
        }
    }

    // -------------------------------------------------------------------------
    // Delete Record
    // -------------------------------------------------------------------------

    async deleteRecord(recordId) {
        await this.orm.unlink(this.resModel, [recordId]);
        // Remove from local data
        for (const group of this.data.groups) {
            group.records = group.records.filter(r => r.id !== recordId);
        }
        this.data.records = this.data.records.filter(r => r.id !== recordId);
        this._rebuildTreeRecords();
        this.notify();
    }

    // -------------------------------------------------------------------------
    // Create Record (for add subtask)
    // -------------------------------------------------------------------------

    async createRecord(values) {
        try {
            const recordId = await this.orm.create(this.resModel, [values]);
            return recordId[0];
        } catch (error) {
            console.error("Failed to create record:", error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Reorder Records (for tree drag-drop)
    // -------------------------------------------------------------------------

    async reorderRecord(recordId, targetId, position) {
        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const parentField = this.archInfo.parentId || "parent_id";

        try {
            const record = this.data.records.find(r => r.id === recordId);
            const target = this.data.records.find(r => r.id === targetId);
            if (!record || !target) return;

            const values = {};

            if (position === "child") {
                // Move as child of target
                values[parentField] = targetId;
                const children = this.data.records.filter(r => {
                    const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
                    return pid === targetId;
                });
                const maxSeq = children.reduce((max, c) => Math.max(max, c[sortField] || 0), 0);
                values[sortField] = maxSeq + 10;
            } else {
                // Move before/after target at same level
                const targetParentVal = target[parentField];
                const targetParentId = Array.isArray(targetParentVal) ? targetParentVal[0] : (targetParentVal || 0);
                values[parentField] = targetParentId || false;

                const targetSeq = target[sortField] || 0;
                values[sortField] = position === "before" ? targetSeq - 5 : targetSeq + 5;
            }

            await this.orm.write(this.resModel, [recordId], values);
            // Reload to get proper resequencing from server
            return true;
        } catch (error) {
            console.error("Failed to reorder record:", error);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Rename Record (for inline edit)
    // -------------------------------------------------------------------------

    async renameRecord(recordId, newName) {
        const nameField = this.archInfo.name || "name";
        try {
            await this.orm.write(this.resModel, [recordId], { [nameField]: newName });
            const record = this.data.records.find(r => r.id === recordId);
            if (record) {
                record[nameField] = newName;
                record.display_name = newName;
            }
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to rename record:", error);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Predecessor CRUD (for arrow drawing)
    // -------------------------------------------------------------------------

    async createPredecessor(taskId, parentTaskId, type) {
        const predModel = this.archInfo.predecessorModel;
        if (!predModel) return null;

        const taskIdField = this.archInfo.predecessorTaskId || "task_id";
        const parentTaskIdField = this.archInfo.predecessorParentTaskId || "parent_task_id";
        const typeField = this.archInfo.predecessorType || "type";

        try {
            const ids = await this.orm.create(predModel, [{
                [taskIdField]: taskId,
                [parentTaskIdField]: parentTaskId,
                [typeField]: type || "FS",
            }]);

            // Reload predecessors to reflect the new link
            await this._loadPredecessors();
            this.notify();
            return ids[0];
        } catch (error) {
            console.error("Failed to create predecessor:", error);
            return null;
        }
    }

    async deletePredecessor(predIdentifier) {
        const predModel = this.archInfo.predecessorModel;
        if (!predModel) return false;

        try {
            let predId;
            // predIdentifier can be "arrow_parentId_childId" or a numeric ID
            if (typeof predIdentifier === "string" && predIdentifier.startsWith("arrow_")) {
                const parts = predIdentifier.split("_");
                const parentTaskId = parseInt(parts[1], 10);
                const taskId = parseInt(parts[2], 10);

                if (!parentTaskId || !taskId) return false;

                const taskIdField = this.archInfo.predecessorTaskId || "task_id";
                const parentTaskIdField = this.archInfo.predecessorParentTaskId || "parent_task_id";

                // Find the predecessor record
                const results = await this.orm.searchRead(predModel, [
                    [taskIdField, "=", taskId],
                    [parentTaskIdField, "=", parentTaskId],
                ], ["id"], { limit: 1 });

                if (!results.length) return false;
                predId = results[0].id;
            } else {
                predId = parseInt(predIdentifier, 10);
            }

            if (!predId) return false;

            await this.orm.unlink(predModel, [predId]);

            // Reload predecessors
            await this._loadPredecessors();
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to delete predecessor:", error);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Catch Up / Reschedule / Violations
    // -------------------------------------------------------------------------

    async catchUp(projectId) {
        await this.orm.call("project.project", "action_catch_up", [projectId]);
    }

    async rescheduleIncomplete(projectId) {
        await this.orm.call("project.project", "action_reschedule_incomplete", [projectId]);
    }

    async loadViolations(projectId) {
        try {
            return await this.orm.call("project.project", "check_violations", [projectId]);
        } catch (e) {
            console.warn("Failed to load violations:", e);
            return [];
        }
    }

    // -------------------------------------------------------------------------
    // Phase 3B: Resource Leveling
    // -------------------------------------------------------------------------

    async levelResources(projectId) {
        return await this.orm.call("project.project", "action_level_resources", [projectId]);
    }

    // -------------------------------------------------------------------------
    // Phase 3D: Baseline Management
    // -------------------------------------------------------------------------

    async loadBaselineAsGhosts(baselineId) {
        if (!baselineId) {
            this.data.ghostBars = [];
            this.notify();
            return;
        }
        const taskIds = this.data.records.map(r => r.id);
        if (!taskIds.length) {
            this.data.ghostBars = [];
            this.notify();
            return;
        }
        try {
            const results = await this.orm.searchRead(
                "project.baseline.line",
                [["baseline_id", "=", baselineId], ["task_id", "in", taskIds]],
                ["task_id", "date_start", "date_end", "duration", "progress"],
                { limit: 2000 }
            );
            this.data.ghostBars = results.map(r => {
                const taskId = Array.isArray(r.task_id) ? r.task_id[0] : r.task_id;
                const ds = r.date_start ? DateTime.fromISO(r.date_start) : null;
                const de = r.date_end ? DateTime.fromISO(r.date_end) : null;
                if (!ds || !de) return null;
                return { id: r.id, taskId, name: "Baseline", dateStart: ds, dateEnd: de };
            }).filter(Boolean);
            this.notify();
        } catch (e) {
            console.warn("Failed to load baseline:", e);
            this.data.ghostBars = [];
            this.notify();
        }
    }

    async getBaselines(projectId) {
        try {
            return await this.orm.call("project.project", "get_baselines", [projectId]);
        } catch (e) {
            console.warn("Failed to load baselines:", e);
            return [];
        }
    }

    async saveBaseline(projectId, name) {
        return await this.orm.call("project.project", "action_save_baseline", [projectId], { name });
    }

    async updateRecord(recordId, values) {
        try {
            await this.orm.write(this.resModel, [recordId], values);
            // Update local record
            const record = this.data.records.find(r => r.id === recordId);
            if (record) {
                Object.assign(record, values);
                // Re-process dates if changed
                const dateStartField = this.archInfo.dateStart || "date_start";
                const dateStopField = this.archInfo.dateStop || "date_end";
                if (values[dateStartField]) {
                    record._dateStart = DateTime.fromISO(values[dateStartField]);
                }
                if (values[dateStopField]) {
                    record._dateEnd = DateTime.fromISO(values[dateStopField]);
                }
                // Re-process progress if changed
                const progressField = this.archInfo.progress || "";
                if (progressField && values[progressField] != null) {
                    record._progress = Number(values[progressField]) || 0;
                }
            }
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to update record:", error);
            return false;
        }
    }
}
