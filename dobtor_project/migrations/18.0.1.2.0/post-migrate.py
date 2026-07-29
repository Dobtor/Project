# -*- coding: utf-8 -*-
"""One working day, not 24 clock hours.

``project.project.task_default_duration`` was a hard-coded 24.0. Under "the
hours you type ARE the schedule" that is three working days on an 8-hour
calendar, so every task created from the default started three times too long —
the field now follows the project's calendar (see
project_project._compute_task_default_duration).

This brings existing projects along: any project still sitting on the old 24.0
whose calendar does not actually work 24 hours a day gets its calendar's
hours_per_day instead. A project whose owner had already chosen some other
number is left alone — the point is to fix the default nobody chose, not to
overwrite a decision.

TASKS ARE NOT TOUCHED. plan_duration on existing tasks is real, entered data;
only the project-level default for the NEXT task changes.
"""
import logging

_logger = logging.getLogger(__name__)

OLD_DEFAULT = 24.0


def migrate(cr, version):
    if not version:
        return

    cr.execute("""
        SELECT p.id, COALESCE(c.hours_per_day, 8.0)
          FROM project_project p
          LEFT JOIN resource_calendar c ON c.id = p.resource_calendar_id
         WHERE p.task_default_duration = %s
           AND COALESCE(c.hours_per_day, 8.0) <> %s
    """, (OLD_DEFAULT, OLD_DEFAULT))
    rows = cr.fetchall()
    if not rows:
        _logger.info("task_default_duration: nothing to migrate")
        return

    for project_id, hours_per_day in rows:
        cr.execute(
            "UPDATE project_project SET task_default_duration = %s WHERE id = %s",
            (hours_per_day, project_id))
    _logger.info(
        "task_default_duration: %s project(s) moved off the hard-coded 24h "
        "default onto their calendar's working day", len(rows))
