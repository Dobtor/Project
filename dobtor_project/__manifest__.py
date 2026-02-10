# -*- coding: utf-8 -*-
{
    "name": "Dobtor Project - Gantt Native",
    "summary": "Native Gantt View for Project Management with Scheduling Engine",
    "description": """
Dobtor Project - Gantt Native View for Odoo 18
===============================================

This module provides a comprehensive Gantt chart view for project management with:

* Native Gantt View (ganttaps)
* Forward/Backward Scheduling Engine
* Task Predecessors and Dependencies (FS, SS, FF, SF)
* Critical Path Analysis
* Resource Management and Load Control
* Calendar Integration
* Detail Planning
* Color Customization
* Export/Import Functionality
* PDF Report Generation

Migrated from Odoo 12 modules:
- web_gantt_native
- web_widget_colorpicker
- web_widget_time_delta
- project_native
- project_native_exchange
- project_native_report
    """,
    "category": "Project",
    "version": "18.0.1.0.3",
    "author": "Dobtor SI",
    "license": "LGPL-3",
    "website": "https://www.dobtor.com",
    "depends": [
        "project",
        "hr_timesheet",
        "resource",
        "web",
    ],
    "data": [
        "security/dobtor_project_security.xml",
        "security/ir.model.access.csv",
        "views/project_project_views.xml",
        "views/project_task_views.xml",
        "views/project_task_resource_views.xml",
        "views/resource_views.xml",
        "wizard/project_exchange_views.xml",
        "report/project_gantt_report.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "dobtor_project/static/src/components/**/*.js",
            "dobtor_project/static/src/components/**/*.xml",
            "dobtor_project/static/src/scss/**/*.scss",
        ],
    },
    "installable": True,
    "auto_install": False,
    "application": False,
}
