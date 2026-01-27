/** @odoo-module **/

import { KeepLast } from "@web/core/utils/concurrency";
import { Model } from "@web/model/model";
import { luxon } from "@web/core/l10n/dates";

const { DateTime } = luxon;

export class GanttModel extends Model {
    static services = ["orm"];

    /**
     * Expected params structure for GanttModel
     * @param {Object} archInfo - Parsed arch information from GanttArchParser
     * @param {String} resModel - The model name (e.g., 'project.task')
     * @param {Object} fields - Field definitions from the model
     */

    setup(params, services) {
        this.orm = services.orm;
        this.keepLast = new KeepLast();
        this.archInfo = params.archInfo;
        this.resModel = params.resModel;
        this.fields = params.fields;

        this.data = {
            records: [],
            predecessors: [],
            groups: [],
            timeStart: null,
            timeStop: null,
        };

        this.scale = "day"; // day, week, month, quarter
        this.currentDate = DateTime.now();
    }

    async load(params = {}) {
        const { domain = [], groupBy = [], context = {} } = params;

        this.domain = domain;
        this.groupBy = groupBy.length ? groupBy : [this.archInfo.defaultGroupBy];
        this.context = context;

        await this.keepLast.add(this._fetchData());
    }

    async _fetchData() {
        try {
            const fields = this._getFieldsToFetch();
            const limit = this.archInfo.limitView;

            // Use dynamic field name for ordering
            const orderField = this.archInfo.dateStart || "date_start";

            // Fetch main records
            const records = await this.orm.searchRead(
                this.resModel,
                this.domain,
                fields,
                { limit, order: `${orderField} asc` }
            );

            this.data.records = this._processRecords(records);

            // Fetch predecessors if configured
            if (this.archInfo.predecessorModel) {
                await this._fetchPredecessors();
            }

            // Calculate time range
            this._calculateTimeRange();

            // Group records
            this._groupRecords();
        } catch (error) {
            console.error("Failed to fetch Gantt data:", error);
            // Reset to empty state on error
            this.data.records = [];
            this.data.predecessors = [];
            this.data.groups = [];
            throw error; // Re-throw to allow caller to handle
        }
    }

    _getFieldsToFetch() {
        const fields = new Set([
            "id",
            "display_name",
            this.archInfo.name,
            this.archInfo.dateStart,
            this.archInfo.dateStop,
            this.archInfo.mainGroupIdName,
        ]);

        // Add optional fields based on archInfo configuration
        const optionalFieldMappings = {
            duration: "duration",
            planDuration: "plan_duration",
            isMilestone: "is_milestone",
            scheduleMode: "schedule_mode",
            constrainType: "constrain_type",
            constrainDate: "constrain_date",
            colorGanttSet: "color_gantt_set",
            colorGantt: "color_gantt",
            sortingSeq: "sorting_seq",
            sortingLevel: "sorting_level",
            parentId: "parent_id",
            subtaskCount: "subtask_count",
            criticalPath: "critical_path",
            cpShows: "cp_shows",
            cpDetail: "cp_detail",
            fold: "fold",
            onGantt: "on_gantt",
            summaryDateStart: "summary_date_start",
            summaryDateEnd: "summary_date_end",
        };

        for (const [key, defaultValue] of Object.entries(optionalFieldMappings)) {
            const fieldName = this.archInfo[key];
            if (fieldName) {
                fields.add(fieldName);
            }
        }

        // Add child_ids for summary detection
        fields.add("child_ids");

        return Array.from(fields);
    }

    _processRecords(records) {
        return records.map(record => {
            const dateStart = record[this.archInfo.dateStart];
            const dateStop = record[this.archInfo.dateStop];

            return {
                ...record,
                _dateStart: dateStart ? DateTime.fromISO(dateStart) : null,
                _dateStop: dateStop ? DateTime.fromISO(dateStop) : null,
                _isMilestone: this.archInfo.isMilestone ? record[this.archInfo.isMilestone] : false,
                _isSummary: record.child_ids && record.child_ids.length > 0,
                _isCriticalPath: this.archInfo.criticalPath ? record[this.archInfo.criticalPath] : false,
                _isGroup: false,
            };
        });
    }

    async _fetchPredecessors() {
        if (!this.archInfo.predecessorModel) {
            return;
        }

        const taskIds = this.data.records.map(r => r.id);
        if (!taskIds.length) {
            this.data.predecessors = [];
            return;
        }

        const predecessorFields = [
            "id",
            this.archInfo.predecessorTaskId,
            this.archInfo.predecessorParentTaskId,
            this.archInfo.predecessorType,
        ].filter(Boolean);

        try {
            const predecessors = await this.orm.searchRead(
                this.archInfo.predecessorModel,
                [[this.archInfo.predecessorTaskId, "in", taskIds]],
                predecessorFields
            );

            this.data.predecessors = predecessors;
        } catch (error) {
            console.warn("Failed to fetch predecessors:", error);
            this.data.predecessors = [];
        }
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
            if (record._dateStop) {
                if (!maxDate || record._dateStop > maxDate) {
                    maxDate = record._dateStop;
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

        // Extend range by padding (1 week before and after)
        this.data.timeStart = minDate.startOf("month").minus({ weeks: 1 });
        this.data.timeStop = maxDate.endOf("month").plus({ weeks: 1 });
    }

    _groupRecords() {
        const groupField = this.groupBy[0];
        const groups = new Map();

        for (const record of this.data.records) {
            const groupValue = record[groupField];
            const groupId = Array.isArray(groupValue) ? groupValue[0] : (groupValue || "__ungrouped__");
            const groupName = Array.isArray(groupValue) ? groupValue[1] : (groupValue || "Undefined");

            if (!groups.has(groupId)) {
                groups.set(groupId, {
                    id: groupId,
                    name: groupName,
                    records: [],
                    _isGroup: true,
                    fold: false,
                });
            }
            groups.get(groupId).records.push(record);
        }

        this.data.groups = Array.from(groups.values());
    }

    setScale(scale) {
        this.scale = scale;
        // Note: Timeline width calculation is handled by GanttRenderer
        this.notify();
    }

    setDate(date) {
        this.currentDate = date;
        this.notify();
    }

    scrollToToday() {
        this.currentDate = DateTime.now();
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

    async updateRecord(recordId, values) {
        try {
            await this.orm.write(this.resModel, [recordId], values);
            await this.reload();
            return true;
        } catch (error) {
            console.error("Failed to update record:", error);
            return false;
        }
    }

    async reload(params = {}) {
        try {
            await this.load({
                domain: params.domain || this.domain,
                groupBy: params.groupBy || this.groupBy,
                context: params.context || this.context,
            });
            this.notify();
        } catch (error) {
            console.error("Failed to reload Gantt data:", error);
            throw error; // Re-throw to allow caller to handle
        }
    }

    // Get record by ID
    getRecord(recordId) {
        return this.data.records.find(r => r.id === recordId);
    }

    // Get predecessors for a specific task
    getPredecessorsForTask(taskId) {
        return this.data.predecessors.filter(p => {
            const taskIdField = this.archInfo.predecessorTaskId;
            const predTaskId = p[taskIdField];
            return Array.isArray(predTaskId) ? predTaskId[0] === taskId : predTaskId === taskId;
        });
    }
}
