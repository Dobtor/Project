# -*- coding: utf-8 -*-

import base64
import logging
from xml.etree import ElementTree as ET

from odoo import api, fields, models, _
from odoo.exceptions import UserError

from . import project_exchange_tool as tool

_logger = logging.getLogger(__name__)

NS = "http://schemas.microsoft.com/project"
NS_MAP = {"n": NS}


class ProjectExchange(models.TransientModel):
    _name = "project.exchange"
    _description = "Project Gantt Exchange (Export)"

    project_id = fields.Many2one("project.project", string="Project", required=True)
    name = fields.Char(string="File Name", default="project_exchange.xml")
    file_save = fields.Binary(string="Download File", readonly=True)
    errors = fields.Text(string="Errors", readonly=True)

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------

    def action_export(self):
        self.ensure_one()
        project = self.project_id
        if not project:
            raise UserError(_("Please select a project."))

        root = ET.Element("Project", xmlns=NS)

        # Project metadata
        self._add_el(root, "SaveVersion", "14")
        self._add_el(root, "Name", project.name or "")
        self._add_el(root, "ScheduleFromStart",
                     tool.scheduling_type_to_xml(project.scheduling_type or "forward"))
        self._add_el(root, "StartDate",
                     tool.odoo_dt_to_xml(project.date_start_gantt))
        self._add_el(root, "FinishDate",
                     tool.odoo_dt_to_xml(project.date_end_gantt))
        self._add_el(root, "CurrentDate",
                     tool.odoo_dt_to_xml(fields.Datetime.now()))

        # Placeholder sections (MS Project compat)
        for tag in ["OutlineCodes", "WBSMasks", "ExtendedAttributes",
                     "Calendars", "Resources", "Assignments"]:
            ET.SubElement(root, tag)

        # Tasks
        tasks_el = ET.SubElement(root, "Tasks")
        tasks = self.env["project.task"].search([
            ("project_id", "=", project.id),
            ("on_gantt", "=", True),
        ], order="sorting_seq asc")

        for idx, task in enumerate(tasks):
            self._export_task(tasks_el, task, idx)

        # Generate file
        xml_str = tool.prettify(root)
        self.file_save = base64.b64encode(xml_str.encode("utf-8"))
        self.name = f"{project.name or 'project'}_exchange.xml"

        return {
            "type": "ir.actions.act_window",
            "res_model": self._name,
            "res_id": self.id,
            "view_mode": "form",
            "target": "new",
        }

    def _export_task(self, parent_el, task, idx):
        t = ET.SubElement(parent_el, "Task")

        self._add_el(t, "UID", str(task.id))
        self._add_el(t, "ID", str(idx))
        self._add_el(t, "Name", task.name or "")
        self._add_el(t, "Active", tool.bool_to_xml(task.active))
        self._add_el(t, "Manual",
                     tool.schedule_mode_to_xml(task.schedule_mode or "manual"))
        self._add_el(t, "OutlineNumber", str(idx))
        self._add_el(t, "OutlineLevel", str((task.sorting_level or 0) + 1))
        self._add_el(t, "Start", tool.odoo_dt_to_xml(task.date_start))
        self._add_el(t, "Finish", tool.odoo_dt_to_xml(task.date_end))
        self._add_el(t, "Duration",
                     tool.seconds_to_iso8601(task.duration or 0))
        self._add_el(t, "ManualStart", tool.odoo_dt_to_xml(task.date_start))
        self._add_el(t, "ManualFinish", tool.odoo_dt_to_xml(task.date_end))
        self._add_el(t, "ManualDuration",
                     tool.seconds_to_iso8601(task.duration or 0))
        self._add_el(t, "Work",
                     tool.seconds_to_iso8601(task.plan_duration or 0))
        self._add_el(t, "Milestone", tool.bool_to_xml(task.is_milestone))
        self._add_el(t, "OnGantt", tool.bool_to_xml(task.on_gantt))
        self._add_el(t, "ConstraintType",
                     tool.constraint_type_to_xml(task.constrain_type or "asap"))

        if task.constrain_date:
            self._add_el(t, "ConstraintDate",
                         tool.odoo_dt_to_xml(task.constrain_date))

        self._add_el(t, "ColorGanttSet",
                     tool.bool_to_xml(task.color_gantt_set))
        if task.color_gantt:
            self._add_el(t, "ColorGantt", task.color_gantt)

        # Predecessors
        for pred in task.predecessor_ids:
            pl = ET.SubElement(t, "PredecessorLink")
            self._add_el(pl, "PredecessorUID", str(pred.parent_task_id.id))
            self._add_el(pl, "Type", tool.pred_type_to_xml(pred.type or "FS"))
            lag_type = pred.lag_type or "day"
            self._add_el(pl, "LinkLag",
                         tool.lag_to_xml(pred.lag_qty or 0, lag_type))
            self._add_el(pl, "LagFormat", tool.lag_format_to_xml(lag_type))

        # Tags
        for tag in task.tag_ids:
            tt = ET.SubElement(t, "TaskTag")
            self._add_el(tt, "TagUID", str(tag.id))
            self._add_el(tt, "TagName", tag.name or "")
            self._add_el(tt, "TagColor", str(tag.color or 0))

    @staticmethod
    def _add_el(parent, tag, text):
        el = ET.SubElement(parent, tag)
        el.text = text
        return el


