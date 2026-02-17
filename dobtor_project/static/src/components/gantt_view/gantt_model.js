/** @odoo-module **/

import { Model } from "@web/model/model";
import { lagToDuration, durationToLag } from "./gantt_utils";

const { DateTime } = luxon;

/** Fixed reference date for planning mode virtual timeline (T+0). */
const PLANNING_T0 = DateTime.fromObject({ year: 2000, month: 1, day: 1 });

export class GanttModel extends Model {
    static services = ["orm", "notification"];

    /**
     * Parse an Odoo date/datetime string to a Luxon DateTime.
     * Odoo ORM returns datetimes as "2026-02-10 08:00:00" (SQL format),
     * not ISO 8601 "2026-02-10T08:00:00". Luxon's fromISO rejects the
     * space separator, so we must use fromSQL first.
     * Returns null (not an invalid DateTime) if parsing fails.
     */
    static parseOdooDate(value) {
        if (!value) return null;
        if (typeof value !== "string") return null;
        // Odoo datetime: "2026-02-10 08:00:00" → fromSQL
        let dt = DateTime.fromSQL(value);
        if (dt.isValid) return dt;
        // Fallback: ISO 8601 "2026-02-10T08:00:00" or date-only "2026-02-10"
        dt = DateTime.fromISO(value);
        return dt.isValid ? dt : null;
    }

    setup(params, services) {
        this.orm = services.orm;
        this.notification = services.notification;
        this.archInfo = params.archInfo;
        this.resModel = params.resModel;
        this.fields = params.fields;

        this.data = {
            records: [],
            groups: [],
            timeStart: null,
            timeEnd: null,
            predecessors: [],
            milestones: [],       // Milestone raw records (negative ID)
            milestoneLinks: [],   // task→milestone arrow data
            loadBars: [],     // Resource load/detail plan bars
            taskInfos: [],    // Critical path info (ES/LS/EF/LF)
            ghostBars: [],    // Baseline/ghost bars for comparison
        };

        // Track fold state across reloads: recordId → boolean
        this._foldState = new Map();
        // Track which parent tasks have had their children loaded (survives reloads)
        this._childrenLoadedSet = new Set();
        // Track which parents are currently loading children (for spinner UI)
        this._loadingChildrenSet = new Set();

        this.scale = "day";
        this.sortMode = "seq";  // "seq" | "start" | "name"
    }

    async load(props) {
        this._lastLoadProps = props;
        const domain = props.domain || [];
        const context = props.context || {};

        try {
            const fields = this._getFieldsToFetch();
            const limit = this.archInfo.limitView || 250;
            const orderField = this.archInfo.dateStart || "date_start";

            // Phase 1: Initial load with original domain (includes display_in_project filter)
            const records = await this.orm.searchRead(
                this.resModel,
                domain,
                fields,
                { limit, order: `${orderField} asc`, context }
            );

            this.data.records = this._processRecords(records);

            // Phase 2: Auto-supplement missing children for loaded parent tasks
            await this._autoSupplementChildren(fields, context);

            // Reset children-loaded tracking on full reload
            this._childrenLoadedSet.clear();
            // Mark parents whose children are already present as loaded
            this._markLoadedParents();

            this._calculateTimeRange();
            this._groupRecords();
            await this._loadMilestones();
            this._computeMilestonePositions();
            this._expandTimeRange(this.data.milestones);
            this._mergeMilestonesIntoGroups();
            this._buildTree();
            this._buildMilestoneLinks();
            const results = await Promise.allSettled([
                this._loadPredecessors(),
                this._loadResourceBars(),
                this._loadTaskInfos(),
                this._loadGhostBars(),
                this._loadGroupAvatars(),
            ]);
            const labels = ["前置關聯", "資源列", "任務資訊", "Ghost 列", "群組頭像"];
            for (let i = 0; i < results.length; i++) {
                if (results[i].status === "rejected") {
                    console.error(`Failed to load ${labels[i]}:`, results[i].reason);
                    this.notification.add(`載入${labels[i]}失敗`, { type: "warning" });
                }
            }
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
            this.archInfo.parentId || "parent_id",  // Always fetch for tree hierarchy
        ]);

        // Add optional fields (key = archInfo key, value = field name)
        const optionalFields = [
            "duration", "scheduleMode", "parentId",
            "colorGantt", "onGantt", "fold",
            "criticalPath", "subtaskCount", "sortingSeq",
            "summaryDateStart", "summaryDateEnd",
            // Phase 0 additions
            "progress", "dateDeadline", "dateDone", "pLoop",
            "constrainType", "constrainDate", "planAction",
            "sortingLevel", "fixedCalcType", "planDuration",
            "durationScale", "docCount",
            // Avatar
            "userId",
            // Planning mode
            "planOffset",
            // Milestone
            "milestoneId",
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
        const onGanttField = this.archInfo.onGantt || "on_gantt";
        const deadlineField = this.archInfo.dateDeadline || "";
        const doneField = this.archInfo.dateDone || "";
        const progressField = this.archInfo.progress || "";
        const scheduleModeField = this.archInfo.scheduleMode || "schedule_mode";
        const planDurationField = this.archInfo.planDuration || "plan_duration";
        const planOffsetField = this.archInfo.planOffset || "plan_offset";

        // Virtual base time (fixed reference for planning mode)
        const T0 = PLANNING_T0;

        return records.map(record => {
            const dateStart = record[dateStartField];
            const dateEnd = record[dateStopField];

            const processed = {
                ...record,
                _dateStart: GanttModel.parseOdooDate(dateStart),
                _dateEnd: GanttModel.parseOdooDate(dateEnd),
                _showLabel: Boolean(record[onGanttField]),
                _scheduleMode: record[scheduleModeField] || "manual",
            };

            // Parse plan_duration and plan_offset
            processed._planDuration = Number(record[planDurationField]) || 0;
            processed._planOffset = Number(record[planOffsetField]) || 0;

            // Virtual dates: when no actual dates but has plan_duration, generate from T0
            if (!processed._dateStart && processed._planDuration > 0) {
                processed._dateStart = T0.plus({ hours: processed._planOffset });
                processed._dateEnd = T0.plus({ hours: processed._planOffset + processed._planDuration });
                processed._isVirtualDates = true;
            } else {
                processed._isVirtualDates = false;
            }

            // Parse deadline date
            if (deadlineField && record[deadlineField]) {
                processed._dateDeadline = GanttModel.parseOdooDate(record[deadlineField]);
            }

            // Parse done date
            if (doneField && record[doneField]) {
                processed._dateDone = GanttModel.parseOdooDate(record[doneField]);
            }

            // Parse constrain date
            const constrainDateField = this.archInfo.constrainDate || "constrain_date";
            if (record[constrainDateField]) {
                processed._constrainDate = GanttModel.parseOdooDate(record[constrainDateField]);
            }

            // Parse progress (0-100 range)
            if (progressField && record[progressField] != null) {
                processed._progress = Number(record[progressField]) || 0;
            }

            return processed;
        });
    }

    // -------------------------------------------------------------------------
    // Phase 2: Auto-supplement missing children
    // -------------------------------------------------------------------------

    /**
     * After initial load, find parents that have subtask_count > loaded children
     * and fetch their missing children recursively.
     */
    async _autoSupplementChildren(fields, context) {
        const subtaskCountField = this.archInfo.subtaskCount || "subtask_count";
        const parentField = this.archInfo.parentId || "parent_id";

        // Build a set of loaded IDs for fast lookup
        const loadedIds = new Set(this.data.records.map(r => r.id));

        // Find parents whose subtask_count exceeds loaded children count
        const parentsNeedingChildren = [];
        for (const record of this.data.records) {
            const declaredCount = record[subtaskCountField] || 0;
            if (declaredCount <= 0) continue;

            // Count how many children are already loaded for this parent
            const loadedChildCount = this.data.records.filter(r => {
                const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
                return pid === record.id;
            }).length;

            if (loadedChildCount < declaredCount) {
                parentsNeedingChildren.push(record.id);
            }
        }

        if (parentsNeedingChildren.length === 0) return;

        // Recursive fetch: load children, then check if those children also need children
        const allNewRecords = await this._loadChildrenRecursive(
            parentsNeedingChildren, fields, context, loadedIds
        );

        if (allNewRecords.length > 0) {
            this._mergeNewRecords(allNewRecords);
        }
    }

