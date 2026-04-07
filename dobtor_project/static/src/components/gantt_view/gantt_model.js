/** @odoo-module **/

import { Model } from "@web/model/model";
import { _t } from "@web/core/l10n/translation";
import { durationToLag, cellsDeltaToDuration } from "./gantt_utils";

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
        // Odoo ORM returns datetimes as UTC strings: "2026-02-10 08:00:00"
        // Parse as UTC, then convert to user's local timezone (matches Odoo's
        // deserializeDateTime behavior in @web/core/l10n/dates).
        let dt = DateTime.fromSQL(value, { zone: "utc" });
        if (dt.isValid) return dt.setZone("default");
        // Fallback: ISO 8601 "2026-02-10T08:00:00" or date-only "2026-02-10"
        dt = DateTime.fromISO(value, { zone: "utc" });
        return dt.isValid ? dt.setZone("default") : null;
    }

    /**
     * Parse an Odoo Date field (date-only, no time component) as local.
     * Date fields like "2026-02-10" have no timezone — they represent a
     * calendar date. Parsing them as UTC then converting to local would
     * shift the date (e.g., UTC midnight → previous day in UTC+8).
     * This method parses directly in the local timezone to avoid that.
     */
    static parseOdooDateAsLocal(value) {
        if (!value) return null;
        if (typeof value !== "string") return null;
        // Date-only: "YYYY-MM-DD" (exactly 10 chars, no space or T)
        if (value.length === 10 && !value.includes(" ") && !value.includes("T")) {
            const dt = DateTime.fromISO(value, { zone: "local" });
            return dt.isValid ? dt : null;
        }
        // Not a pure date string — fall back to standard datetime parsing
        return GanttModel.parseOdooDate(value);
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
            taskInfos: new Map(),  // Critical path info (ES/LS/EF/LF)
            ghostBars: [],    // Baseline/ghost bars for comparison
        };

        // Track fold state across reloads: recordId → boolean
        this._foldState = new Map();
        // Track which parent tasks have had their children loaded (survives reloads)
        this._childrenLoadedSet = new Set();
        // Track which parents are currently loading children (for spinner UI)
        this._loadingChildrenSet = new Set();

        // Indexes for O(1) lookups — rebuilt via _rebuildIndexes()
        this._recordMap = new Map();       // id → record
        this._predByParent = new Map();    // parent_task_id → [pred, ...]
        this._predByChild = new Map();     // task_id → [pred, ...]
        this._predById = new Map();        // pred.id → pred
        this._childrenByParent = new Map(); // _parentId → [record, ...]
        this._groupMap = new Map();        // groupId → group

        this.scale = "day";
        this.sortMode = "seq";  // "seq" | "start" | "name"

        // Item 11: Undo/Redo history stacks
        this._undoStack = [];  // Array of { type, recordId, before: {...}, after: {...} }
        this._redoStack = [];
        this._maxHistory = 30;

        // Deferred task infos refresh
        this._taskInfosStale = false;
        this._taskInfosRefreshTimer = null;
    }

    /**
     * Rebuild all lookup indexes from this.data.records and this.data.predecessors.
     * Must be called whenever records or predecessors are added/removed/replaced.
     */
    _rebuildIndexes() {
        // Record index
        this._recordMap = new Map(this.data.records.map(r => [r.id, r]));

        // Children-by-parent index (_parentId → [record, ...])
        this._childrenByParent = new Map();
        for (const r of this.data.records) {
            const pid = r._parentId ?? 0;
            if (!this._childrenByParent.has(pid)) {
                this._childrenByParent.set(pid, []);
            }
            this._childrenByParent.get(pid).push(r);
        }

        // Group index
        this._groupMap = new Map();
        if (this.data.groups) {
            for (const g of this.data.groups) {
                this._groupMap.set(g.id, g);
            }
        }

        this._rebuildPredIndexes();
    }

    /**
     * Find the group that contains a record, using the group field.
     */
    _getGroupForRecord(recordId) {
        const record = this._recordMap.get(recordId);
        if (!record) return null;
        const groupField = this.archInfo.mainGroupIdName || "project_id";
        const groupValue = record[groupField];
        const groupId = Array.isArray(groupValue) ? groupValue[0] : (groupValue || 0);
        return this._groupMap.get(groupId) || null;
    }

    /**
     * Rebuild predecessor indexes only. Called when only predecessors change.
     */
    _rebuildPredIndexes() {
        this._predByParent = new Map();
        this._predByChild = new Map();
        this._predById = new Map();
        for (const p of this.data.predecessors) {
            if (!this._predByParent.has(p.parent_task_id)) {
                this._predByParent.set(p.parent_task_id, []);
            }
            this._predByParent.get(p.parent_task_id).push(p);
            if (!this._predByChild.has(p.task_id)) {
                this._predByChild.set(p.task_id, []);
            }
            this._predByChild.get(p.task_id).push(p);
            if (p.id) {
                this._predById.set(p.id, p);
            }
        }
    }

    /**
     * Check if any child of the given parent uses virtual dates (planning mode).
     * Uses _childrenByParent index for O(1) lookup + small scan.
     */
    _hasVirtualChild(parentId) {
        const children = this._childrenByParent.get(parentId);
        return children ? children.some(r => r._isVirtualDates) : false;
    }

    async load(props) {
        this._lastLoadProps = props;
        const domain = props.domain || [];
        const context = props.context || {};

        // Clear any pending deferred task infos refresh from previous load cycle
        if (this._taskInfosRefreshTimer) {
            clearTimeout(this._taskInfosRefreshTimer);
            this._taskInfosRefreshTimer = null;
        }
        this._taskInfosStale = false;

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
            // Early index so _autoSupplementChildren and later steps can use _recordMap
            this._recordMap = new Map(this.data.records.map(r => [r.id, r]));

            // Phase 2: Auto-supplement missing children for loaded parent tasks
            await this._autoSupplementChildren(fields, context);

            // Reset children-loaded tracking on full reload
            this._childrenLoadedSet.clear();
            // Mark parents whose children are already present as loaded
            this._markLoadedParents();

            this._calculateTimeRange();
            this._groupRecords();
            await this._loadCalendarInfo();
            this._rescaleVirtualDates();
            await this._loadMilestones();
            this._computeMilestonePositions();
            this._expandTimeRange(this.data.milestones);
            this._mergeMilestonesIntoGroups();
            this._buildMilestoneLinks();
            const results = await Promise.allSettled([
                this._loadPredecessors(),
                this._loadResourceBars(),
                this._loadTaskInfos(),
                this._loadGhostBars(),
                this._loadGroupAvatars(),
            ]);
            const labels = [
                _t("前置關聯"), _t("資源列"), _t("任務資訊"),
                _t("Ghost 列"), _t("群組頭像"),
            ];
            for (let i = 0; i < results.length; i++) {
                if (results[i].status === "rejected") {
                    console.error(`Failed to load ${labels[i]}:`, results[i].reason);
                    this.notification.add(
                        _t("載入%(label)s失敗", { label: labels[i] }),
                        { type: "warning" }
                    );
                }
            }

            // Build lookup indexes after all records + predecessors are loaded,
            // then build tree so predecessor indexes are available during tree construction
            this._rebuildIndexes();
            this._buildTree();

            // Auto-align: detect FS + parent-child constraint violations (dry run — no writes on browse)
            const alignCount = await this._enforceConstraintAlignment({ silent: true, dryRun: true });
            if (alignCount > 0) {
                console.info(`[Gantt] ${alignCount} task(s) have constraint violations (dry-run detected, no auto-write).`);
            }

            this.notify();
        } catch (error) {
            console.error("Failed to fetch Gantt data:", error);
            this.data.records = [];
            this.data.groups = [];
            this._rebuildIndexes();
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
            // Calendar
            "workingDuration",
            // Progress mode
            "progressMode",
        ];

        // Always fetch state for task state display in tree panel
        if (this.fields && "state" in this.fields) {
            fields.add("state");
        }

        // Activity fields — only fetch if the model defines them
        const activityFields = [
            "activity_ids", "activity_state",
            "activity_exception_decoration", "activity_exception_icon",
            "activity_type_icon",
        ];
        for (const af of activityFields) {
            if (this.fields && af in this.fields) {
                fields.add(af);
            }
        }

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

            // Parse progress mode
            const progressModeField = this.archInfo.progressMode || "";
            if (progressModeField && record[progressModeField]) {
                processed._progressMode = record[progressModeField];
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

        // Build child count map in O(n) instead of O(n²) nested filter
        const loadedChildCount = new Map();
        for (const record of this.data.records) {
            const pid = Array.isArray(record[parentField]) ? record[parentField][0] : (record[parentField] || 0);
            if (pid) {
                loadedChildCount.set(pid, (loadedChildCount.get(pid) || 0) + 1);
            }
        }

        // Find parents whose subtask_count exceeds loaded children count
        const parentsNeedingChildren = [];
        for (const record of this.data.records) {
            const declaredCount = record[subtaskCountField] || 0;
            if (declaredCount <= 0) continue;
            if ((loadedChildCount.get(record.id) || 0) < declaredCount) {
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
            this._rescaleVirtualDates(processed);

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
        let added = false;
        for (const record of newRecords) {
            if (!existingIds.has(record.id)) {
                this.data.records.push(record);
                existingIds.add(record.id);
                added = true;
            }
        }
        if (added) {
            this._rebuildIndexes();
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
        // Rebuild children-by-parent index before checking counts
        this._rebuildIndexes();
        for (const r of newRecords) {
            const count = r[subtaskCountField] || 0;
            if (count > 0) {
                // Use O(1) lookup instead of O(n) filter
                const loadedChildCount = (this._childrenByParent.get(r.id) || []).length;
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
            const groupName = Array.isArray(groupValue) ? groupValue[1] : String(groupValue || _t("未分配專案"));

            let group = this._groupMap.get(groupId);
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
                this._groupMap.set(groupId, group);
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
            const fields = [taskIdField, parentTaskIdField, typeField, "lag_hours", "enable_blocking"];
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
                    enable_blocking: r.enable_blocking !== false,
                }))
                .filter(p =>
                    allLoadedIds.has(p.task_id) &&
                    allLoadedIds.has(p.parent_task_id) &&
                    !existingPredKeys.has(`${p.task_id}_${p.parent_task_id}`)
                );

            if (newPreds.length > 0) {
                this.data.predecessors.push(...newPreds);
                this._rebuildPredIndexes();
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
            const groupName = Array.isArray(groupValue) ? groupValue[1] : String(groupValue || _t("未分配專案"));

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

        // Keep _groupMap in sync for early lookups (before _rebuildIndexes)
        this._groupMap = new Map();
        for (const g of this.data.groups) {
            this._groupMap.set(g.id, g);
        }
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
        const group = this._groupMap.get(groupId);
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
            // Root tasks (parentId = 0 or parent not in this group), excluding milestones
            const roots = group.records.filter(r =>
                !r._isMilestoneRecord && (r._parentId === 0 || !recordMap.has(r._parentId))
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

        // Rebuild _recordMap and _childrenByParent after _parentId is set on all records
        this._recordMap = new Map(this.data.records.map(r => [r.id, r]));
        this._childrenByParent = new Map();
        for (const r of this.data.records) {
            const pid = r._parentId ?? 0;
            if (!this._childrenByParent.has(pid)) {
                this._childrenByParent.set(pid, []);
            }
            this._childrenByParent.get(pid).push(r);
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

    /**
     * O(1) record lookup by id.
     */
    getRecord(id) {
        return this._recordMap.get(id);
    }

    async toggleTaskFold(recordId) {
        const record = this._recordMap.get(recordId);
        if (!record || !record._hasChildren) return;

        record._isFolded = !record._isFolded;
        this._foldState.set(recordId, record._isFolded);

        // Write fold state to backend (fire and forget)
        const foldField = this.archInfo.fold || "fold";
        this.orm.write(this.resModel, [recordId], { [foldField]: record._isFolded }).catch(() => {
            this.notification.add(_t("展開/收合狀態儲存失敗"), { type: "warning" });
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
        const group = this._groupMap.get(groupId);
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
            if (record._parentId === 0 || !this._recordMap.has(record._parentId)) {
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

        // Collect visible task IDs.
        // NOTE: Cross-project predecessors are correctly loaded because the
        // domain uses OR (task_id OR parent_task_id in visible tasks), and
        // taskIds is built from all loaded records regardless of project_id.
        // The post-filter (both ends in taskIds) ensures we only keep links
        // where both tasks are currently visible/loaded.
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

            const fields = [taskIdField, parentTaskIdField, typeField, "lag_hours", "enable_blocking"];
            const results = await this.orm.searchRead(predModel, domain, fields, { limit: 1000 });

            // Normalize: extract [id, name] → id for many2one fields
            this.data.predecessors = results
                .map(r => ({
                    id: r.id,
                    task_id: Array.isArray(r[taskIdField]) ? r[taskIdField][0] : r[taskIdField],
                    parent_task_id: Array.isArray(r[parentTaskIdField]) ? r[parentTaskIdField][0] : r[parentTaskIdField],
                    type: r[typeField] || "FS",
                    lag_hours: r.lag_hours || 0,
                    enable_blocking: r.enable_blocking !== false,
                }))
                .filter(p => taskIds.has(p.task_id) && taskIds.has(p.parent_task_id));
        } catch (error) {
            console.warn("Failed to load predecessors:", error);
            this.data.predecessors = [];
        }
        this._rebuildPredIndexes();
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

                    // Parse start date — handle date-only (YYYY-MM-DD) as local to avoid UTC→local shift
                    let dateStart = null;
                    const rawStart = r[ghostStartField];
                    if (rawStart) {
                        if (typeof rawStart === "string" && rawStart.length === 10) {
                            // Date-only field (e.g. "2026-01-15") → parse as local, set to 08:00 workday start
                            const localDate = GanttModel.parseOdooDateAsLocal(rawStart);
                            dateStart = localDate ? localDate.set({ hour: 8, minute: 0, second: 0 }) : null;
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
    // Calendar Info
    // -------------------------------------------------------------------------

    async _loadCalendarInfo() {
        const projectId = this._lastLoadProps?.context?.default_project_id
            || this.data.records[0]?.[this.archInfo.mainGroupIdName || "project_id"]?.[0];
        if (!projectId) {
            this.data.calendarInfo = null;
            return;
        }
        try {
            const timeStart = this.data.timeStart?.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
            const timeEnd = this.data.timeEnd?.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
            const info = await this.orm.call("project.project", "get_calendar_info",
                [[projectId]], { date_from: timeStart, date_to: timeEnd });
            if (info.active) {
                this.data.calendarInfo = info;
                // Pre-compute working weekdays: {'0': [{from, to}, ...], '1': [...]}
                const weekdayMap = {};
                for (const att of info.attendances) {
                    if (!weekdayMap[att.dayofweek]) weekdayMap[att.dayofweek] = [];
                    weekdayMap[att.dayofweek].push({ from: att.hour_from, to: att.hour_to });
                }
                this.data.calendarInfo._weekdayMap = weekdayMap;
                // Set of working weekday numbers: Luxon 1=Mon..7=Sun ← calendar '0'=Mon..'6'=Sun
                this.data.calendarInfo._workingWeekdays = new Set(
                    Object.keys(weekdayMap).map(d => parseInt(d) + 1)
                );
                // Pre-parse leave dates to Luxon DateTime
                this.data.calendarInfo._leaveDays = new Set();
                for (const leave of info.leaves) {
                    const from = DateTime.fromSQL(leave.date_from, { zone: "utc" }).toLocal();
                    const to = DateTime.fromSQL(leave.date_to, { zone: "utc" }).toLocal();
                    if (from.isValid && to.isValid) {
                        let cursor = from.startOf("day");
                        const end = to.startOf("day");
                        while (cursor <= end) {
                            this.data.calendarInfo._leaveDays.add(cursor.toISODate());
                            cursor = cursor.plus({ days: 1 });
                        }
                    }
                }
            } else {
                this.data.calendarInfo = null;
            }
        } catch (e) {
            console.warn("Failed to load calendar info:", e);
            this.data.calendarInfo = null;
        }
    }

    /**
     * Rescale virtual dates so that 1 working day = 1 virtual day on the timeline.
     * plan_offset / plan_duration are in working hours.
     * Virtual timeline uses 24h/day. Scale factor = 24 / hpd.
     * Example: hpd=8 → scaleFactor=3 → 8 working hours = 24 virtual hours = 1 day column.
     *
     * @param {Array} [records] - Optional subset of records to rescale.
     *        If omitted, rescales all records in this.data.records.
     */
    _rescaleVirtualDates(records) {
        const hpd = this.data.calendarInfo?.hours_per_day || 8;
        if (hpd >= 24) return; // No scaling needed

        const scaleFactor = 24 / hpd;
        const T0 = PLANNING_T0;

        for (const record of (records || this.data.records)) {
            if (!record._isVirtualDates) continue;
            record._dateStart = T0.plus({ hours: record._planOffset * scaleFactor });
            record._dateEnd = T0.plus({ hours: (record._planOffset + record._planDuration) * scaleFactor });
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
                "name", "project_id", "deadline", "deadline_datetime",
                "is_reached", "sorting_seq", "task_count", "color_gantt",
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
        if (ms.deadline_datetime) {
            // Use full datetime for precise positioning
            posDate = GanttModel.parseOdooDate(ms.deadline_datetime);
        } else if (ms.deadline) {
            // Fallback: date-only field — place at 17:00
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
     * Compute a fallback date for a milestone with no deadline and no linked
     * tasks. Planning mode → T+0; scheduled mode → last task end or range end.
     */
    _getMilestoneFallbackDate(ms) {
        // Planning mode: unlinked milestones go to T+0
        const isPlanningMode = this.data.records.some(
            r => !r._isMilestoneRecord && r._isVirtualDates);
        if (isPlanningMode) {
            return PLANNING_T0;
        }

        const projectVal = ms.project_id;
        const projectId = Array.isArray(projectVal)
            ? projectVal[0] : (projectVal || 0);
        const group = this._groupMap.get(projectId);

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

        // Fallback: use end of visible time range
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

            const group = this._groupMap.get(projectId);
            if (group) {
                // Avoid duplicates on re-merge
                if (!group.records.some(r => r.id === ms.id)) {
                    group.records.push(ms);
                }
            }
            // Also ensure milestone is in the flat records array
            if (!this._recordMap.has(ms.id)) {
                this.data.records.push(ms);
                this._recordMap.set(ms.id, ms);
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

    /**
     * Get the earliest allowed deadline for a milestone.
     * Returns the latest end date among all tasks linked to this milestone.
     * @param {number} milestoneId - negative ID of the milestone pseudo-record
     * @returns {DateTime|null}
     */
    getMinDateForMilestone(milestoneId) {
        const links = (this.data.milestoneLinks || []).filter(l => l.milestone_id === milestoneId);
        if (links.length === 0) return null;
        let maxEnd = null;
        for (const link of links) {
            const task = this._recordMap.get(link.task_id);
            if (!task) continue;
            const taskEnd = (task._hasChildren && task._summaryDateEnd) || task._dateEnd;
            if (taskEnd && (!maxEnd || taskEnd > maxEnd)) {
                maxEnd = taskEnd;
            }
        }
        return maxEnd;
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
                name: _t("新里程碑"),
                project_id: projectId,
                sorting_seq: maxSeq + 10,
            }]);

            // Read back and process
            const raw = await this.orm.read("project.milestone", ids, [
                "name", "project_id", "deadline", "deadline_datetime",
                "is_reached", "sorting_seq", "task_count", "color_gantt",
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
                const group = this._groupMap.get(projectId);
                if (group) group.records.push(processed);
                this.data.records.push(processed);
                this._rebuildIndexes();

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
            this._rebuildIndexes();
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
            const rec = this._recordMap.get(negativeId);
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
            const rec = this._recordMap.get(negativeId);
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
            const task = this._recordMap.get(taskId);
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
        try {
            await this.orm.unlink(this.resModel, [recordId]);
        } catch (error) {
            console.error("deleteRecord failed:", error);
            this.notification?.add(_t("刪除失敗"), { type: "warning" });
            return;
        }
        // Remove from local data
        for (const group of this.data.groups) {
            group.records = group.records.filter(r => r.id !== recordId);
        }
        this.data.records = this.data.records.filter(r => r.id !== recordId);
        // Clean up related predecessors and milestone links
        this.data.predecessors = this.data.predecessors.filter(
            p => p.task_id !== recordId && p.parent_task_id !== recordId
        );
        if (this.data.milestoneLinks) {
            this.data.milestoneLinks = this.data.milestoneLinks.filter(
                l => l.task_id !== recordId && l.milestone_id !== recordId
            );
        }
        this._rebuildIndexes();
        this._rebuildTreeRecords();
        // Recompute parent summaries (deleted child may shrink parent's range)
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this._recomputeMilestonePositions();
        this.notify();
    }

    async deleteRecords(recordIds) {
        if (!recordIds.length) return;
        try {
            await this.orm.unlink(this.resModel, recordIds);
        } catch (error) {
            console.error("deleteRecords failed:", error);
            this.notification?.add(_t("刪除失敗"), { type: "warning" });
            return;
        }
        const idSet = new Set(recordIds);
        for (const group of this.data.groups) {
            group.records = group.records.filter(r => !idSet.has(r.id));
        }
        this.data.records = this.data.records.filter(r => !idSet.has(r.id));
        // Clean up related predecessors and milestone links
        this.data.predecessors = this.data.predecessors.filter(
            p => !idSet.has(p.task_id) && !idSet.has(p.parent_task_id)
        );
        if (this.data.milestoneLinks) {
            this.data.milestoneLinks = this.data.milestoneLinks.filter(
                l => !idSet.has(l.task_id) && !idSet.has(l.milestone_id)
            );
        }
        this._rebuildIndexes();
        this._rebuildTreeRecords();
        // Recompute parent summaries (deleted child may shrink parent's range)
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this._recomputeMilestonePositions();
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
        const record = this._recordMap.get(referenceId);
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
            [nameField]: _t("新任務"),
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
        const group = this._groupMap.get(projectId);
        if (group && group._isPlanningMode) {
            const dateStartField = this.archInfo.dateStart || "date_start";
            const dateStopField = this.archInfo.dateStop || "date_end";
            values[dateStartField] = false;
            values[dateStopField] = false;

            // Place new sibling at the same offset as the reference record
            const planOffsetField = this.archInfo.planOffset || "plan_offset";
            values[planOffsetField] = record._planOffset || 0;
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
        this._rescaleVirtualDates(processed);
        const newRec = processed[0];

        // Insert into correct group
        const groupField = this.archInfo.mainGroupIdName || "project_id";
        const groupVal = newRec[groupField];
        const groupId = Array.isArray(groupVal) ? groupVal[0] : (groupVal || 0);
        const group = this._groupMap.get(groupId);
        if (group) {
            group.records.push(newRec);
        }
        this.data.records.push(newRec);
        this._rebuildIndexes();

        this._buildTree();
        await this._supplementPredecessors([newId]);
        // Recompute parent summaries (new task may extend parent's range)
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this._recomputeMilestonePositions();
        this.notify();
        return true;
    }

    // -------------------------------------------------------------------------
    // Reorder Records (for tree drag-drop)
    // -------------------------------------------------------------------------

    async reorderRecord(recordId, targetId, position) {
        const sortField = this.archInfo.sortingSeq || "sorting_seq";
        const parentField = this.archInfo.parentId || "parent_id";

        const record = this._recordMap.get(recordId);
        const target = this._recordMap.get(targetId);
        if (!record || !target) return false;

        const _pid = (r) => {
            const v = r[parentField];
            return Array.isArray(v) ? v[0] : (v || 0);
        };

        const values = {};
        const isMilestone = record._isMilestoneRecord;

        if (isMilestone) {
            // Milestones are always root-level, ignore parent changes
            values[parentField] = false;
        } else if (position === "child") {
            values[parentField] = targetId;
        } else if (position === "after" && target._hasChildren && !target._isFolded) {
            values[parentField] = targetId;
        } else if (position === "before") {
            values[parentField] = _pid(target) || false;
        } else {
            values[parentField] = _pid(target) || false;
        }

        // Determine the sibling lookup parent.
        // Milestones always live at root (parentId=0) and share the seq space
        // with root-level tasks, so siblings must include both types.
        const newParentId = isMilestone ? 0 : (values[parentField] || 0);

        // Gather siblings under the same parent (excluding the dragged record).
        // Tasks and milestones at the same level share sorting_seq order.
        const siblings = this.data.records.filter(r => {
            if (r.id === recordId) return false;
            // Milestones are root-only; include them when looking at root siblings
            if (r._isMilestoneRecord) return newParentId === 0;
            return _pid(r) === newParentId;
        });
        siblings.sort((a, b) => (a[sortField] || 0) - (b[sortField] || 0));

        // Find the target's index within siblings to determine insertion point
        const targetIdx = siblings.findIndex(r => r.id === targetId);

        let insertIdx;
        if (!isMilestone && position === "child") {
            insertIdx = siblings.length;
        } else if (!isMilestone && position === "after" && target._hasChildren && !target._isFolded) {
            insertIdx = 0;
        } else if (position === "before") {
            insertIdx = targetIdx >= 0 ? targetIdx : 0;
        } else {
            // "after"
            insertIdx = targetIdx >= 0 ? targetIdx + 1 : siblings.length;
        }

        // Insert record into siblings and resequence all with even spacing
        siblings.splice(insertIdx, 0, record);
        const seqUpdates = []; // {id, model, seq} for server persist
        siblings.forEach((r, i) => {
            const newSeq = (i + 1) * 10;
            if (r[sortField] !== newSeq) {
                r[sortField] = newSeq;
                if (r._isMilestoneRecord) {
                    r.sorting_seq = newSeq;
                    seqUpdates.push({ id: Math.abs(r.id), model: "project.milestone", seq: newSeq });
                } else {
                    seqUpdates.push({ id: r.id, model: this.resModel, seq: newSeq });
                }
            }
        });
        values[sortField] = record[sortField];

        // 1. Optimistic local update — instant UI
        if (record._isMilestoneRecord) {
            // Milestones cannot have parent — only update sorting_seq
        } else {
            const pid = values[parentField];
            record[parentField] = pid ? [pid, ""] : false;
            record._parentId = pid || 0;
        }
        this._buildTree();
        // Recompute parent summaries for both old and new parent
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this.notify();

        // 2. Persist to server — single batch RPC
        const taskBatch = [];
        const msBatch = [];
        for (const u of seqUpdates) {
            if (u.model === "project.milestone") {
                msBatch.push({ id: u.id, sorting_seq: u.seq });
            } else {
                const entry = { id: u.id, sorting_seq: u.seq };
                if (u.id === recordId && !isMilestone) {
                    entry.parent_id = values[parentField] || false;
                }
                taskBatch.push(entry);
            }
        }
        if (!isMilestone && !taskBatch.some(u => u.id === recordId)) {
            taskBatch.push({
                id: recordId,
                parent_id: values[parentField] || false,
                sorting_seq: record[sortField],
            });
        }
        await this.batchResequence(taskBatch, msBatch);

        // --- Item 8: FS constraint check after vertical reorder ---
        // After parent_id change, the moved task may now violate FS constraints
        // in its new position. Auto-align if so.
        if (!isMilestone) {
            const movedRecord = this._recordMap.get(recordId);
            if (movedRecord) {
                const minStart = this.getMinStartForRecord(recordId);
                if (minStart && movedRecord._dateStart && movedRecord._dateStart < minStart) {
                    // Auto-align: push the moved task forward
                    const _skipSnap = { context: { skip_date_snap: true } };
                    const dateStartField = this.archInfo.dateStart || "date_start";
                    const dateStopField = this.archInfo.dateStop || "date_end";
                    if (movedRecord._isVirtualDates) {
                        const hpd = this.data.calendarInfo?.hours_per_day || 8;
                        const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                        const T0 = PLANNING_T0;
                        const minVirtualHours = minStart.diff(T0, "hours").hours;
                        const newOffset = minVirtualHours / scaleFactor;
                        const planOffsetField = this.archInfo.planOffset || "plan_offset";
                        await this.updateRecord(recordId, { [planOffsetField]: newOffset }, _skipSnap);
                    } else {
                        const fsValues = {
                            [dateStartField]: minStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss"),
                        };
                        if (movedRecord._dateEnd && movedRecord._dateStart) {
                            const duration = movedRecord._dateEnd.diff(movedRecord._dateStart);
                            fsValues[dateStopField] = minStart.plus(duration).setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                        }
                        await this.updateRecord(recordId, fsValues, _skipSnap);
                    }
                    // Cascade
                    const visited = new Set();
                    await this._pushFSSuccessors(recordId, visited);
                    await this._pushAncestorFSSuccessors(recordId, visited);
                    await this._recalcAndUpdateLags(recordId);
                    // Notify user
                    this.notification.add(
                        _t("任務已自動對齊至 FS 約束邊界"),
                        { type: "info" }
                    );
                }
            }
        }

        return false; // Tell renderer not to reload
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

        const record = this._recordMap.get(recordId);
        if (!record || record._isMilestoneRecord) return false;

        // Find task siblings (same parent, exclude milestones)
        const parentId = record._parentId || 0;
        const siblings = this.data.records.filter(r => {
            if (r._isMilestoneRecord) return false;
            const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
            return pid === parentId && r.id !== recordId;
        });
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
            if (r._isMilestoneRecord) return false;
            const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
            return pid === prevSibling.id;
        });
        const maxChildSeq = prevChildren.reduce((max, c) => Math.max(max, c[sortField] || 0), 0);
        const newSeq = maxChildSeq + 10;

        // Optimistic local update — instant UI
        record[parentField] = [prevSibling.id, ""];
        record._parentId = prevSibling.id;
        record[sortField] = newSeq;
        prevSibling._isFolded = false;
        this._foldState.set(prevSibling.id, false);
        this._buildTree();
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this.notify();

        // Persist to server
        try {
            await this.orm.write(this.resModel, [recordId], {
                [parentField]: prevSibling.id,
                [sortField]: newSeq,
            });
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

        const record = this._recordMap.get(recordId);
        if (!record || record._isMilestoneRecord) return false;

        const currentParentId = record._parentId || 0;
        if (currentParentId === 0) return false; // Already root

        const currentParent = this._recordMap.get(currentParentId);
        if (!currentParent) return false;

        // New parent = grandparent (or root if parent is root-level)
        const grandparentId = currentParent._parentId || 0;
        const newParentId = grandparentId || false;

        // Gather new siblings, insert record after currentParent, resequence
        const newSiblings = this.data.records.filter(r => {
            if (r.id === recordId) return false;
            if (r._isMilestoneRecord) return newParentId === 0 || newParentId === false;
            const pid = Array.isArray(r[parentField]) ? r[parentField][0] : (r[parentField] || 0);
            return pid === (newParentId || 0);
        });
        newSiblings.sort((a, b) => (a[sortField] || 0) - (b[sortField] || 0));

        // Insert after the current parent in the sibling list
        const parentIdx = newSiblings.findIndex(r => r.id === currentParentId);
        const insertIdx = parentIdx >= 0 ? parentIdx + 1 : newSiblings.length;
        newSiblings.splice(insertIdx, 0, record);

        // Resequence all siblings with even spacing
        const seqUpdates = [];
        newSiblings.forEach((r, i) => {
            const newSeq = (i + 1) * 10;
            if (r[sortField] !== newSeq) {
                r[sortField] = newSeq;
                if (r._isMilestoneRecord) {
                    r.sorting_seq = newSeq;
                    seqUpdates.push({ id: Math.abs(r.id), model: "project.milestone", seq: newSeq });
                } else {
                    seqUpdates.push({ id: r.id, model: this.resModel, seq: newSeq });
                }
            }
        });

        // Optimistic local update — instant UI
        record[parentField] = newParentId ? [newParentId, ""] : false;
        record._parentId = newParentId || 0;
        this._buildTree();
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this.notify();

        // Persist to server — single batch RPC
        const taskBatch = [];
        const msBatch = [];
        for (const u of seqUpdates) {
            if (u.model === "project.milestone") {
                msBatch.push({ id: u.id, sorting_seq: u.seq });
            } else {
                const entry = { id: u.id, sorting_seq: u.seq };
                if (u.id === recordId) {
                    entry.parent_id = newParentId || false;
                }
                taskBatch.push(entry);
            }
        }
        if (!taskBatch.some(u => u.id === recordId)) {
            taskBatch.push({
                id: recordId,
                parent_id: newParentId || false,
                sorting_seq: record[sortField],
            });
        }
        await this.batchResequence(taskBatch, msBatch);
        return true;
    }

    // -------------------------------------------------------------------------
    // Rename Record (for inline edit)
    // -------------------------------------------------------------------------

    async renameRecord(recordId, newName) {
        const nameField = this.archInfo.name || "name";
        try {
            await this.orm.write(this.resModel, [recordId], { [nameField]: newName });
            const record = this._recordMap.get(recordId);
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
            const source = this._recordMap.get(parentTaskId);
            const target = this._recordMap.get(taskId);
            let lagHours = 0;

            if (source && target) {
                const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
                const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
                if (sourceEnd && targetStart) {
                    const gapMs = targetStart.toMillis() - sourceEnd.toMillis();
                    lagHours = durationToLag(gapMs);
                    // Planning mode: convert virtual hours to working hours
                    const isVirtual = source._isVirtualDates || target._isVirtualDates
                        || this._hasVirtualChild(source.id)
                        || this._hasVirtualChild(target.id);
                    if (isVirtual) {
                        const hpd = this.data.calendarInfo?.hours_per_day || 8;
                        const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                        lagHours = lagHours / scaleFactor;
                    }
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

            // Push successor if dependency constraint is violated, then recalc lag
            await this._pushDependencySuccessors(parentTaskId);
            await this._pushAncestorFSSuccessors(parentTaskId);
            await this._recalcAndUpdateLags(parentTaskId);

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
        let lagHrs = pred.lag_hours || 0;
        if (lagHrs === 0) return sourceEnd;
        // If source uses virtual dates (planning mode), scale working-hour lag to virtual hours
        if (source._isVirtualDates) {
            const hpd = this.data.calendarInfo?.hours_per_day || 8;
            const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
            lagHrs = lagHrs * scaleFactor;
        }
        return sourceEnd.plus({ hours: lagHrs });
    }

    /**
     * Push all dependency successors of a given task forward when the source
     * physically overlaps the target according to the dependency type.
     * Supports all 4 types: FS, SS, FF, SF.
     *
     * Lag is NOT used as a constraint — it is dynamically recalculated by
     * _recalcAndUpdateLags() after this method.
     *
     * Push rules (preserving target duration):
     *   FS: sourceEnd > targetStart  → push targetStart to sourceEnd
     *   SS: sourceStart > targetStart → push targetStart to sourceStart
     *   FF: sourceEnd > targetEnd    → push targetEnd to sourceEnd (start = end - duration)
     *   SF: sourceStart > targetEnd  → push targetEnd to sourceStart (start = end - duration)
     *
     * Cascades: if pushing successor B causes B's own successors to overlap,
     * they are also pushed.
     * @param {number} recordId - the predecessor whose dates may have changed
     * @param {Set} [visited] - cycle guard
     */
    async _pushDependencySuccessors(recordId, visited) {
        if (!visited) visited = new Set();
        if (visited.has(recordId)) return;
        visited.add(recordId);

        const source = this._recordMap.get(recordId);
        if (!source) return;

        const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
        const sourceStart = (source._hasChildren && source._summaryDateStart) || source._dateStart;

        const successors = this._predByParent.get(recordId) || [];

        for (const pred of successors) {
            const target = this._recordMap.get(pred.task_id);
            if (!target) continue;

            const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
            const targetEnd = (target._hasChildren && target._summaryDateEnd) || target._dateEnd;
            const linkType = (pred.type || "FS").toUpperCase();

            // Determine if push is needed and what the new target position should be
            let newTargetStart = null;
            if (linkType === "FS") {
                if (!sourceEnd || !targetStart) continue;
                if (targetStart >= sourceEnd) continue;
                newTargetStart = sourceEnd;
            } else if (linkType === "SS") {
                if (!sourceStart || !targetStart) continue;
                if (targetStart >= sourceStart) continue;
                newTargetStart = sourceStart;
            } else if (linkType === "FF") {
                if (!sourceEnd || !targetEnd) continue;
                if (targetEnd >= sourceEnd) continue;
                // Push end to sourceEnd, preserve duration → derive new start
                if (targetStart && targetEnd) {
                    const dur = targetEnd.diff(targetStart);
                    newTargetStart = sourceEnd.minus(dur);
                } else {
                    continue;
                }
            } else if (linkType === "SF") {
                if (!sourceStart || !targetEnd) continue;
                if (targetEnd >= sourceStart) continue;
                // Push end to sourceStart, preserve duration → derive new start
                if (targetStart && targetEnd) {
                    const dur = targetEnd.diff(targetStart);
                    newTargetStart = sourceStart.minus(dur);
                } else {
                    continue;
                }
            } else {
                continue;
            }

            if (!newTargetStart || !targetStart) continue;

            // Apply the push
            const _skipSnap = { context: { skip_date_snap: true } };
            if (target._hasChildren) {
                const anyVirtualChild = this._hasVirtualChild(target.id);
                let shiftHours = newTargetStart.diff(targetStart, "hours").hours;
                if (anyVirtualChild) {
                    const hpd = this.data.calendarInfo?.hours_per_day || 8;
                    const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                    shiftHours = shiftHours / scaleFactor;
                }
                if (Math.abs(shiftHours) > 0.01) {
                    await this.moveRecordWithChildren(target.id, shiftHours, _skipSnap);
                }
            } else if (target._isVirtualDates) {
                const T0 = PLANNING_T0;
                const hpd = this.data.calendarInfo?.hours_per_day || 8;
                const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                const newOffset = newTargetStart.diff(T0, "hours").hours / scaleFactor;
                const planOffsetField = this.archInfo.planOffset || "plan_offset";
                await this.updateRecord(target.id, { [planOffsetField]: newOffset });
            } else {
                const dateStartField = this.archInfo.dateStart || "date_start";
                const dateStopField = this.archInfo.dateStop || "date_end";
                const values = {
                    [dateStartField]: newTargetStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss"),
                };
                if (target._dateEnd && target._dateStart) {
                    const duration = target._dateEnd.diff(target._dateStart);
                    values[dateStopField] = newTargetStart.plus(duration).setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                }
                await this.updateRecord(target.id, values, _skipSnap);
            }

            // Cascade: this successor's dates moved, check its own successors
            await this._pushDependencySuccessors(pred.task_id, visited);
        }
    }

    /**
     * Backward-compatible alias for _pushDependencySuccessors.
     * @param {number} recordId
     * @param {Set} [visited]
     */
    async _pushFSSuccessors(recordId, visited) {
        return this._pushDependencySuccessors(recordId, visited);
    }

    /**
     * After pushing a record's own dependency successors, walk up its parent
     * chain and push each ancestor's dependency successors too (all types).
     *
     * When a child task moves/resizes, the parent's summary dates may change.
     * Without this, the parent's outgoing dependency successors would NOT be
     * pushed, causing overlap and backward horizontal arrows.
     */
    async _pushAncestorFSSuccessors(recordId, sharedVisited) {
        const record = this._recordMap.get(recordId);
        if (!record) return;

        let current = record;
        const ancestorVisited = new Set();
        const pushVisited = sharedVisited || new Set();
        while (current._parentId) {
            const parent = this._recordMap.get(current._parentId);
            if (!parent || !parent._hasChildren) break;
            if (ancestorVisited.has(parent.id)) break;
            ancestorVisited.add(parent.id);

            // Refresh summary dates before checking push (child may have moved)
            const group = this._getGroupForRecord(parent.id);
            if (group) this._computeGroupSummaryDates(group);

            await this._pushDependencySuccessors(parent.id, pushVisited);
            current = parent;
        }
    }

    /**
     * Recalculate and update lag values for all predecessor links connected to a task.
     * Supports all 4 dependency types: FS, SS, FF, SF.
     * Called after drag/resize to keep lag in sync with actual positions.
     *
     * Lag formulas:
     *   FS: lag = targetStart - sourceEnd
     *   SS: lag = targetStart - sourceStart
     *   FF: lag = targetEnd   - sourceEnd
     *   SF: lag = targetEnd   - sourceStart
     *
     * @param {number} recordId - The task that was moved/resized
     */
    async _recalcAndUpdateLags(recordId) {
        const predModel = this.archInfo.predecessorModel;
        if (!predModel) return;

        // Find all links where this task is source (parent_task_id) or target (task_id)
        const relatedPreds = [
            ...(this._predByParent.get(recordId) || []),
            ...(this._predByChild.get(recordId) || []),
        ].filter(p => p.id);

        const writes = [];
        for (const pred of relatedPreds) {
            const source = this._recordMap.get(pred.parent_task_id);
            const target = this._recordMap.get(pred.task_id);
            if (!source || !target) continue;

            const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            const sourceStart = (source._hasChildren && source._summaryDateStart) || source._dateStart;
            const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
            const targetEnd = (target._hasChildren && target._summaryDateEnd) || target._dateEnd;

            const linkType = (pred.type || "FS").toUpperCase();
            let gapMs = null;

            if (linkType === "FS") {
                if (sourceEnd && targetStart) gapMs = targetStart.toMillis() - sourceEnd.toMillis();
            } else if (linkType === "SS") {
                if (sourceStart && targetStart) gapMs = targetStart.toMillis() - sourceStart.toMillis();
            } else if (linkType === "FF") {
                if (sourceEnd && targetEnd) gapMs = targetEnd.toMillis() - sourceEnd.toMillis();
            } else if (linkType === "SF") {
                if (sourceStart && targetEnd) gapMs = targetEnd.toMillis() - sourceStart.toMillis();
            }

            if (gapMs === null) continue;

            let newLagHours = durationToLag(gapMs);
            // Planning mode: convert virtual hours to working hours
            const isVirtual = source._isVirtualDates || target._isVirtualDates
                || this._hasVirtualChild(source.id)
                || this._hasVirtualChild(target.id);
            if (isVirtual) {
                const hpd = this.data.calendarInfo?.hours_per_day || 8;
                const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                newLagHours = newLagHours / scaleFactor;
            }

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
     * Enforce dependency constraints (FS/SS/FF/SF) on all leaf tasks.
     * For each leaf whose start violates getMinStartForRecord(), push it
     * forward. Then cascade via _pushDependencySuccessors.
     *
     * Handles both real dates and virtual dates (planning mode).
     *
     * @param {Object} [options]
     * @param {boolean} [options.silent] - suppress notification
     * @param {boolean} [options.dryRun] - detect violations only, do not write
     * @returns {number} count of aligned (or detected) tasks
     */
    async _enforceConstraintAlignment(options = {}) {
        if (!this.data.predecessors || this.data.predecessors.length === 0) return 0;

        const _skipSnap = { context: { skip_date_snap: true } };
        const dateStartField = this.archInfo.dateStart || "date_start";
        const dateStopField = this.archInfo.dateStop || "date_end";
        const planOffsetField = this.archInfo.planOffset || "plan_offset";
        const dryRun = !!options.dryRun;

        // Leaf tasks sorted by _dateStart ascending (fix earlier tasks first
        // so their FS successors get cascaded correctly)
        const leafTasks = this.data.records
            .filter(r => !r._hasChildren && !r._isMilestoneRecord && r._dateStart)
            .sort((a, b) => a._dateStart.toMillis() - b._dateStart.toMillis());

        const fixedIds = [];

        for (const task of leafTasks) {
            const minStart = this.getMinStartForRecord(task.id);
            if (!minStart) continue;
            if (task._dateStart >= minStart) continue;

            if (dryRun) {
                // Dry run: only collect violation IDs, do not write
                fixedIds.push(task.id);
                continue;
            }

            // Violation: push forward
            if (task._isVirtualDates) {
                const hpd = this.data.calendarInfo?.hours_per_day || 8;
                const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                const minVirtualHours = minStart.diff(PLANNING_T0, "hours").hours;
                const newOffset = minVirtualHours / scaleFactor;
                await this.updateRecord(task.id, { [planOffsetField]: newOffset }, _skipSnap);
            } else {
                const values = {
                    [dateStartField]: minStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss"),
                };
                if (task._dateEnd && task._dateStart) {
                    const duration = task._dateEnd.diff(task._dateStart);
                    values[dateStopField] = minStart.plus(duration)
                        .setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                }
                await this.updateRecord(task.id, values, _skipSnap);
            }
            fixedIds.push(task.id);
        }

        if (fixedIds.length === 0) return 0;

        // In dry-run mode, skip cascading writes and notifications
        if (dryRun) {
            return fixedIds.length;
        }

        // Cascade dependency successors + ancestor dependency successors
        const visited = new Set();
        for (const id of fixedIds) {
            await this._pushDependencySuccessors(id, visited);
        }
        for (const id of fixedIds) {
            await this._pushAncestorFSSuccessors(id, visited);
        }
        for (const id of fixedIds) {
            await this._recalcAndUpdateLags(id);
        }

        // Recompute parent summaries
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }

        if (!options.silent) {
            this.notification.add(
                _t("已自動對齊 %(count)s 個任務", { count: fixedIds.length }),
                { type: "success" }
            );
        }

        return fixedIds.length;
    }

    /**
     * Get the earliest allowed start DateTime for a task based on its predecessors.
     * Constraint rules (all preserve target duration during drag):
     *   FS: target.start >= source.end
     *   SS: target.start >= source.start
     *   FF: target.end   >= source.end   → target.start >= source.end - duration
     *   SF: target.end   >= source.start → target.start >= source.start - duration
     * Lag is dynamically recalculated after movement, not used as a constraint.
     * Works for both real dates and virtual (planning mode) dates.
     */
    getMinStartFromPredecessors(recordId) {
        const allPreds = this._predByChild.get(recordId) || [];
        if (allPreds.length === 0) return null;

        const record = this._recordMap.get(recordId);
        if (!record) return null;

        const targetStart = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const targetEnd = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        // Duration needed to convert end-constraints (FF/SF) into start-constraints
        const durationMs = (targetStart && targetEnd) ? targetEnd.toMillis() - targetStart.toMillis() : 0;

        let minStart = null;

        for (const pred of allPreds) {
            const linkType = (pred.type || "FS").toUpperCase();
            const source = this._recordMap.get(pred.parent_task_id);
            if (!source) continue;

            const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            const sourceStart = (source._hasChildren && source._summaryDateStart) || source._dateStart;

            let boundary = null;
            if (linkType === "FS") {
                // target.start >= source.end
                boundary = sourceEnd;
            } else if (linkType === "SS") {
                // target.start >= source.start
                boundary = sourceStart;
            } else if (linkType === "FF" && durationMs > 0) {
                // target.end >= source.end → target.start >= source.end - duration
                if (sourceEnd) {
                    boundary = sourceEnd.minus({ milliseconds: durationMs });
                }
            } else if (linkType === "SF" && durationMs > 0) {
                // target.end >= source.start → target.start >= source.start - duration
                if (sourceStart) {
                    boundary = sourceStart.minus({ milliseconds: durationMs });
                }
            }

            if (boundary && (!minStart || boundary > minStart)) {
                minStart = boundary;
            }
        }

        return minStart;
    }

    /**
     * Get the earliest allowed end DateTime for a task based on its predecessors.
     * Used for right-side resize (start stays fixed, end moves).
     *   FF: target.end >= source.end
     *   SF: target.end >= source.start
     * FS/SS constrain the start, not the end, so they are not checked here.
     */
    getMinEndFromPredecessors(recordId) {
        const allPreds = this._predByChild.get(recordId) || [];
        if (allPreds.length === 0) return null;

        let minEnd = null;

        for (const pred of allPreds) {
            const linkType = (pred.type || "FS").toUpperCase();
            const source = this._recordMap.get(pred.parent_task_id);
            if (!source) continue;

            let boundary = null;
            if (linkType === "FF") {
                // target.end >= source.end
                boundary = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            } else if (linkType === "SF") {
                // target.end >= source.start
                boundary = (source._hasChildren && source._summaryDateStart) || source._dateStart;
            }

            if (boundary && (!minEnd || boundary > minEnd)) {
                minEnd = boundary;
            }
        }

        return minEnd;
    }

    /**
     * Get the earliest allowed end for a record, combining:
     * 1. FF/SF predecessor constraints
     * 2. Ancestor dependency constraints
     */
    getMinEndForRecord(recordId) {
        const record = this._recordMap.get(recordId);
        if (!record) return null;

        let minEnd = this.getMinEndFromPredecessors(recordId);

        // Walk up parent chain
        let current = record;
        while (current._parentId) {
            const parent = this._recordMap.get(current._parentId);
            if (!parent) break;
            const parentMinEnd = this.getMinEndFromPredecessors(parent.id);
            if (parentMinEnd && (!minEnd || parentMinEnd > minEnd)) {
                minEnd = parentMinEnd;
            }
            current = parent;
        }

        return minEnd;
    }

    /**
     * Get the earliest allowed start for a parent task being dragged, considering
     * EXTERNAL dependency constraints (FS/SS/FF/SF) only.
     *
     * "External" means the dependency source is outside the moving set (parent +
     * all descendants). Internal relationships (between siblings/descendants
     * within the same parent) are preserved during uniform movement and must
     * NOT constrain the drag.
     *
     * @param {number} recordId - the parent task being dragged
     * @returns {DateTime|null} the strictest (latest) min start, or null
     */
    getMinStartForParentDrag(recordId) {
        const record = this._recordMap.get(recordId);
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

        // Only consider EXTERNAL predecessors (source outside movingSet)
        let minStart = this._getExternalMinStart(recordId, movingSet);

        for (const desc of descendants) {
            const descFsMin = this._getExternalMinStart(desc.id, movingSet);
            if (!descFsMin) continue;

            const descStart = (desc._hasChildren && desc._summaryDateStart) || desc._dateStart;
            if (!descStart) continue;

            const offsetMs = descStart.toMillis() - parentStart.toMillis();
            const constrainedParentStart = descFsMin.minus({ milliseconds: offsetMs });

            if (!minStart || constrainedParentStart > minStart) {
                minStart = constrainedParentStart;
            }
        }

        // Walk up ancestor chain: ancestors' dependency predecessors also constrain
        // this sub-parent. E.g. if grandparent A has FS predecessor B, then
        // dragging sub-parent A1 (child of A) must not pull A's summary start
        // before B's end time.
        let current = record;
        while (current._parentId) {
            const ancestor = this._recordMap.get(current._parentId);
            if (!ancestor) break;
            // Ancestor's own external predecessors (outside movingSet)
            const ancestorFsMin = this._getExternalMinStart(ancestor.id, movingSet);
            if (ancestorFsMin) {
                // The ancestor's summary start is driven by its children.
                // If we move recordId left by X, the ancestor's summary start
                // also moves left by at most X. So the constraint on the
                // ancestor translates to a constraint on recordId.
                const ancestorStart = (ancestor._hasChildren && ancestor._summaryDateStart) || ancestor._dateStart;
                if (ancestorStart) {
                    // How far is recordId's start from ancestor's start?
                    const offsetMs = parentStart.toMillis() - ancestorStart.toMillis();
                    // recordId's min start = ancestorFsMin + offset
                    const constrainedStart = ancestorFsMin.plus({ milliseconds: offsetMs });
                    if (!minStart || constrainedStart > minStart) {
                        minStart = constrainedStart;
                    }
                }
            }
            current = ancestor;
        }

        return minStart;
    }

    /**
     * Like getMinStartFromPredecessors but skips sources that are in the
     * movingSet (internal relationships preserved during uniform movement).
     * Considers all 4 dependency types (FS/SS/FF/SF).
     */
    _getExternalMinStart(recordId, movingSet) {
        const allPreds = (this._predByChild.get(recordId) || []).filter(p =>
            !movingSet.has(p.parent_task_id)
        );
        if (allPreds.length === 0) return null;

        const record = this._recordMap.get(recordId);
        if (!record) return null;

        const targetStart = (record._hasChildren && record._summaryDateStart) || record._dateStart;
        const targetEnd = (record._hasChildren && record._summaryDateEnd) || record._dateEnd;
        const durationMs = (targetStart && targetEnd) ? targetEnd.toMillis() - targetStart.toMillis() : 0;

        let minStart = null;

        for (const pred of allPreds) {
            const linkType = (pred.type || "FS").toUpperCase();
            const source = this._recordMap.get(pred.parent_task_id);
            if (!source) continue;

            const sourceEnd = (source._hasChildren && source._summaryDateEnd) || source._dateEnd;
            const sourceStart = (source._hasChildren && source._summaryDateStart) || source._dateStart;

            let boundary = null;
            if (linkType === "FS") {
                boundary = sourceEnd;
            } else if (linkType === "SS") {
                boundary = sourceStart;
            } else if (linkType === "FF" && durationMs > 0) {
                if (sourceEnd) boundary = sourceEnd.minus({ milliseconds: durationMs });
            } else if (linkType === "SF" && durationMs > 0) {
                if (sourceStart) boundary = sourceStart.minus({ milliseconds: durationMs });
            }

            if (boundary && (!minStart || boundary > minStart)) {
                minStart = boundary;
            }
        }

        return minStart;
    }

    /**
     * Get the earliest allowed start for a task, combining:
     * 1. FS/SS/FF/SF predecessor constraints (all converted to min-start)
     * 2. Ancestor dependency constraints (walk up parent chain, collect their boundaries)
     * 3. Task constraint type (SNET/MSO enforce a minimum start date)
     * Parent summary dates auto-adjust when children move, so we only constrain
     * by ancestor boundaries — NOT by the parent's current start position.
     * Returns the strictest (latest) DateTime, or null if unconstrained.
     */
    getMinStartForRecord(recordId) {
        const record = this._recordMap.get(recordId);
        if (!record) return null;

        let minStart = this.getMinStartFromPredecessors(recordId);

        // Walk up parent chain: only ancestor dependency boundaries constrain this task.
        // Parent summary dates auto-adjust when children move, so we don't use
        // parentStart as a hard boundary.
        let current = record;
        while (current._parentId) {
            const parent = this._recordMap.get(current._parentId);
            if (!parent) break;
            const parentMin = this.getMinStartFromPredecessors(parent.id);
            if (parentMin && (!minStart || parentMin > minStart)) {
                minStart = parentMin;
            }
            current = parent;
        }

        // Enforce task constraint type (SNET / MSO push start forward)
        const constrainTypeField = this.archInfo.constrainType || "constrain_type";
        const constrainType = record[constrainTypeField];
        const constrainDate = record._constrainDate;
        if (constrainType && constrainDate) {
            switch (constrainType) {
                case "snet":  // Start Not Earlier Than
                case "mso":   // Must Start On
                    if (!minStart || constrainDate > minStart) {
                        minStart = constrainDate;
                    }
                    break;
                // snlt, fnet, fnlt, mfo do not constrain minStart (they are upper-bound constraints)
            }
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
        const preds = (this._predByChild.get(recordId) || []).filter(p =>
            (p.type || "FS").toUpperCase() === "FS" &&
            (!excludeSourceIds || !excludeSourceIds.has(p.parent_task_id))
        );
        let maxEnd = null;
        let blockingSource = null;
        for (const pred of preds) {
            const source = this._recordMap.get(pred.parent_task_id);
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
        const record = this._recordMap.get(recordId);
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
                const parent = this._recordMap.get(current._parentId);
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
            message = _t("任務移動受限：「%(through)s」的前置任務「%(source)s」(FS) 結束於 %(date)s",
                { through: throughTaskName, source: bestSourceName, date: dateStr });
        } else {
            message = _t("任務移動受限：前置任務「%(source)s」(FS) 結束於 %(date)s",
                { source: bestSourceName, date: dateStr });
        }
        return { message, boundaryDate: dateStr };
    }

    /**
     * Move a parent task and all its descendants by shiftHours,
     * preserving relative positions. Single RPC call to Python.
     */
    async moveRecordWithChildren(recordId, shiftHours, options = {}) {
        const kwargs = options.context ? { context: options.context } : {};
        await this.orm.call(this.resModel, "action_move_with_descendants", [[recordId], shiftHours], kwargs);
        // Sync local records so subsequent logic sees updated dates
        const { Duration } = luxon;
        const shift = Duration.fromObject({ hours: shiftHours });
        // Pre-build parent->children map for O(n) traversal
        const childMap = new Map();
        for (const r of this.data.records) {
            if (r._parentId != null) {
                if (!childMap.has(r._parentId)) childMap.set(r._parentId, []);
                childMap.get(r._parentId).push(r);
            }
        }
        // In planning mode, shiftHours is in working hours but _dateStart/_dateEnd
        // are on the virtual timeline (scaled by 24/hpd). Compute both shifts.
        const hpd = this.data.calendarInfo?.hours_per_day || 8;
        const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
        const virtualShift = Duration.fromObject({ hours: shiftHours * scaleFactor });

        const stack = [recordId];
        const visited = new Set();
        while (stack.length) {
            const id = stack.pop();
            if (visited.has(id)) continue;
            visited.add(id);
            const rec = this._recordMap.get(id);
            if (!rec) continue;
            // Use virtual shift for virtual dates, regular shift for real dates
            const effectiveShift = rec._isVirtualDates ? virtualShift : shift;
            if (rec._dateStart) rec._dateStart = rec._dateStart.plus(effectiveShift);
            if (rec._dateEnd) rec._dateEnd = rec._dateEnd.plus(effectiveShift);
            if (rec._summaryDateStart) rec._summaryDateStart = rec._summaryDateStart.plus(effectiveShift);
            if (rec._summaryDateEnd) rec._summaryDateEnd = rec._summaryDateEnd.plus(effectiveShift);
            if (rec._isVirtualDates) {
                rec._planOffset = (rec._planOffset || 0) + shiftHours;
            }
            // Find children via pre-built map
            for (const child of (childMap.get(id) || [])) {
                stack.push(child.id);
            }
        }
        // Recompute summary dates for all affected groups (ancestors may need update)
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
    }

    /**
     * Single-RPC: write/move → FS cascade → recalc lags → apply diff locally.
     * Replaces the old pattern of updateRecord + pushFS + pushAncestor + recalcLags + reload.
     */
    async moveAndCascade(recordId, vals, shiftHours, options = {}) {
        // Item 11: snapshot before state for undo
        const beforeState = this._snapshotRecord(recordId);
        try {
            const kwargs = {
                vals: vals || null,
                shift_hours: shiftHours ?? null,
            };
            if (options.context) kwargs.context = options.context;

            const diff = await this.orm.call(
                this.resModel, "action_move_and_cascade",
                [[recordId]], kwargs);

            this._applyServerDiff(diff);

            // Item 11: record after state and push to undo stack
            if (beforeState) {
                const afterState = this._snapshotRecord(recordId);
                if (afterState) {
                    this._pushUndoState({
                        type: "move",
                        recordId,
                        before: beforeState,
                        after: afterState,
                    });
                }
            }
            return true;
        } catch (error) {
            console.error("moveAndCascade failed, fallback to reload:", error);
            return false;
        }
    }

    /**
     * Single-RPC batch sorting_seq + parent_id update.
     */
    async batchResequence(taskUpdates, milestoneUpdates = []) {
        try {
            const projectId = this._lastLoadProps?.context?.default_project_id
                || this._lastLoadProps?.context?.active_id || null;
            await this.orm.call(
                this.resModel, "action_batch_resequence",
                [taskUpdates, milestoneUpdates, projectId]);
        } catch (error) {
            console.error("batchResequence failed:", error);
            this.notification?.add(_t("排序儲存失敗"), { type: "warning" });
        }
    }

    /**
     * Zero all lags and compact tasks left (CPM Early Start).
     */
    async compactLeft(projectId) {
        await this.orm.call(
            this.resModel, "action_compact_left", [projectId]);
    }

    /**
     * Mark task infos (critical path ES/LS/EF/LF) as stale.
     * Triggers a deferred refresh after 2 seconds of inactivity.
     */
    _markTaskInfosStale() {
        this._taskInfosStale = true;
        if (this._taskInfosRefreshTimer) {
            clearTimeout(this._taskInfosRefreshTimer);
        }
        this._taskInfosRefreshTimer = setTimeout(async () => {
            this._taskInfosRefreshTimer = null;
            if (!this._taskInfosStale) return;
            try {
                await this._loadTaskInfos();
                this._taskInfosStale = false;
                this.notify();
            } catch (e) {
                console.warn("Deferred task infos refresh failed:", e);
            }
        }, 2000);
    }

    /**
     * Apply server diff to local records without full reload.
     */
    _applyServerDiff(diff) {
        if (!diff) return;
        const dateStartField = this.archInfo.dateStart || "date_start";
        const dateStopField = this.archInfo.dateStop || "date_end";
        const planDurField = this.archInfo.planDuration || "plan_duration";
        const planOffField = this.archInfo.planOffset || "plan_offset";
        const wdField = this.archInfo.workingDuration || "working_duration";

        if (diff.tasks) {
            for (const [idStr, fields] of Object.entries(diff.tasks)) {
                const record = this._recordMap.get(parseInt(idStr));
                if (!record) continue;
                Object.assign(record, fields);
                // Re-parse dates
                if (fields[dateStartField]) {
                    record._dateStart = GanttModel.parseOdooDate(fields[dateStartField]);
                }
                if (fields[dateStopField]) {
                    record._dateEnd = GanttModel.parseOdooDate(fields[dateStopField]);
                }
                if (fields[planDurField] != null) {
                    record._planDuration = Number(fields[planDurField]) || 0;
                }
                if (fields[planOffField] != null) {
                    record._planOffset = Number(fields[planOffField]) || 0;
                }
                if (fields[wdField] != null) {
                    record[wdField] = Number(fields[wdField]) || 0;
                }
                // Re-parse constraint date
                const constrainDateField = this.archInfo.constrainDate || "constrain_date";
                if (constrainDateField in fields) {
                    record._constrainDate = fields[constrainDateField]
                        ? GanttModel.parseOdooDate(fields[constrainDateField])
                        : null;
                }
                // Regenerate virtual dates if in planning mode
                if (record._isVirtualDates) {
                    const T0 = PLANNING_T0;
                    const hpd = this.data.calendarInfo?.hours_per_day || 8;
                    const sf = (hpd < 24) ? (24 / hpd) : 1;
                    record._dateStart = T0.plus({ hours: record._planOffset * sf });
                    record._dateEnd = T0.plus({ hours: (record._planOffset + record._planDuration) * sf });
                }
            }
        }
        if (diff.predecessors) {
            for (const [idStr, fields] of Object.entries(diff.predecessors)) {
                const pred = this._predById.get(parseInt(idStr));
                if (pred && fields.lag_hours != null) {
                    pred.lag_hours = fields.lag_hours;
                }
            }
        }
        // Recompute summaries
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this._recomputeMilestonePositions();
        this._markTaskInfosStale();
        this.notify();
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
                const pred = this._predById.get(numericId);
                if (pred && (pred.type || "FS").toUpperCase() === "FS") {
                    const source = this._recordMap.get(pred.parent_task_id);
                    const target = this._recordMap.get(pred.task_id);
                    if (source && target) {
                        const effectiveEnd = this._getEffectiveSourceEnd(source, pred);
                        const targetStart = (target._hasChildren && target._summaryDateStart) || target._dateStart;
                        if (effectiveEnd && targetStart && Math.abs(effectiveEnd.toMillis() - targetStart.toMillis()) > 60000) {
                            const _skipSnap = { context: { skip_date_snap: true } };
                            if (target._hasChildren) {
                                let shiftHours = effectiveEnd.diff(targetStart, "hours").hours;
                                // Virtual timeline hours → working hours for backend
                                const anyVirtualChild = this._hasVirtualChild(target.id);
                                if (anyVirtualChild) {
                                    const hpd = this.data.calendarInfo?.hours_per_day || 8;
                                    const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                                    shiftHours = shiftHours / scaleFactor;
                                }
                                if (Math.abs(shiftHours) > 0.01) {
                                    await this.moveRecordWithChildren(target.id, shiftHours, _skipSnap);
                                }
                            } else if (target._isVirtualDates) {
                                // Planning mode leaf: write plan_offset instead of real dates
                                const T0 = PLANNING_T0;
                                const hpd = this.data.calendarInfo?.hours_per_day || 8;
                                const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                                const newOffset = effectiveEnd.diff(T0, "hours").hours / scaleFactor;
                                const planOffsetField = this.archInfo.planOffset || "plan_offset";
                                await this.updateRecord(target.id, { [planOffsetField]: newOffset }, _skipSnap);
                            } else {
                                const dateStartField = this.archInfo.dateStart || "date_start";
                                const dateStopField = this.archInfo.dateStop || "date_end";
                                const newStart = effectiveEnd;
                                const vals = {
                                    [dateStartField]: newStart.setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss"),
                                };
                                if (target._dateEnd && target._dateStart) {
                                    const duration = target._dateEnd.diff(target._dateStart);
                                    vals[dateStopField] = newStart.plus(duration).setZone("utc").toFormat("yyyy-MM-dd HH:mm:ss");
                                }
                                await this.updateRecord(target.id, vals, _skipSnap);
                            }
                            // Cascade to this successor's own successors
                            await this._pushFSSuccessors(pred.task_id);
                            await this._pushAncestorFSSuccessors(pred.task_id);
                            await this._recalcAndUpdateLags(pred.task_id);
                        }
                    }
                }
            }

            for (const group of this.data.groups) {
                this._computeGroupSummaryDates(group);
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

    async updateRecord(recordId, values, options = {}) {
        try {
            // Milestone records use negative IDs → write to project.milestone
            const record = this._recordMap.get(recordId);
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
                // Reparse deadline_datetime if changed
                if ("deadline_datetime" in values) {
                    if (values.deadline_datetime) {
                        const dt = GanttModel.parseOdooDate(values.deadline_datetime);
                        if (dt) {
                            record._dateStart = dt;
                            record._dateEnd = dt;
                            // Sync deadline (date part) for local record
                            record.deadline = dt.toFormat("yyyy-MM-dd");
                        }
                    } else {
                        record.deadline_datetime = false;
                        record.deadline = false;
                        this._recomputeMilestonePositions();
                    }
                } else if ("deadline" in values) {
                    if (values.deadline) {
                        const dt = GanttModel.parseOdooDate(values.deadline);
                        if (dt) {
                            record._dateStart = dt.hour === 0 ? dt.set({ hour: 17 }) : dt;
                            record._dateEnd = record._dateStart;
                        }
                    } else {
                        record.deadline = false;
                        this._recomputeMilestonePositions();
                    }
                }
                this.notify();
                return true;
            }
            const kwargs = options.context ? { context: options.context } : {};
            const dateStartField = this.archInfo.dateStart || "date_start";
            const dateStopField = this.archInfo.dateStop || "date_end";
            const planDurationField = this.archInfo.planDuration || "plan_duration";
            const planOffsetField = this.archInfo.planOffset || "plan_offset";
            await this.orm.write(this.resModel, [recordId], values, kwargs);
            // Update local record
            if (record) {
                Object.assign(record, values);
                if (dateStartField in values) {
                    record._dateStart = values[dateStartField]
                        ? GanttModel.parseOdooDate(values[dateStartField])
                        : null;
                }
                if (dateStopField in values) {
                    record._dateEnd = values[dateStopField]
                        ? GanttModel.parseOdooDate(values[dateStopField])
                        : null;
                }
                // Re-process progress if changed, and recompute parent summary progress
                const progressField = this.archInfo.progress || "";
                if (progressField && values[progressField] != null) {
                    record._progress = Number(values[progressField]) || 0;
                    for (const group of this.data.groups) {
                        this._computeGroupSummaryDates(group);
                    }
                }
                // Re-process on_gantt (bar label visibility) if changed
                const onGanttField = this.archInfo.onGantt || "on_gantt";
                if (onGanttField in values) {
                    record._showLabel = Boolean(values[onGanttField]);
                }
                // Re-process plan fields and virtual dates if changed
                if (values[planDurationField] != null) {
                    record._planDuration = Number(values[planDurationField]) || 0;
                }
                if (values[planOffsetField] != null) {
                    record._planOffset = Number(values[planOffsetField]) || 0;
                }
                // Regenerate virtual dates if still in planning mode (with calendar scaling)
                if (record._isVirtualDates && (values[planDurationField] != null || values[planOffsetField] != null)) {
                    const T0 = PLANNING_T0;
                    const hpd = this.data.calendarInfo?.hours_per_day || 8;
                    const scaleFactor = (hpd < 24) ? (24 / hpd) : 1;
                    record._dateStart = T0.plus({ hours: record._planOffset * scaleFactor });
                    record._dateEnd = T0.plus({ hours: (record._planOffset + record._planDuration) * scaleFactor });
                }
            }
            // Recompute dependent data if date fields changed
            if ((dateStartField in values) || (dateStopField in values) ||
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
        const record = this._recordMap.get(recordId);
        if (!record) return false;

        // Virtual dates (planning mode): no real dates, just update plan_duration locally
        if (record._isVirtualDates || !record._dateStart) {
            const planField = this.archInfo.planDuration || "plan_duration";
            return this.updateRecord(recordId, { [planField]: hours });
        }

        // Real dates: use server-side calendar to compute correct date_end
        try {
            const result = await this.orm.call(
                this.resModel, "action_update_plan_duration",
                [[recordId], hours]
            );
            // Sync local record with server result
            const planField = this.archInfo.planDuration || "plan_duration";
            record[planField] = hours;
            record._planDuration = hours;
            if (result.date_end) {
                const dateEndField = this.archInfo.dateStop || "date_end";
                record[dateEndField] = result.date_end;
                record._dateEnd = GanttModel.parseOdooDate(result.date_end);
            }
            // Sync working_duration so getInfoDuration displays correctly
            const wdField = this.archInfo.workingDuration || "working_duration";
            if (result.working_duration != null) {
                record[wdField] = result.working_duration;
            }
            this._recomputeMilestonePositions();
            for (const group of this.data.groups) {
                this._computeGroupSummaryDates(group);
            }
            // Push FS successors if date_end changed (cascade constraint)
            await this._pushFSSuccessors(recordId);
            await this._pushAncestorFSSuccessors(recordId);
            await this._recalcAndUpdateLags(recordId);
            this.notify();
            return true;
        } catch (error) {
            console.error("Failed to update plan duration:", error);
            return false;
        }
    }

    async updatePlanOffset(recordId, offsetHours) {
        const planOffsetField = this.archInfo.planOffset || "plan_offset";
        return this.updateRecord(recordId, { [planOffsetField]: offsetHours });
    }

    async setProjectScheduleStart(groupId, dateStr) {
        const groupModel = this.archInfo.mainGroupModel;
        if (!groupModel) return false;
        try {
            await this.orm.call(groupModel, "action_set_schedule_start", [groupId, dateStr]);
            return true;
        } catch (error) {
            this.notification.add(error.data?.message || _t("設定排程起始日失敗"), { type: "danger" });
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Item 10: Multi-select drag (move multiple records by same cellsDelta)
    // -------------------------------------------------------------------------

    /**
     * Move multiple selected records by the same cellsDelta.
     * Each record is independently constrained by its own FS boundaries.
     * @param {number[]} recordIds
     * @param {number} cellsDelta - fractional cells
     * @param {string} scale
     * @param {Object} [dragContext] - { calHpd, calDpw, shiftDate, isHidingNonWorking }
     */
    async moveMultipleRecords(recordIds, shiftHours, options = {}) {
        if (!recordIds || recordIds.length === 0) return;
        try {
            const kwargs = {
                shift_hours: shiftHours,
            };
            if (options.context) kwargs.context = options.context;
            const diff = await this.orm.call(
                this.resModel, "action_move_multiple_and_cascade",
                [recordIds], kwargs
            );
            this._applyServerDiff(diff);
        } catch (error) {
            // Fallback: move individually
            console.warn("Batch move failed, falling back to individual moves:", error);
            for (const id of recordIds) {
                await this.moveAndCascade(id, null, shiftHours, options);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Item 11: Undo / Redo
    // -------------------------------------------------------------------------

    _snapshotRecord(recordId) {
        const record = this._recordMap.get(recordId);
        if (!record) return null;
        const dateStartField = this.archInfo.dateStart || "date_start";
        const dateStopField = this.archInfo.dateStop || "date_end";
        const planDurField = this.archInfo.planDuration || "plan_duration";
        const planOffField = this.archInfo.planOffset || "plan_offset";
        const snap = {
            [dateStartField]: record[dateStartField] || null,
            [dateStopField]: record[dateStopField] || null,
            [planDurField]: record[planDurField] ?? null,
            [planOffField]: record[planOffField] ?? null,
        };
        // Snapshot predecessor lags (for undo/redo)
        const predLags = {};
        const relatedPreds = [
            ...(this._predByParent.get(recordId) || []),
            ...(this._predByChild.get(recordId) || []),
        ].filter(p => p.id);
        for (const pred of relatedPreds) {
            predLags[pred.id] = pred.lag_hours || 0;
        }
        snap._predLags = predLags;
        return snap;
    }

    _pushUndoState(operation) {
        this._undoStack.push(operation);
        if (this._undoStack.length > this._maxHistory) this._undoStack.shift();
        this._redoStack = [];
    }

    async undo() {
        if (this._undoStack.length === 0) return false;
        const op = this._undoStack.pop();
        await this._applyUndoRedoState(op, "undo");
        this._redoStack.push(op);
        return true;
    }

    async redo() {
        if (this._redoStack.length === 0) return false;
        const op = this._redoStack.pop();
        await this._applyUndoRedoState(op, "redo");
        this._undoStack.push(op);
        return true;
    }

    async _applyUndoRedoState(op, direction) {
        const state = direction === "undo" ? op.before : op.after;
        if (!state || !op.recordId) return;
        // Restore task fields
        const fields = { ...state };
        const predLags = fields._predLags;
        delete fields._predLags;
        if (op.type === "move" || op.type === "resize") {
            await this.updateRecord(op.recordId, fields, { context: { skip_date_snap: true } });
        }
        // Restore predecessor lags
        if (predLags) {
            const predModel = this.archInfo.predecessorModel;
            if (predModel) {
                const writes = [];
                for (const [predIdStr, lagHours] of Object.entries(predLags)) {
                    const predId = parseInt(predIdStr);
                    const pred = this._predById.get(predId);
                    if (pred && Math.abs((pred.lag_hours || 0) - lagHours) > 0.001) {
                        pred.lag_hours = lagHours;
                        writes.push(this.orm.write(predModel, [predId], { lag_hours: lagHours }));
                    }
                }
                if (writes.length) await Promise.all(writes);
            }
        }
        // Recompute everything
        for (const group of this.data.groups) {
            this._computeGroupSummaryDates(group);
        }
        this._recomputeMilestonePositions();
        this.notify();
    }

    canUndo() { return this._undoStack.length > 0; }
    canRedo() { return this._redoStack.length > 0; }

    async clearProjectScheduleDates(groupId, clearTasks) {
        const groupModel = this.archInfo.mainGroupModel;
        if (!groupModel) return false;
        try {
            await this.orm.call(groupModel, "action_clear_schedule_dates", [groupId, clearTasks]);
            return true;
        } catch (error) {
            this.notification.add(error.data?.message || _t("清除排程日期失敗"), { type: "danger" });
            return false;
        }
    }
}