class ProjectExchangeImport(models.TransientModel):
    _name = "project.exchange.import"
    _description = "Project Gantt Exchange (Import)"

    name = fields.Char(string="File Name")
    file_load = fields.Binary(string="Upload File", required=True)
    project_id = fields.Many2one("project.project", string="Target Project",
                                 readonly=True)
    errors = fields.Text(string="Errors", readonly=True)

    # Preview lines
    preview_line_ids = fields.One2many(
        "project.exchange.import.line", "import_id",
        string="Preview Lines")

    # ------------------------------------------------------------------
    # Parse & Preview
    # ------------------------------------------------------------------

    def action_parse(self):
        self.ensure_one()
        if not self.file_load:
            raise UserError(_("Please upload an XML file."))

        self.preview_line_ids.unlink()
        self.errors = ""

        try:
            xml_bytes = base64.b64decode(self.file_load)
            root = ET.fromstring(xml_bytes)
        except Exception as e:
            raise UserError(_("Failed to parse XML: %s") % str(e))

        # Parse project info
        proj_name = self._get_text(root, "Name")
        sched_type = tool.xml_to_scheduling_type(
            self._get_text(root, "ScheduleFromStart"))
        start_date = self._get_text(root, "StartDate")
        finish_date = self._get_text(root, "FinishDate")

        lines = []
        lines.append((0, 0, {
            "section": "project",
            "field_name": "name",
            "xml_element": "Name",
            "xml_value": proj_name,
            "converted_value": proj_name,
        }))
        lines.append((0, 0, {
            "section": "project",
            "field_name": "scheduling_type",
            "xml_element": "ScheduleFromStart",
            "xml_value": self._get_text(root, "ScheduleFromStart"),
            "converted_value": sched_type,
        }))

        # Parse tasks preview
        tasks_el = root.find("Tasks") or root.find(f"{{{NS}}}Tasks")
        if tasks_el is not None:
            task_els = tasks_el.findall("Task") or tasks_el.findall(f"{{{NS}}}Task")
            for idx, task_el in enumerate(task_els[:20]):  # Preview first 20
                name = self._get_text(task_el, "Name")
                uid = self._get_text(task_el, "UID")
                start = self._get_text(task_el, "Start")
                finish = self._get_text(task_el, "Finish")
                lines.append((0, 0, {
                    "section": "task",
                    "field_name": f"Task {idx}",
                    "xml_element": "Task",
                    "xml_value": f"UID={uid}, Name={name}",
                    "converted_value": f"{start} → {finish}",
                }))

        self.preview_line_ids = lines

        return {
            "type": "ir.actions.act_window",
            "res_model": self._name,
            "res_id": self.id,
            "view_mode": "form",
            "target": "new",
        }

    # ------------------------------------------------------------------
    # Import
    # ------------------------------------------------------------------

    def action_import(self):
        self.ensure_one()
        if not self.file_load:
            raise UserError(_("Please upload an XML file."))

        try:
            xml_bytes = base64.b64decode(self.file_load)
            root = ET.fromstring(xml_bytes)
        except Exception as e:
            raise UserError(_("Failed to parse XML: %s") % str(e))

        errors = []

        # Create project
        proj_vals = {
            "name": self._get_text(root, "Name") or "Imported Project",
            "scheduling_type": tool.xml_to_scheduling_type(
                self._get_text(root, "ScheduleFromStart")),
        }
        start_dt = tool.xml_dt_to_odoo(self._get_text(root, "StartDate"))
        end_dt = tool.xml_dt_to_odoo(self._get_text(root, "FinishDate"))
        if start_dt:
            proj_vals["date_start_gantt"] = start_dt
        if end_dt:
            proj_vals["date_end_gantt"] = end_dt

        project = self.env["project.project"].create(proj_vals)
        self.project_id = project

        # Parse and create tasks
        tasks_el = root.find("Tasks") or root.find(f"{{{NS}}}Tasks")
        if tasks_el is None:
            self.errors = _("No Tasks section found in XML.")
            return self._return_form()

        task_els = tasks_el.findall("Task") or tasks_el.findall(f"{{{NS}}}Task")
        uid_to_task = {}  # XML UID → task record
        task_data = []  # Ordered list of (xml_el, task_vals, uid)

        for idx, task_el in enumerate(task_els):
            uid = self._get_text(task_el, "UID")
            task_vals = self._parse_task_vals(task_el, project, idx)
            task_data.append((task_el, task_vals, uid))

        # First pass: create all tasks
        for task_el, task_vals, uid in task_data:
            try:
                task = self.env["project.task"].create(task_vals)
                uid_to_task[uid] = task
            except Exception as e:
                errors.append(f"Task UID={uid}: {e}")

        # Second pass: rebuild parent-child hierarchy from OutlineLevel
        prev_task = None
        prev_level = 0
        parent_stack = [False]  # stack of parent task ids

        for task_el, _, uid in task_data:
            task = uid_to_task.get(uid)
            if not task:
                continue

            level = int(self._get_text(task_el, "OutlineLevel") or "1")

            if level > prev_level:
                if prev_task:
                    parent_stack.append(prev_task.id)
            elif level < prev_level:
                for _ in range(prev_level - level):
                    if len(parent_stack) > 1:
                        parent_stack.pop()

            parent_id = parent_stack[-1] if parent_stack else False
            if parent_id:
                task.write({"parent_id": parent_id})

            prev_task = task
            prev_level = level

        # Third pass: create predecessors
        Predecessor = self.env["project.task.predecessor"]
        for task_el, _, uid in task_data:
            task = uid_to_task.get(uid)
            if not task:
                continue

            pred_els = (task_el.findall("PredecessorLink") or
                        task_el.findall(f"{{{NS}}}PredecessorLink"))
            for pred_el in pred_els:
                pred_uid = self._get_text(pred_el, "PredecessorUID")
                parent_task = uid_to_task.get(pred_uid)
                if not parent_task:
                    continue

                pred_type = tool.xml_to_pred_type(
                    self._get_text(pred_el, "Type"))
                lag_format = tool.xml_to_lag_format(
                    self._get_text(pred_el, "LagFormat"))
                lag_val = tool.xml_to_lag(
                    self._get_text(pred_el, "LinkLag") or "0", lag_format)

                try:
                    Predecessor.create({
                        "task_id": task.id,
                        "parent_task_id": parent_task.id,
                        "type": pred_type,
                        "lag_qty": lag_val,
                        "lag_type": lag_format,
                    })
                except Exception as e:
                    errors.append(f"Predecessor {pred_uid}→{uid}: {e}")

        # Fourth pass: create/link tags
        Tag = self.env["project.tags"]
        for task_el, _, uid in task_data:
            task = uid_to_task.get(uid)
            if not task:
                continue

            tag_els = (task_el.findall("TaskTag") or
                       task_el.findall(f"{{{NS}}}TaskTag"))
            tag_ids = []
            for tag_el in tag_els:
                tag_name = self._get_text(tag_el, "TagName")
                if not tag_name:
                    continue
                tag = Tag.search([("name", "=", tag_name)], limit=1)
                if not tag:
                    tag_color = int(self._get_text(tag_el, "TagColor") or "0")
                    tag = Tag.create({
                        "name": tag_name,
                        "color": tag_color,
                    })
                tag_ids.append(tag.id)

            if tag_ids:
                task.write({"tag_ids": [(4, tid) for tid in tag_ids]})

        if errors:
            self.errors = "\n".join(errors)

        return self._return_form()

    def _parse_task_vals(self, task_el, project, idx):
        vals = {
            "project_id": project.id,
            "name": self._get_text(task_el, "Name") or f"Task {idx}",
            "schedule_mode": tool.xml_to_schedule_mode(
                self._get_text(task_el, "Manual")),
            "is_milestone": tool.xml_to_bool(
                self._get_text(task_el, "Milestone")),
            "on_gantt": tool.xml_to_bool(
                self._get_text(task_el, "OnGantt") or "1"),
            "sorting_seq": idx,
            "sorting_level": max(
                0, int(self._get_text(task_el, "OutlineLevel") or "1") - 1),
        }

        start = tool.xml_dt_to_odoo(self._get_text(task_el, "Start"))
        finish = tool.xml_dt_to_odoo(self._get_text(task_el, "Finish"))
        if start:
            vals["date_start"] = start
        if finish:
            vals["date_end"] = finish

        duration = tool.iso8601_to_seconds(
            self._get_text(task_el, "ManualDuration") or
            self._get_text(task_el, "Duration"))
        if duration:
            vals["duration"] = duration

        plan_dur = tool.iso8601_to_seconds(
            self._get_text(task_el, "Work"))
        if plan_dur:
            vals["plan_duration"] = plan_dur

        ctype = tool.xml_to_constraint_type(
            self._get_text(task_el, "ConstraintType"))
        vals["constrain_type"] = ctype
        cdate = tool.xml_dt_to_odoo(
            self._get_text(task_el, "ConstraintDate"))
        if cdate:
            vals["constrain_date"] = cdate

        color_set = tool.xml_to_bool(
            self._get_text(task_el, "ColorGanttSet"))
        vals["color_gantt_set"] = color_set
        color = self._get_text(task_el, "ColorGantt")
        if color:
            vals["color_gantt"] = color

        return vals

    def _get_text(self, parent, tag):
        """Get text from child element, handling namespace."""
        el = parent.find(tag)
        if el is None:
            el = parent.find(f"{{{NS}}}{tag}")
        return el.text if el is not None and el.text else ""

    def _return_form(self):
        return {
            "type": "ir.actions.act_window",
            "res_model": self._name,
            "res_id": self.id,
            "view_mode": "form",
            "target": "new",
        }


class ProjectExchangeImportLine(models.TransientModel):
    _name = "project.exchange.import.line"
    _description = "Import Preview Line"

    import_id = fields.Many2one("project.exchange.import", ondelete="cascade")
    section = fields.Char(string="Section")
    field_name = fields.Char(string="Odoo Field")
    xml_element = fields.Char(string="XML Element")
    xml_value = fields.Char(string="XML Value")
    converted_value = fields.Char(string="Converted Value")