    /**
     * Recursively load children for given parent IDs.
     * Stops when no more missing children are found.
     * @param {number[]} parentIds - Parent task IDs to load children for
     * @param {string[]} fields - Fields to fetch
     * @param {Object} context - ORM context
     * @param {Set} alreadyLoadedIds - IDs already in data (to avoid duplicates)
     * @param {number} depth - Recursion safety counter
     * @returns {Object[]} All newly loaded (processed) records
     */
    async _loadChildrenRecursive(parentIds, fields, context, alreadyLoadedIds, depth = 0) {
        if (parentIds.length === 0 || depth > 10) return [];

        const parentField = this.archInfo.parentId || "parent_id";
        const subtaskCountField = this.archInfo.subtaskCount || "subtask_count";

        try {
            const childDomain = [[parentField, "in", parentIds]];
            const rawChildren = await this.orm.searchRead(
                this.resModel,
                childDomain,
                fields,
                { limit: 2000, context }
            );

            // Filter out already loaded records
            const newRaw = rawChildren.filter(r => !alreadyLoadedIds.has(r.id));
            if (newRaw.length === 0) return [];

            const processed = this._processRecords(newRaw);

            // Track newly loaded IDs
            for (const r of processed) {
                alreadyLoadedIds.add(r.id);
            }

            // Check if any of the new children also have subtasks that need loading
            const nextParentIds = [];
            for (const r of processed) {
                const count = r[subtaskCountField] || 0;
                if (count > 0) {
                    nextParentIds.push(r.id);
                }
            }

            // Recurse for grandchildren
            const grandchildren = await this._loadChildrenRecursive(
                nextParentIds, fields, context, alreadyLoadedIds, depth + 1
            );

            return [...processed, ...grandchildren];
        } catch (error) {
            console.warn("Failed to load children for parents:", parentIds, error);
            return [];
        }
    }

    /**
     * Merge newly loaded records into this.data.records, avoiding duplicates.
     */
    _mergeNewRecords(newRecords) {
        const existingIds = new Set(this.data.records.map(r => r.id));
        for (const record of newRecords) {
            if (!existingIds.has(record.id)) {
                this.data.records.push(record);
                existingIds.add(record.id);
            }
        }
    }

