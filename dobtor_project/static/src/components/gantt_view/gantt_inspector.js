/** @odoo-module **/
import { Component, useState } from "@odoo/owl";

export class GanttInspector extends Component {
    static template = "dobtor_project.GanttInspector";
    static props = {
        visible: Boolean,
        record: { type: Object, optional: true },
        archInfo: Object,
        predecessors: { type: Array, optional: true },
        onClose: Function,
        onFieldChange: Function,
        onOpenForm: Function,
    };

    setup() {
        this.state = useState({
            expandedSections: {
                general: true,
                schedule: true,
                resources: false,
                predecessors: false,
            },
        });
    }

    toggleSection(name) {
        this.state.expandedSections[name] = !this.state.expandedSections[name];
    }

    onFieldBlur(fieldName, ev) {
        if (!this.props.record) return;
        this.props.onFieldChange(this.props.record.id, fieldName, ev.target.value);
    }

    onSelectChange(fieldName, ev) {
        if (!this.props.record) return;
        this.props.onFieldChange(this.props.record.id, fieldName, ev.target.value);
    }

    onCheckboxChange(fieldName, ev) {
        if (!this.props.record) return;
        this.props.onFieldChange(this.props.record.id, fieldName, ev.target.checked);
    }

    onProgressChange(ev) {
        if (!this.props.record) return;
        const val = Math.min(100, Math.max(0, parseInt(ev.target.value, 10) || 0));
        const progressField = this.props.archInfo.progress || "progress";
        this.props.onFieldChange(this.props.record.id, progressField, val);
    }
}