    /**
     * After initial load + supplement, mark parents whose children
     * are fully present so we don't re-fetch on fold toggle.
     */
    _markLoadedParents() {
        const subtaskCountField = this.archInfo.subtaskCount || "subtask_count";
        const parentField = this.archInfo.parentId || "parent_id";

        // Count loaded children per parent
        const childCountMap = new Map();
        for (const record of this.data.records) {
            const pid = Array.isArray(record[parentField])
                ? record[parentField][0]
                : (record[parentField] || 0);
            if (pid) {
                childCountMap.set(pid, (childCountMap.get(pid) || 0) + 1);
            }
        }

        for (const record of this.data.records) {
            const declared = record[subtaskCountField] || 0;
            if (declared <= 0) continue;
            const loaded = childCountMap.get(record.id) || 0;
            if (loaded >= declared) {
                this._childrenLoadedSet.add(record.id);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Phase 3: Lazy-load children on fold toggle
    // -------------------------------------------------------------------------

    /**
     * Load children for a single parent on-demand (when user unfolds).
     * Handles multi-level: if loaded children also have subtasks, recurse.
     * @param {number} parentId
     * @returns {boolean} true if new records were loaded
     */
    async _lazyLoadChildren(parentId) {
        const fields = this._getFieldsToFetch();
        const parentField = this.archInfo.parentId || "parent_id";
        const subtaskCountField = this.archInfo.subtaskCount || "subtask_count";

        const alreadyLoadedIds = new Set(this.data.records.map(r => r.id));

        const newRecords = await this._loadChildrenRecursive(
            [parentId], fields, {}, alreadyLoadedIds
        );

        if (newRecords.length === 0) return false;

        // Merge into data
        this._mergeNewRecords(newRecords);

        // Add to the correct group(s)
        this._assignRecordsToGroups(newRecords);

        // Mark this parent and any fully-loaded sub-parents
        this._childrenLoadedSet.add(parentId);
        for (const r of newRecords) {
            const count = r[subtaskCountField] || 0;
            if (count > 0) {
                // Check if all its children are now loaded
                const loadedChildCount = this.data.records.filter(rec => {
                    const pid = Array.isArray(rec[parentField])
                        ? rec[parentField][0]
                        : (rec[parentField] || 0);
                    return pid === r.id;
                }).length;
                if (loadedChildCount >= count) {
                    this._childrenLoadedSet.add(r.id);
                }
            }
        }

        // Expand time range if new records have dates outside current range
        this._expandTimeRange(newRecords);

        // Rebuild tree structure with new records
        this._buildTree();

        // Load predecessors for new tasks (they may link to existing tasks)
        const newTaskIds = newRecords.map(r => r.id);
        await this._supplementPredecessors(newTaskIds);

        return true;
    }

    /**
     * Assign newly loaded records to the correct group (project).
     */
    _assignRecordsToGroups(newRecords) {
        const groupField = this.archInfo.mainGroupIdName || "project_id";

        for (const record of newRecords) {
            const groupValue = record[groupField];
            const groupId = Array.isArray(groupValue) ? groupValue[0] : (groupValue || 0);
            const groupName = Array.isArray(groupValue) ? groupValue[1] : String(groupValue || "\u672A\u5206\u914D\u5C08\u6848");

            let group = this.data.groups.find(g => g.id === groupId);
            if (!group) {
                // Create new group if child is in a different project
                group = {
                    id: groupId,
                    name: groupName,
                    records: [],
                    fold: false,
                    _isGroup: true,
                };
                this.data.groups.push(group);
            }

            // Avoid duplicates in group.records
            if (!group.records.some(r => r.id === record.id)) {
                group.records.push(record);
            }
        }
    }

    /**
     * Expand timeStart/timeEnd if new records extend beyond current range.
     */
    _expandTimeRange(newRecords) {
        let changed = false;
        for (const record of newRecords) {
            if (record._dateStart && record._dateStart.isValid) {
                const padded = record._dateStart.minus({ days: 2 }).startOf("day");
                if (!this.data.timeStart || padded < this.data.timeStart) {
                    this.data.timeStart = padded;
                    changed = true;
                }
            }
            if (record._dateEnd && record._dateEnd.isValid) {
                const padded = record._dateEnd.plus({ days: 5 }).endOf("day");
                if (!this.data.timeEnd || padded > this.data.timeEnd) {
                    this.data.timeEnd = padded;
                    changed = true;
                }
            }
        }
        return changed;
    }

    /**
     * Load predecessors that involve newly added task IDs.
     */
    async _supplementPredecessors(newTaskIds) {
        const predModel = this.archInfo.predecessorModel;
        if (!predModel || newTaskIds.length === 0) return;

        const taskIdField = this.archInfo.predecessorTaskId || "task_id";
        const parentTaskIdField = this.archInfo.predecessorParentTaskId || "parent_task_id";
        const typeField = this.archInfo.predecessorType || "type";

        try {
            const domain = [
                "|",
                [taskIdField, "in", newTaskIds],
                [parentTaskIdField, "in", newTaskIds],
            ];
            const fields = [taskIdField, parentTaskIdField, typeField, "lag_hours"];
            const results = await this.orm.searchRead(predModel, domain, fields, { limit: 1000 });

            const allLoadedIds = new Set(this.data.records.map(r => r.id));
            const existingPredKeys = new Set(
                this.data.predecessors.map(p => `${p.task_id}_${p.parent_task_id}`)
            );

            const newPreds = results
                .map(r => ({
                    id: r.id,
                    task_id: Array.isArray(r[taskIdField]) ? r[taskIdField][0] : r[taskIdField],
                    parent_task_id: Array.isArray(r[parentTaskIdField]) ? r[parentTaskIdField][0] : r[parentTaskIdField],
                    type: r[typeField] || "FS",
                    lag_hours: r.lag_hours || 0,
                }))
                .filter(p =>
                    allLoadedIds.has(p.task_id) &&
                    allLoadedIds.has(p.parent_task_id) &&
                    !existingPredKeys.has(`${p.task_id}_${p.parent_task_id}`)
                );

            if (newPreds.length > 0) {
                this.data.predecessors.push(...newPreds);
            }
        } catch (error) {
            console.warn("Failed to supplement predecessors:", error);
        }
    }

    _calculateTimeRange() {
        let minDate = null;
        let maxDate = null;

        for (const record of this.data.records) {
            if (record._dateStart && record._dateStart.isValid) {
                if (!minDate || record._dateStart < minDate) {
                    minDate = record._dateStart;
                }
            }
            if (record._dateEnd && record._dateEnd.isValid) {
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
            const groupName = Array.isArray(groupValue) ? groupValue[1] : String(groupValue || "\u672A\u5206\u914D\u5C08\u6848");

            if (!groups.has(groupId)) {
                groups.set(groupId, {
                    id: groupId,
                    name: groupName,
                    records: [],
                    fold: false,
                    _isGroup: true,
                    _isPlanningMode: false,
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

            }

            // Compute indent levels and WBS numbers
            const computeTreeProps = (id, level, parentWbs) => {
                const children = childrenMap.get(id) || [];
                children.forEach((child, idx) => {
                    child._indent = level;
                    child._wbsNumber = parentWbs ? `${parentWbs}.${idx + 1}` : `${idx + 1}`;
                    computeTreeProps(child.id, level + 1, child._wbsNumber);
                });
            };
            // Root tasks (parentId = 0 or parent not in this group), sorted
            const roots = group.records.filter(r =>
                r._parentId === 0 || !recordMap.has(r._parentId)
            );
            roots.sort(comparator);
            roots.forEach((root, idx) => {
                root._indent = 0;
                root._wbsNumber = `${idx + 1}`;
                computeTreeProps(root.id, 1, root._wbsNumber);
            });

            // Compute summary dates from descendants (bottom-up)
            this._computeGroupSummaryDates(group);

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

    async toggleTaskFold(recordId) {
        const record = this.data.records.find(r => r.id === recordId);
        if (!record || !record._hasChildren) return;

        record._isFolded = !record._isFolded;
        this._foldState.set(recordId, record._isFolded);

        // Write fold state to backend (fire and forget)
        const foldField = this.archInfo.fold || "fold";
        this.orm.write(this.resModel, [recordId], { [foldField]: record._isFolded }).catch(() => {
            this.notification.add("展開/收合狀態儲存失敗", { type: "warning" });
        });

        // Phase 3: Lazy-load children when unfolding a parent whose children
        // haven't been loaded yet
        if (!record._isFolded && !this._childrenLoadedSet.has(recordId)) {
            this._loadingChildrenSet.add(recordId);
            this.notify(); // Show spinner immediately

            try {
                const loaded = await this._lazyLoadChildren(recordId);
                if (loaded) {
                    // _lazyLoadChildren already calls _buildTree
                    this._loadingChildrenSet.delete(recordId);
                    this.notify();
                    return;
                }
            } catch (e) {
                console.warn("Failed to lazy-load children for:", recordId, e);
            }
            this._loadingChildrenSet.delete(recordId);
        }

        // Rebuild tree list for affected group only (not all groups)
        const groupField = this.archInfo.mainGroupIdName || "project_id";
        const groupVal = record[groupField];
        const groupId = Array.isArray(groupVal) ? groupVal[0] : (groupVal || 0);
        this._rebuildTreeForGroup(groupId);
        this.notify();
    }

    /**
     * Check if a parent task is currently loading its children.
     */
    isLoadingChildren(recordId) {
        return this._loadingChildrenSet.has(recordId);
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

            this._computeGroupSummaryDates(group);
            group._treeRecords = this._flattenTree(group.records, childrenMap, recordMap);
        }
    }

    /**
     * Rebuild tree for a single group (targeted rebuild, avoids iterating all groups).
     * Falls back to _rebuildTreeRecords() if group not found.
     */
    _rebuildTreeForGroup(groupId) {
        const group = this.data.groups.find(g => g.id === groupId);
        if (!group) {
            this._rebuildTreeRecords();
            return;
        }

        const parentField = this.archInfo.parentId || "parent_id";
        const sortField = this.archInfo.sortingSeq || "sorting_seq";

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

        const comparator = this._getSortComparator(sortField);
        for (const [, children] of childrenMap) {
            children.sort(comparator);
        }

        this._computeGroupSummaryDates(group);
        group._treeRecords = this._flattenTree(group.records, childrenMap, recordMap);
    }

    /**
     * Compute summary dates (min start, max end) for parent tasks
     * from their descendants, bottom-up.
     */
    _computeGroupSummaryDates(group) {
        const computeForRecord = (record) => {
            if (!record._hasChildren || !record._children || !record._children.length) {
                return;
            }
            // Recurse children first (bottom-up)
            for (const child of record._children) {
                computeForRecord(child);
            }
            let minStart = null;
            let maxEnd = null;
            let weightedProgressSum = 0;
            let totalWeight = 0;
            for (const child of record._children) {
                if (child._isMilestoneRecord) continue;
                const cStart = child._summaryDateStart || child._dateStart;
                const cEnd = child._summaryDateEnd || child._dateEnd;
                if (cStart && (!minStart || cStart < minStart)) minStart = cStart;
                if (cEnd && (!maxEnd || cEnd > maxEnd)) maxEnd = cEnd;
                // Weighted progress: weight by duration (hours)
                const childProgress = child._hasChildren
                    ? (child._summaryProgress ?? 0)
                    : (child._progress ?? 0);
                let duration = 0;
                if (cStart && cEnd) {
                    duration = cEnd.diff(cStart, "hours").hours;
                }
                const weight = Math.max(duration, 1); // minimum weight = 1
                weightedProgressSum += childProgress * weight;
                totalWeight += weight;
            }
            // Enforce FS predecessor constraints: parent summary start cannot
            // be earlier than the latest end date of its FS predecessors.
            if (minStart) {
                const fsMinStart = this.getMinStartFromPredecessors(record.id);
                if (fsMinStart && minStart < fsMinStart) {
                    minStart = fsMinStart;
                }
                record._summaryDateStart = minStart;
            }
            if (maxEnd) record._summaryDateEnd = maxEnd;
            // Summary progress (weighted average by duration)
            record._summaryProgress = totalWeight > 0
                ? weightedProgressSum / totalWeight
                : 0;
        };
        for (const record of group.records) {
            if (record._parentId === 0 || !group.records.some(r => r.id === record._parentId)) {
                computeForRecord(record);
            }
        }
    }

    /**
     * Return a sort comparator function based on current sortMode.
     */
    _getSortComparator(sortField) {
        if (this.sortMode === "start") {
            return (a, b) => {
                const aMs = (a._dateStart && a._dateStart.isValid) ? a._dateStart.toMillis() : Infinity;
                const bMs = (b._dateStart && b._dateStart.isValid) ? b._dateStart.toMillis() : Infinity;
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

            const fields = [taskIdField, parentTaskIdField, typeField, "lag_hours"];
            const results = await this.orm.searchRead(predModel, domain, fields, { limit: 1000 });

            // Normalize: extract [id, name] → id for many2one fields
            this.data.predecessors = results
                .map(r => ({
                    id: r.id,
                    task_id: Array.isArray(r[taskIdField]) ? r[taskIdField][0] : r[taskIdField],
                    parent_task_id: Array.isArray(r[parentTaskIdField]) ? r[parentTaskIdField][0] : r[parentTaskIdField],
                    type: r[typeField] || "FS",
                    lag_hours: r.lag_hours || 0,
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
                loadIdField, "name", "date_from", "date_to",
                "duration", "resource_id", "type_level",
                "color_gantt", "date_aggr",
            ];
            const results = await this.orm.searchRead(loadModel, domain, fields, { limit: 5000 });

            this.data.loadBars = results.map(r => {
                const taskVal = r[loadIdField];
                return {
                    id: r.id,
                    taskId: Array.isArray(taskVal) ? taskVal[0] : taskVal,
                    name: r.name || "",
                    dateStart: GanttModel.parseOdooDate(r.date_from),
                    dateEnd: GanttModel.parseOdooDate(r.date_to),
                    duration: r.duration || 0,
                    resourceId: Array.isArray(r.resource_id) ? r.resource_id[0] : r.resource_id,
                    resourceName: Array.isArray(r.resource_id) ? r.resource_id[1] : "",
                    typeLevel: r.type_level || "cut",
                    color: r.color_gantt || 0,
                    dateAggr: r.date_aggr || null,
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
                            dateStart = GanttModel.parseOdooDate(rawStart + " 08:00:00");
                        } else {
                            dateStart = GanttModel.parseOdooDate(rawStart);
                        }
                    }

                    // Determine end date
                    let dateEnd = null;
                    if (ghostEndField && r[ghostEndField]) {
                        dateEnd = GanttModel.parseOdooDate(r[ghostEndField]);
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
    // Group Avatars (project manager)
    // -------------------------------------------------------------------------

    async _loadGroupAvatars() {
        // Delegates to _loadGroupMetadata for backwards compatibility
        return this._loadGroupMetadata();
    }

    async _loadGroupMetadata() {
        const groupModel = this.archInfo.mainGroupModel;
        if (!groupModel) return;

        const groupIds = this.data.groups.map(g => g.id).filter(id => id);
        if (groupIds.length === 0) return;

        try {
            const results = await this.orm.read(groupModel, groupIds,
                ["user_id", "schedule_start", "schedule_end", "date_start", "date"]);
            const metaMap = new Map();
            for (const r of results) {
                metaMap.set(r.id, r);
            }
            for (const group of this.data.groups) {
                const meta = metaMap.get(group.id);
                if (!meta) continue;
                group._managerId = (meta.user_id && Array.isArray(meta.user_id))
                    ? meta.user_id[0] : null;
                group._scheduleStart = GanttModel.parseOdooDate(meta.schedule_start);
                group._scheduleEnd = GanttModel.parseOdooDate(meta.schedule_end);
                group._isPlanningMode = !meta.schedule_start;
                group._projectDateStart = meta.date_start || false;
                group._projectDateEnd = meta.date || false;
            }
        } catch (error) {
            console.warn("Failed to load group metadata:", error);
        }
    }

    // -------------------------------------------------------------------------
    // Milestones
    // -------------------------------------------------------------------------

    /**
     * Load milestones for all visible projects.
     */
    async _loadMilestones() {
        const milestoneIdField = this.archInfo.milestoneId;
        if (!milestoneIdField) {
            this.data.milestones = [];
            return;
        }

        const groupField = this.archInfo.mainGroupIdName || "project_id";
        const projectIds = [...new Set(
            this.data.groups.map(g => g.id).filter(Boolean)
        )];

        if (projectIds.length === 0) {
            this.data.milestones = [];
            return;
        }

        try {
            const fields = [
                "name", "project_id", "deadline", "is_reached",
                "sorting_seq", "task_count", "color_gantt",
            ];
            const rawMilestones = await this.orm.searchRead(
                "project.milestone",
                [["project_id", "in", projectIds]],
                fields,
                { limit: 500 }
            );

            this.data.milestones = rawMilestones.map(
                ms => this._processMilestoneRecord(ms)
            );
        } catch (error) {
            console.warn("Failed to load milestones:", error);
            this.data.milestones = [];
        }
    }

    /**
     * Convert a raw milestone record into a pseudo-record with negative ID.
     */
    _processMilestoneRecord(ms) {
        let posDate = null;
        if (ms.deadline) {
            // Deadline is a date field (YYYY-MM-DD) — place at 17:00
            const raw = typeof ms.deadline === "string" && ms.deadline.length === 10
                ? ms.deadline + " 17:00:00"
                : ms.deadline;
            posDate = GanttModel.parseOdooDate(raw);
        }

        return {
            ...ms,
            id: -(ms.id),                    // Negative ID to avoid collision
            _milestoneId: ms.id,             // Original ID for ORM calls
            _isMilestoneRecord: true,        // Distinguish from tasks
            _dateStart: posDate,
            _dateEnd: posDate,
            _showLabel: false,
            _scheduleMode: "manual",
            _hasChildren: false,
            _isFolded: false,
            _indent: 0,
            _parentId: 0,
            _wbsNumber: "",
            _milestoneNumber: "",
            _progress: ms.is_reached ? 100 : 0,
            _isVirtualDates: false,
            _planDuration: 0,
            _planOffset: 0,
            sorting_seq: ms.sorting_seq || 0,
            display_name: ms.name,
        };
    }

    /**
     * For milestones without a deadline, compute position from linked tasks.
     */
    _computeMilestonePositions() {
        const milestoneIdField = this.archInfo.milestoneId;
        if (!milestoneIdField) return;

        for (const ms of this.data.milestones) {
            if (ms._dateStart) continue; // Already has a position from deadline

            // Find tasks linked to this milestone
            let maxEnd = null;
            for (const task of this.data.records) {
                const taskMsVal = task[milestoneIdField];
                const taskMsId = Array.isArray(taskMsVal)
                    ? taskMsVal[0] : (taskMsVal || 0);
                if (taskMsId === ms._milestoneId && task._dateEnd) {
                    if (!maxEnd || task._dateEnd > maxEnd) {
                        maxEnd = task._dateEnd;
                    }
                }
            }

            if (maxEnd) {
                ms._dateStart = maxEnd;
                ms._dateEnd = maxEnd;
            } else if (!ms._dateStart) {
                ms._dateStart = this._getMilestoneFallbackDate(ms);
                ms._dateEnd = ms._dateStart;
            }
        }
    }

    /**
     * Compute a sensible fallback date for a milestone with no deadline
     * and no linked tasks. In planning mode (viewport around year 2000),
     * uses the group's last task end; otherwise uses the visible range end.
     */
    _getMilestoneFallbackDate(ms) {
        const projectVal = ms.project_id;
        const projectId = Array.isArray(projectVal)
            ? projectVal[0] : (projectVal || 0);
        const group = this.data.groups.find(g => g.id === projectId);

        // Try to find the last task end in the same project
        let lastEnd = null;
        if (group && group.records) {
            for (const r of group.records) {
                if (r._isMilestoneRecord) continue;
                if (r._dateEnd && (!lastEnd || r._dateEnd > lastEnd)) {
                    lastEnd = r._dateEnd;
                }
            }
        }
        if (lastEnd) return lastEnd;

        // Fallback: use end of visible time range (works for both normal and planning mode)
        if (this.data.timeEnd && this.data.timeEnd.isValid) {
            return this.data.timeEnd.minus({ days: 3 }).startOf("day").set({ hour: 17 });
        }

        return DateTime.now().startOf("day").set({ hour: 17 });
    }

    /**
     * Recompute positions for milestones that derive position from linked tasks.
     * Called after any task date change (drag, resize, plan offset/duration).
     */
    _recomputeMilestonePositions() {
        const milestoneIdField = this.archInfo.milestoneId;
        if (!milestoneIdField || !this.data.milestones.length) return;

        for (const ms of this.data.milestones) {
            // Only recompute for milestones WITHOUT a fixed deadline
            if (ms.deadline) continue;

            let maxEnd = null;
            for (const task of this.data.records) {
                if (task._isMilestoneRecord) continue;
                const taskMsVal = task[milestoneIdField];
                const taskMsId = Array.isArray(taskMsVal)
                    ? taskMsVal[0] : (taskMsVal || 0);
                if (taskMsId === ms._milestoneId && task._dateEnd) {
                    if (!maxEnd || task._dateEnd > maxEnd) {
                        maxEnd = task._dateEnd;
                    }
                }
            }

            if (maxEnd) {
                ms._dateStart = maxEnd;
                ms._dateEnd = maxEnd;
            } else {
                ms._dateStart = this._getMilestoneFallbackDate(ms);
                ms._dateEnd = ms._dateStart;
            }
        }
    }

    /**
     * Inject milestone pseudo-records into corresponding groups.
     * Also push into this.data.records so all lookups work.
     */
    _mergeMilestonesIntoGroups() {
        const groupField = this.archInfo.mainGroupIdName || "project_id";

        for (const ms of this.data.milestones) {
            const projectVal = ms.project_id;
            const projectId = Array.isArray(projectVal)
                ? projectVal[0] : (projectVal || 0);

            const group = this.data.groups.find(g => g.id === projectId);
            if (group) {
                // Avoid duplicates on re-merge
                if (!group.records.some(r => r.id === ms.id)) {
                    group.records.push(ms);
                }
            }
            // Also ensure milestone is in the flat records array
            if (!this.data.records.some(r => r.id === ms.id)) {
                this.data.records.push(ms);
            }
        }

        // Assign milestone numbers (M1, M2, ...) per project group
        this._assignMilestoneNumbers();
    }

    /**
     * Assign M1, M2, ... numbers to milestones, grouped by project and sorted by sorting_seq.
     */
    _assignMilestoneNumbers() {
        const msGroupMap = new Map();
        for (const ms of this.data.milestones) {
            const pid = Array.isArray(ms.project_id) ? ms.project_id[0] : (ms.project_id || 0);
            if (!msGroupMap.has(pid)) msGroupMap.set(pid, []);
            msGroupMap.get(pid).push(ms);
        }
        for (const [, milestones] of msGroupMap) {
            milestones.sort((a, b) => (a.sorting_seq || 0) - (b.sorting_seq || 0));
            milestones.forEach((ms, i) => { ms._milestoneNumber = `M${i + 1}`; });
        }
    }

    /**
     * Build milestoneLinks from task.milestone_id → milestone pseudo-record.
     */
    _buildMilestoneLinks() {
        const milestoneIdField = this.archInfo.milestoneId;
        if (!milestoneIdField) {
            this.data.milestoneLinks = [];
            return;
        }

        const msIdSet = new Set(
            this.data.milestones.map(ms => ms._milestoneId)
        );
        const links = [];

        for (const task of this.data.records) {
            if (task._isMilestoneRecord) continue; // Skip milestone pseudo-records

            const taskMsVal = task[milestoneIdField];
            const taskMsId = Array.isArray(taskMsVal)
                ? taskMsVal[0] : (taskMsVal || 0);

            if (taskMsId && msIdSet.has(taskMsId)) {
                links.push({
                    task_id: task.id,
                    milestone_id: -(taskMsId), // Negative ID matching pseudo-record
                    type: "FS",
                });
            }
        }

        this.data.milestoneLinks = links;
    }

    // -------------------------------------------------------------------------
    // Milestone CRUD
    // -------------------------------------------------------------------------

    async createMilestone(projectId) {
        try {
            // Find max sorting_seq among existing milestones in this project
            const existing = this.data.milestones.filter(ms => {
                const pid = Array.isArray(ms.project_id)
                    ? ms.project_id[0] : (ms.project_id || 0);
                return pid === projectId;
            });
            const maxSeq = existing.reduce(
                (max, ms) => Math.max(max, ms.sorting_seq || 0), 0
            );

            const ids = await this.orm.create("project.milestone", [{
                name: "新里程碑",
                project_id: projectId,
                sorting_seq: maxSeq + 10,
            }]);

            // Read back and process
            const raw = await this.orm.read("project.milestone", ids, [
                "name", "project_id", "deadline", "is_reached",
                "sorting_seq", "task_count",
            ]);
            if (raw && raw.length) {
                const processed = this._processMilestoneRecord(raw[0]);

                // Compute position: use fallback logic (last task end or viewport)
                if (!processed._dateStart) {
                    processed._dateStart = this._getMilestoneFallbackDate(processed);
                    processed._dateEnd = processed._dateStart;
                }

                this.data.milestones.push(processed);

                // Reassign milestone numbers after adding new one
                this._assignMilestoneNumbers();

                // Insert into group and records
                const group = this.data.groups.find(g => g.id === projectId);
                if (group) group.records.push(processed);
                this.data.records.push(processed);

                this._buildTree();
                this.notify();
                return processed.id; // negative ID
            }
            return null;
        } catch (error) {
            console.error("Failed to create milestone:", error);
            return null;
        }
    }

    async deleteMilestone(negativeId) {
        const msId = Math.abs(negativeId);
        try {
            await this.orm.unlink("project.milestone", [msId]);

            // Remove from milestones array
            this.data.milestones = this.data.milestones.filter(
                ms => ms._milestoneId !== msId
            );
            // Remove from records and groups
            for (const group of this.data.groups) {
                group.records = group.records.filter(r => r.id !== negativeId);
            }
            this.data.records = this.data.records.filter(
                r => r.id !== negativeId
            );
            // Rebuild links and tree
            this._buildMilestoneLinks();
            this._buildTree();
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to delete milestone:", error);
            return false;
        }
    }

    async renameMilestone(negativeId, newName) {
        const msId = Math.abs(negativeId);
        try {
            await this.orm.write("project.milestone", [msId], { name: newName });
            // Update local
            const ms = this.data.milestones.find(m => m._milestoneId === msId);
            if (ms) {
                ms.name = newName;
                ms.display_name = newName;
            }
            // Also update in records
            const rec = this.data.records.find(r => r.id === negativeId);
            if (rec) {
                rec.name = newName;
                rec.display_name = newName;
            }
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to rename milestone:", error);
            return false;
        }
    }

    async toggleMilestoneReached(negativeId) {
        const msId = Math.abs(negativeId);
        const ms = this.data.milestones.find(m => m._milestoneId === msId);
        if (!ms) return false;

        const newVal = !ms.is_reached;
        try {
            await this.orm.write("project.milestone", [msId], {
                is_reached: newVal,
            });
            ms.is_reached = newVal;
            ms._progress = newVal ? 100 : 0;
            // Also update in records
            const rec = this.data.records.find(r => r.id === negativeId);
            if (rec) {
                rec.is_reached = newVal;
                rec._progress = newVal ? 100 : 0;
            }
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to toggle milestone:", error);
            return false;
        }
    }

    /**
     * Link a task to a milestone by setting task.milestone_id.
     */
    async linkTaskToMilestone(taskId, milestoneNegId) {
        const msId = Math.abs(milestoneNegId);
        const milestoneIdField = this.archInfo.milestoneId;
        if (!milestoneIdField) return false;

        try {
            await this.orm.write(this.resModel, [taskId], {
                [milestoneIdField]: msId,
            });
            // Update local task record
            const task = this.data.records.find(r => r.id === taskId);
            if (task) {
                task[milestoneIdField] = [msId, ""];
            }
            // Rebuild links and milestone positions
            this._computeMilestonePositions();
            this._buildMilestoneLinks();
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to link task to milestone:", error);
            return false;
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

    async deleteRecords(recordIds) {
        if (!recordIds.length) return;
        await this.orm.unlink(this.resModel, recordIds);
        const idSet = new Set(recordIds);
        for (const group of this.data.groups) {
            group.records = group.records.filter(r => !idSet.has(r.id));
        }
        this.data.records = this.data.records.filter(r => !idSet.has(r.id));
        this._rebuildTreeRecords();
        this.notify();
    }

    // -------------------------------------------------------------------------
    // Create Record (for add subtask)
    // -------------------------------------------------------------------------

    async createRecord(values, context) {
        try {
            const kwargs = context ? { context } : {};
            const recordId = await this.orm.create(this.resModel, [values], kwargs);
            return recordId[0];
        } catch (error) {
            console.error("Failed to create record:", error);
            return null;
        }
    }

    /**
     * Create a sibling record next to the reference task (same parent, same project).
     * Returns the new record ID, or null on failure.
     */
    async createSiblingRecord(referenceId) {
        const record = this.data.records.find(r => r.id === referenceId);
        if (!record) return null;

        const parentField = this.archInfo.parentId || "parent_id";
        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const groupField = this.archInfo.mainGroupIdName || "project_id";
        const nameField = this.archInfo.name || "name";

        const parentId = record._parentId || false;
        const projectVal = record[groupField];
        const projectId = Array.isArray(projectVal) ? projectVal[0] : (projectVal || false);
        const refSeq = record[sortField] || 0;

        // Find next sibling seq to insert between reference and next
        const siblings = this.data.records.filter(r => {
            const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
            return pid === parentId && r.id !== record.id && (r[sortField] || 0) > refSeq;
        });
        let newSeq;
        if (siblings.length > 0) {
            const nextSeq = Math.min(...siblings.map(s => s[sortField] || 0));
            newSeq = Math.floor((refSeq + nextSeq) / 2);
            // If no room between (e.g. refSeq=10, nextSeq=11), push after
            if (newSeq <= refSeq) newSeq = refSeq + 1;
        } else {
            newSeq = refSeq + 10;
        }

        const values = {
            [nameField]: "\u65B0\u4EFB\u52D9",
            [parentField]: parentId,
            [sortField]: newSeq,
            display_in_project: true,
        };
        if (projectId) {
            values[groupField] = projectId;
        }

        // Pass default_project_id and default_parent_id so server defaults
        // (_default_date_start/end) correctly compute dates.
        // Subtasks inherit parent's dates; root tasks use project settings.
        // Planning mode: explicitly set dates to false to guarantee no dates
        // (bypasses default_get entirely for date fields).
        const context = projectId ? { default_project_id: projectId } : {};
        if (parentId) {
            context.default_parent_id = parentId;
        }
        const group = this.data.groups.find(g => g.id === projectId);
        if (group && group._isPlanningMode) {
            const dateStartField = this.archInfo.dateStart || "date_start";
            const dateStopField = this.archInfo.dateStop || "date_end";
            values[dateStartField] = false;
            values[dateStopField] = false;

            // Auto-calculate plan_offset: place after last existing task
            const planOffsetField = this.archInfo.planOffset || "plan_offset";
            let maxEnd = 0;
            for (const r of (group.records || [])) {
                if (r._isMilestoneRecord) continue;
                const end = (r._planOffset || 0) + (r._planDuration || 0);
                if (end > maxEnd) maxEnd = end;
            }
            values[planOffsetField] = maxEnd;
        }

        const newId = await this.createRecord(values, context);
        if (newId) {
            await this._localInsertRecord(newId);
        }
        return newId;
    }

    /**
     * Read a single newly created record and merge it into local data,
     * avoiding a full load() (which triggers 7+ network calls).
     * Only does 1 orm.read + 1 optional _supplementPredecessors call.
     */
    async _localInsertRecord(newId) {
        const fields = this._getFieldsToFetch();
        let raw;
        try {
            raw = await this.orm.read(this.resModel, [newId], fields);
        } catch (e) {
            console.warn("_localInsertRecord: failed to read new record", newId, e);
            return false;
        }
        if (!raw || !raw.length) return false;

        const processed = this._processRecords(raw);
        const newRec = processed[0];

        // Insert into correct group
        const groupField = this.archInfo.mainGroupIdName || "project_id";
        const groupVal = newRec[groupField];
        const groupId = Array.isArray(groupVal) ? groupVal[0] : (groupVal || 0);
        const group = this.data.groups.find(g => g.id === groupId);
        if (group) {
            group.records.push(newRec);
        }
        this.data.records.push(newRec);

        this._buildTree();
        await this._supplementPredecessors([newId]);
        this.notify();
        return true;
    }

    // -------------------------------------------------------------------------
    // Reorder Records (for tree drag-drop)
    // -------------------------------------------------------------------------

    async reorderRecord(recordId, targetId, position) {
        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const parentField = this.archInfo.parentId || "parent_id";

        const record = this.data.records.find(r => r.id === recordId);
        const target = this.data.records.find(r => r.id === targetId);
        if (!record || !target) return false;

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
        } else if (position === "after" && target._hasChildren && !target._isFolded) {
            // Dropping after an expanded parent → insert as its first child
            // Visually the task lands between the parent and its first child,
            // so the intuitive expectation is to become a child of the parent.
            values[parentField] = targetId;
            const children = this.data.records.filter(r => {
                const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
                return pid === targetId;
            });
            const minSeq = children.reduce((min, c) => Math.min(min, c[sortField] || 0), Infinity);
            values[sortField] = Number.isFinite(minSeq) ? minSeq - 5 : 0;
        } else if (position === "before") {
            // Reference the previous task (task directly above target in tree)
            // to determine hierarchy, matching its indent level.
            const prevTask = this._findPreviousInTree(targetId);
            if (prevTask) {
                values[parentField] = prevTask._parentId || false;
            } else {
                // First task in the group → root level
                values[parentField] = false;
            }
            const targetSeq = target[sortField] || 0;
            values[sortField] = targetSeq - 5;
        } else {
            // "after" a leaf or collapsed parent → same level as target
            const targetParentVal = target[parentField];
            const targetParentId = Array.isArray(targetParentVal) ? targetParentVal[0] : (targetParentVal || 0);
            values[parentField] = targetParentId || false;

            const targetSeq = target[sortField] || 0;
            values[sortField] = targetSeq + 5;
        }

        // 1. Optimistic local update — instant UI
        if (record._isMilestoneRecord) {
            // Milestones cannot have parent — only update sorting_seq
            if (values[sortField] !== undefined) {
                record[sortField] = values[sortField];
                record.sorting_seq = values[sortField];
            }
        } else {
            const newParentId = values[parentField];
            record[parentField] = newParentId ? [newParentId, ""] : false;
            record._parentId = newParentId || 0;
            if (values[sortField] !== undefined) {
                record[sortField] = values[sortField];
            }
        }
        this._buildTree();
        this.notify();

        // 2. Persist to server (fire-and-forget)
        if (record._isMilestoneRecord) {
            // Write to project.milestone using original ID
            const msValues = {};
            if (values[sortField] !== undefined) {
                msValues.sorting_seq = values[sortField];
            }
            this.orm.write("project.milestone", [Math.abs(recordId)], msValues).catch(() => {
                this.notification.add("里程碑排序儲存失敗", { type: "warning" });
            });
        } else {
            this.orm.write(this.resModel, [recordId], values).catch(() => {
                this.notification.add("任務排序儲存失敗", { type: "warning" });
            });
        }
        return false; // Tell renderer not to reload
    }

    /**
     * Find the task directly above the given task in the flattened tree.
     * Used by reorderRecord to determine hierarchy when dropping "before".
     * @param {number} targetId
     * @returns {Object|null} the previous record, or null if target is first
     */
    _findPreviousInTree(targetId) {
        for (const group of this.data.groups) {
            const treeRecords = group._treeRecords || [];
            const idx = treeRecords.findIndex(r => r.id === targetId);
            if (idx > 0) {
                return treeRecords[idx - 1];
            }
            if (idx === 0) {
                return null;
            }
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Indent / Outdent (WBS hierarchy manipulation)
    // -------------------------------------------------------------------------

    /**
     * Indent a task: make it a child of its previous sibling at the same level.
     * @param {number} recordId
     * @returns {boolean} true if successful
     */
    async indentTask(recordId) {
        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const parentField = this.archInfo.parentId || "parent_id";

        const record = this.data.records.find(r => r.id === recordId);
        if (!record) return false;

        // Find siblings (same parent, same group)
        const parentId = record._parentId || 0;
        const siblings = this.data.records.filter(r => {
            const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
            return pid === parentId && r.id !== recordId;
        });

        // Sort siblings by seq
        siblings.sort((a, b) => (a[sortField] || 0) - (b[sortField] || 0));

        // Find previous sibling (highest seq that is still < record's seq)
        const recordSeq = record[sortField] || 0;
        let prevSibling = null;
        for (const s of siblings) {
            if ((s[sortField] || 0) < recordSeq) {
                prevSibling = s;
            }
        }

        if (!prevSibling) return false;

        // Calculate new seq: max of prevSibling's children seq + 10
        const prevChildren = this.data.records.filter(r => {
            const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
            return pid === prevSibling.id;
        });
        const maxChildSeq = prevChildren.reduce((max, c) => Math.max(max, c[sortField] || 0), 0);

        try {
            await this.orm.write(this.resModel, [recordId], {
                [parentField]: prevSibling.id,
                [sortField]: maxChildSeq + 10,
            });

            // Unfold the new parent so the moved task is visible
            prevSibling._isFolded = false;
            this._foldState.set(prevSibling.id, false);

            return true;
        } catch (error) {
            console.error("Failed to indent task:", error);
            return false;
        }
    }

    /**
     * Outdent a task: move it up one level, placing it after its current parent.
     * @param {number} recordId
     * @returns {boolean} true if successful
     */
    async outdentTask(recordId) {
        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const parentField = this.archInfo.parentId || "parent_id";

        const record = this.data.records.find(r => r.id === recordId);
        if (!record) return false;

        const currentParentId = record._parentId || 0;
        if (currentParentId === 0) return false; // Already root

        const currentParent = this.data.records.find(r => r.id === currentParentId);
        if (!currentParent) return false;

        // New parent = grandparent (or root if parent is root-level)
        const grandparentId = currentParent._parentId || 0;
        const newParentId = grandparentId || false;

        // Place after the current parent in the grandparent's children order
        const parentSeq = currentParent[sortField] || 0;

        try {
            await this.orm.write(this.resModel, [recordId], {
                [parentField]: newParentId,
                [sortField]: parentSeq + 1,
            });
            return true;
        } catch (error) {
            console.error("Failed to outdent task:", error);
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
            // Auto-calculate lag from current positions
            const source = this.data.records.find(r => r.id === parentTaskId);
            const target = this.data.records.find(r => r.id === taskId);
            let lagHours = 0;

            if (source && target) {
                const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
                const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
                if (sourceEnd && targetStart) {
                    const gapMs = targetStart.toMillis() - sourceEnd.toMillis();
                    lagHours = durationToLag(gapMs);
                }
            }

            const ids = await this.orm.create(predModel, [{
                [taskIdField]: taskId,
                [parentTaskIdField]: parentTaskId,
                [typeField]: type || "FS",
                lag_hours: lagHours,
            }]);

            // Reload predecessors FIRST so the new link is in data
            await this._loadPredecessors();

            // FS link: push successor if sourceEnd overlaps targetStart, then recalc lag
            const linkType = (type || "FS").toUpperCase();
            if (linkType === "FS") {
                await this._pushFSSuccessors(parentTaskId);
                await this._recalcAndUpdateLags(parentTaskId);
            }

            this.notify();
            return ids[0];
        } catch (error) {
            console.error("Failed to create predecessor:", error);
            return null;
        }
    }

    /**
     * Compute the effective source end for a FS constraint, including lag.
     * effectiveEnd = sourceEnd + lagToDuration(pred.lag_hours)
     *
     * @param {Object} source - The predecessor record
     * @param {Object} pred - The predecessor link (with lag_hours)
     * @returns {DateTime|null} The effective end DateTime
     */
    _getEffectiveSourceEnd(source, pred) {
        const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
        if (!sourceEnd) return null;
        const lag = lagToDuration(pred.lag_hours);
        return Object.keys(lag).length > 0 ? sourceEnd.plus(lag) : sourceEnd;
    }

    /**
     * Push all FS successors of a given task forward ONLY if the raw source end
     * physically overlaps the target start (sourceEnd > targetStart).
     * Lag is NOT used as a constraint — it is dynamically recalculated by
     * _recalcAndUpdateLags() after this method.
     *
     * When pushed, the target is moved to exactly sourceEnd (lag becomes 0).
     * Cascades: if pushing successor B causes B's own successors to overlap,
     * they are also pushed.
     * @param {number} recordId - the predecessor whose end may have changed
     * @param {Set} [visited] - cycle guard
     */
    async _pushFSSuccessors(recordId, visited) {
        if (!visited) visited = new Set();
        if (visited.has(recordId)) return;
        visited.add(recordId);

        const source = this.data.records.find(r => r.id === recordId);
        if (!source) return;

        // Raw source end WITHOUT lag — lag is not a push constraint
        const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
        if (!sourceEnd) return;

        const fsSuccessors = this.data.predecessors.filter(p =>
            p.parent_task_id === recordId && (p.type || "FS").toUpperCase() === "FS"
        );

        for (const pred of fsSuccessors) {
            const target = this.data.records.find(r => r.id === pred.task_id);
            if (!target) continue;
            const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
            if (!targetStart) continue;

            // Only push when raw sourceEnd physically overlaps targetStart
            if (targetStart >= sourceEnd) continue;

            // Push target to exactly sourceEnd (lag will be recalculated to 0)
            if (target._hasChildren) {
                const shiftHours = sourceEnd.diff(targetStart, "hours").hours;
                if (Math.abs(shiftHours) > 0.01) {
                    await this.moveRecordWithChildren(target.id, shiftHours);
                }
            } else if (target._isVirtualDates) {
                const newOffset = (source._planOffset || 0) + (source._planDuration || 0);
                const planOffsetField = this.archInfo.planOffset || "plan_offset";
                await this.updateRecord(target.id, { [planOffsetField]: newOffset });
            } else {
                const dateStartField = this.archInfo.dateStart || "date_start";
                const dateStopField = this.archInfo.dateStop || "date_end";
                const newStart = sourceEnd;
                const values = {
                    [dateStartField]: newStart.toFormat("yyyy-MM-dd HH:mm:ss"),
                };
                if (target._dateEnd && target._dateStart) {
                    const duration = target._dateEnd.diff(target._dateStart);
                    values[dateStopField] = newStart.plus(duration).toFormat("yyyy-MM-dd HH:mm:ss");
                }
                await this.updateRecord(target.id, values);
            }

            // Cascade: this successor's end moved, check its own successors
            await this._pushFSSuccessors(pred.task_id, visited);
        }
    }

    /**
     * Recalculate and update lag values for all FS predecessors connected to a task.
     * Called after drag/resize to keep lag in sync with actual positions.
     *
     * @param {number} recordId - The task that was moved/resized
     */
    async _recalcAndUpdateLags(recordId) {
        const predModel = this.archInfo.predecessorModel;
        if (!predModel) return;

        // Find all FS links where this task is source (parent_task_id) or target (task_id)
        const relatedPreds = this.data.predecessors.filter(p =>
            (p.parent_task_id === recordId || p.task_id === recordId) &&
            (p.type || "FS").toUpperCase() === "FS" &&
            p.id
        );

        const writes = [];
        for (const pred of relatedPreds) {
            const source = this.data.records.find(r => r.id === pred.parent_task_id);
            const target = this.data.records.find(r => r.id === pred.task_id);
            if (!source || !target) continue;

            const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
            if (!sourceEnd || !targetStart) continue;

            const gapMs = targetStart.toMillis() - sourceEnd.toMillis();
            const newLagHours = durationToLag(gapMs);

            if (Math.abs(newLagHours - (pred.lag_hours || 0)) > 0.001) {
                pred.lag_hours = newLagHours;
                writes.push(this.orm.write(predModel, [pred.id], { lag_hours: newLagHours }));
            }
        }

        if (writes.length > 0) {
            await Promise.all(writes);
            this.notify();
        }
    }

    /**
     * Get the earliest allowed start DateTime for a task based on its FS predecessors.
     * Returns the latest predecessor end date (WITHOUT lag) among all FS predecessors.
     * Lag is dynamically recalculated after movement, not used as a constraint.
     * Works for both real dates and virtual (planning mode) dates.
     */
    getMinStartFromPredecessors(recordId) {
        const preds = this.data.predecessors.filter(p =>
            p.task_id === recordId && (p.type || "FS").toUpperCase() === "FS"
        );
        if (preds.length === 0) return null;

        let maxEnd = null;
        for (const pred of preds) {
            const source = this.data.records.find(r => r.id === pred.parent_task_id);
            if (!source) continue;
            // Use raw predecessor end (without lag) as the hard FS boundary
            const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            if (sourceEnd && (!maxEnd || sourceEnd > maxEnd)) {
                maxEnd = sourceEnd;
            }
        }
        return maxEnd;
    }

    /**
     * Get the earliest allowed start for a parent task being dragged, considering
     * EXTERNAL FS predecessor constraints only.
     *
     * "External" means the FS source is outside the moving set (parent + all
     * descendants). Internal FS relationships (between siblings/descendants
     * within the same parent) are preserved during uniform movement and must
     * NOT constrain the drag.
     *
     * @param {number} recordId - the parent task being dragged
     * @returns {DateTime|null} the strictest (latest) min start, or null
     */
    getMinStartForParentDrag(recordId) {
        const record = this.data.records.find(r => r.id === recordId);
        if (!record) return null;

        const parentStart = record._summaryDateStart || record._dateStart;
        if (!parentStart) return null;

        // Build the "moving set": self + all descendants
        const movingSet = new Set([recordId]);
        const descendants = [];
        const collect = (rec) => {
            if (rec._children) {
                for (const child of rec._children) {
                    movingSet.add(child.id);
                    descendants.push(child);
                    collect(child);
                }
            }
        };
        collect(record);

        // Only consider EXTERNAL FS predecessors (source outside movingSet)
        let minStart = this._getExternalFsMinStart(recordId, movingSet);

        for (const desc of descendants) {
            const descFsMin = this._getExternalFsMinStart(desc.id, movingSet);
            if (!descFsMin) continue;

            const descStart = (desc._hasChildren && desc._summaryDateStart) || desc._dateStart;
            if (!descStart) continue;

            const offsetMs = descStart.toMillis() - parentStart.toMillis();
            const constrainedParentStart = descFsMin.minus({ milliseconds: offsetMs });

            if (!minStart || constrainedParentStart > minStart) {
                minStart = constrainedParentStart;
            }
        }

        return minStart;
    }

    /**
     * Like getMinStartFromPredecessors but skips FS sources that are in the
     * movingSet (internal relationships preserved during uniform movement).
     */
    _getExternalFsMinStart(recordId, movingSet) {
        const preds = this.data.predecessors.filter(p =>
            p.task_id === recordId &&
            (p.type || "FS").toUpperCase() === "FS" &&
            !movingSet.has(p.parent_task_id)
        );
        if (preds.length === 0) return null;
        let maxEnd = null;
        for (const pred of preds) {
            const source = this.data.records.find(r => r.id === pred.parent_task_id);
            if (!source) continue;
            const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            if (sourceEnd && (!maxEnd || sourceEnd > maxEnd)) {
                maxEnd = sourceEnd;
            }
        }
        return maxEnd;
    }

    /**
     * Get the earliest allowed start for a task, combining:
     * 1. FS predecessor constraints (task cannot start before predecessor ends)
     * 2. Ancestor FS constraints (walk up parent chain, collect their FS boundaries)
     * Parent summary dates auto-adjust when children move, so we only constrain
     * by ancestor FS boundaries — NOT by the parent's current start position.
     * Returns the strictest (latest) DateTime, or null if unconstrained.
     */
    getMinStartForRecord(recordId) {
        const record = this.data.records.find(r => r.id === recordId);
        if (!record) return null;

        let minStart = this.getMinStartFromPredecessors(recordId);

        // Walk up parent chain: only ancestor FS boundaries constrain this task.
        // Parent summary dates auto-adjust when children move, so we don't use
        // parentStart as a hard boundary.
        let current = record;
        while (current._parentId) {
            const parent = this.data.records.find(r => r.id === current._parentId);
            if (!parent) break;
            const parentFsMin = this.getMinStartFromPredecessors(parent.id);
            if (parentFsMin && (!minStart || parentFsMin > minStart)) {
                minStart = parentFsMin;
            }
            current = parent;
        }

        return minStart;
    }

    /**
     * Find the FS predecessor source that blocks the given task (the one
     * whose end date defines the leftward boundary).
     * @param {number} recordId
     * @param {Set} [excludeSourceIds] - skip sources in this set (internal FS)
     * @returns {{ source: Object, sourceEnd: DateTime }|null}
     */
    _findBlockingFsSource(recordId, excludeSourceIds) {
        const preds = this.data.predecessors.filter(p =>
            p.task_id === recordId &&
            (p.type || "FS").toUpperCase() === "FS" &&
            (!excludeSourceIds || !excludeSourceIds.has(p.parent_task_id))
        );
        let maxEnd = null;
        let blockingSource = null;
        for (const pred of preds) {
            const source = this.data.records.find(r => r.id === pred.parent_task_id);
            if (!source) continue;
            const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            if (sourceEnd && (!maxEnd || sourceEnd > maxEnd)) {
                maxEnd = sourceEnd;
                blockingSource = source;
            }
        }
        return blockingSource ? { source: blockingSource, sourceEnd: maxEnd } : null;
    }

    /**
     * Get human-readable info about what FS predecessor is blocking a task
     * from moving further left. Used for boundary-hit notifications.
     * @param {number} recordId
     * @returns {{ message: string, boundaryDate: string }|null}
     */
    getBlockingFsInfo(recordId) {
        const record = this.data.records.find(r => r.id === recordId);
        if (!record) return null;

        const isParent = record._hasChildren;
        let bestSourceEnd = null;
        let bestSourceName = null;
        let throughTaskName = null;

        if (isParent) {
            // Build moving set (same as getMinStartForParentDrag)
            const movingSet = new Set([recordId]);
            const allDescs = [];
            const collectDescs = (rec) => {
                if (rec._children) {
                    for (const c of rec._children) {
                        movingSet.add(c.id);
                        allDescs.push(c);
                        collectDescs(c);
                    }
                }
            };
            collectDescs(record);

            // Own EXTERNAL FS
            const ownBlock = this._findBlockingFsSource(recordId, movingSet);
            if (ownBlock) {
                bestSourceEnd = ownBlock.sourceEnd;
                bestSourceName = ownBlock.source.display_name || `#${ownBlock.source.id}`;
            }
            // Descendants' EXTERNAL FS
            const parentStart = record._summaryDateStart || record._dateStart;
            if (parentStart) {
                for (const desc of allDescs) {
                    const descBlock = this._findBlockingFsSource(desc.id, movingSet);
                    if (!descBlock) continue;
                    const descStart = (desc._hasChildren && desc._summaryDateStart) || desc._dateStart;
                    if (!descStart) continue;
                    const offsetMs = descStart.toMillis() - parentStart.toMillis();
                    const constrainedEnd = descBlock.sourceEnd.minus({ milliseconds: offsetMs });
                    if (!bestSourceEnd || constrainedEnd > bestSourceEnd) {
                        bestSourceEnd = constrainedEnd;
                        bestSourceName = descBlock.source.display_name || `#${descBlock.source.id}`;
                        throughTaskName = desc.display_name || `#${desc.id}`;
                    }
                }
            }
        } else {
            // Own FS
            const ownBlock = this._findBlockingFsSource(recordId);
            if (ownBlock) {
                bestSourceEnd = ownBlock.sourceEnd;
                bestSourceName = ownBlock.source.display_name || `#${ownBlock.source.id}`;
            }
            // Ancestor FS
            let current = record;
            while (current._parentId) {
                const parent = this.data.records.find(r => r.id === current._parentId);
                if (!parent) break;
                const parentBlock = this._findBlockingFsSource(parent.id);
                if (parentBlock && (!bestSourceEnd || parentBlock.sourceEnd > bestSourceEnd)) {
                    bestSourceEnd = parentBlock.sourceEnd;
                    bestSourceName = parentBlock.source.display_name || `#${parentBlock.source.id}`;
                    throughTaskName = parent.display_name || `#${parent.id}`;
                }
                current = parent;
            }
        }

        if (!bestSourceName || !bestSourceEnd) return null;

        const dateStr = bestSourceEnd.toFormat("M/d HH:mm");
        let message;
        if (throughTaskName) {
            message = `\u4efb\u52d9\u79fb\u52d5\u53d7\u9650\uff1a\u300c${throughTaskName}\u300d\u7684\u524d\u7f6e\u4efb\u52d9\u300c${bestSourceName}\u300d(FS) \u7d50\u675f\u65bc ${dateStr}`;
        } else {
            message = `\u4efb\u52d9\u79fb\u52d5\u53d7\u9650\uff1a\u524d\u7f6e\u4efb\u52d9\u300c${bestSourceName}\u300d(FS) \u7d50\u675f\u65bc ${dateStr}`;
        }
        return { message, boundaryDate: dateStr };
    }

    /**
     * Move a parent task and all its descendants by shiftHours,
     * preserving relative positions. Single RPC call to Python.
     */
    async moveRecordWithChildren(recordId, shiftHours) {
        await this.orm.call(this.resModel, "action_move_with_descendants", [[recordId], shiftHours]);
    }

    async updatePredecessor(predId, values) {
        const predModel = this.archInfo.predecessorModel;
        if (!predModel || !predId) return false;

        try {
            const numericId = parseInt(predId, 10);
            if (!numericId) return false;

            const lagChanged = "lag_hours" in values;

            await this.orm.write(predModel, [numericId], values);
            await this._loadPredecessors();

            // If lag changed, move the successor to the new effective position
            if (lagChanged) {
                const pred = this.data.predecessors.find(p => p.id === numericId);
                if (pred && (pred.type || "FS").toUpperCase() === "FS") {
                    const source = this.data.records.find(r => r.id === pred.parent_task_id);
                    const target = this.data.records.find(r => r.id === pred.task_id);
                    if (source && target) {
                        const effectiveEnd = this._getEffectiveSourceEnd(source, pred);
                        const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
                        if (effectiveEnd && targetStart && Math.abs(effectiveEnd.toMillis() - targetStart.toMillis()) > 60000) {
                            if (target._hasChildren) {
                                const shiftHours = effectiveEnd.diff(targetStart, "hours").hours;
                                if (Math.abs(shiftHours) > 0.01) {
                                    await this.moveRecordWithChildren(target.id, shiftHours);
                                }
                            } else {
                                const dateStartField = this.archInfo.dateStart || "date_start";
                                const dateStopField = this.archInfo.dateStop || "date_end";
                                const newStart = effectiveEnd;
                                const vals = {
                                    [dateStartField]: newStart.toFormat("yyyy-MM-dd HH:mm:ss"),
                                };
                                if (target._dateEnd && target._dateStart) {
                                    const duration = target._dateEnd.diff(target._dateStart);
                                    vals[dateStopField] = newStart.plus(duration).toFormat("yyyy-MM-dd HH:mm:ss");
                                }
                                await this.updateRecord(target.id, vals);
                            }
                            // Cascade to this successor's own successors
                            await this._pushFSSuccessors(pred.task_id);
                        }
                    }
                }
            }

            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to update predecessor:", error);
            return false;
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
                const ds = GanttModel.parseOdooDate(r.date_start);
                const de = GanttModel.parseOdooDate(r.date_end);
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
            // Milestone records use negative IDs → write to project.milestone
            const record = this.data.records.find(r => r.id === recordId);
            if (record && record._isMilestoneRecord) {
                const msId = Math.abs(recordId);
                await this.orm.write("project.milestone", [msId], values);
                Object.assign(record, values);
                // Update display_name if name changed
                if (values.name) {
                    record.display_name = values.name;
                }
                // Update is_reached → _progress
                if ("is_reached" in values) {
                    record._progress = values.is_reached ? 100 : 0;
                }
                // Reparse deadline if changed
                if ("deadline" in values) {
                    if (values.deadline) {
                        const dt = GanttModel.parseOdooDate(values.deadline);
                        if (dt) {
                            record._dateStart = dt.hour === 0 ? dt.set({ hour: 17 }) : dt;
                            record._dateEnd = record._dateStart;
                        }
                    } else {
                        // Deadline cleared — recompute from linked tasks
                        record.deadline = false;
                        this._recomputeMilestonePositions();
                    }
                }
                this.notify();
                return true;
            }
            await this.orm.write(this.resModel, [recordId], values);
            // Update local record
            if (record) {
                Object.assign(record, values);
                // Re-process dates if changed
                const dateStartField = this.archInfo.dateStart || "date_start";
                const dateStopField = this.archInfo.dateStop || "date_end";
                if (values[dateStartField]) {
                    record._dateStart = GanttModel.parseOdooDate(values[dateStartField]);
                }
                if (values[dateStopField]) {
                    record._dateEnd = GanttModel.parseOdooDate(values[dateStopField]);
                }
                // Re-process progress if changed, and recompute parent summary progress
                const progressField = this.archInfo.progress || "";
                if (progressField && values[progressField] != null) {
                    record._progress = Number(values[progressField]) || 0;
                    for (const group of this.data.groups) {
                        this._computeGroupSummaryDates(group);
                    }
                }
                // Re-process plan fields and virtual dates if changed
                const planDurationField = this.archInfo.planDuration || "plan_duration";
                const planOffsetField = this.archInfo.planOffset || "plan_offset";
                if (values[planDurationField] != null) {
                    record._planDuration = Number(values[planDurationField]) || 0;
                }
                if (values[planOffsetField] != null) {
                    record._planOffset = Number(values[planOffsetField]) || 0;
                }
                // Regenerate virtual dates if still in planning mode
                if (record._isVirtualDates && (values[planDurationField] != null || values[planOffsetField] != null)) {
                    const T0 = PLANNING_T0;
                    record._dateStart = T0.plus({ hours: record._planOffset });
                    record._dateEnd = T0.plus({ hours: record._planOffset + record._planDuration });
                }
            }
            // Recompute dependent data if date fields changed
            if (values[dateStartField] || values[dateStopField] ||
                values[planDurationField] != null || values[planOffsetField] != null) {
                this._recomputeMilestonePositions();
                // Recompute parent summary dates (child dates may have changed)
                for (const group of this.data.groups) {
                    this._computeGroupSummaryDates(group);
                }
            }
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to update record:", error);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Planning Mode Methods
    // -------------------------------------------------------------------------

    async updatePlanDuration(recordId, hours) {
        const planField = this.archInfo.planDuration || "plan_duration";
        const values = { [planField]: hours };
        // If the record has actual dates (not virtual), also update the end date
        const record = this.data.records.find(r => r.id === recordId);
        if (record && record._dateStart && !record._isVirtualDates) {
            const dateEndField = this.archInfo.dateStop || "date_end";
            const newEnd = record._dateStart.plus({ hours });
            values[dateEndField] = newEnd.toFormat("yyyy-MM-dd HH:mm:ss");
        }
        return this.updateRecord(recordId, values);
    }

    async updatePlanOffset(recordId, offsetHours) {
        const planOffsetField = this.archInfo.planOffset || "plan_offset";
        return this.updateRecord(recordId, { [planOffsetField]: offsetHours });
    }

    async setProjectScheduleStart(groupId, dateStr) {
        const groupModel = this.archInfo.mainGroupModel;
        if (!groupModel) return false;
        await this.orm.call(groupModel, "action_set_schedule_start", [groupId, dateStr]);
        return true;
    }

    async clearProjectScheduleDates(groupId, clearTasks) {
        const groupModel = this.archInfo.mainGroupModel;
        if (!groupModel) return false;
        await this.orm.call(groupModel, "action_clear_schedule_dates", [groupId, clearTasks]);
        return true;
    }
}
