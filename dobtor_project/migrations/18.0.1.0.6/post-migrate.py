# -*- coding: utf-8 -*-
"""Post-migration 18.0.1.0.6.

`predecessor_parent` changed from a hybrid field (compute wrote the real count
while project.task.predecessor.create/write wrote a hard-coded 1) to a clean
stored compute driven solely by the new `as_predecessor_ids` inverse relation.
The old stored values may have drifted, so recompute the accurate successor
count directly in SQL for every task.
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return

    _logger.info("Post-migrate 18.0.1.0.6: recomputing predecessor_parent counts")

    # Reset everyone to 0, then set the true count from the link table.
    cr.execute("UPDATE project_task SET predecessor_parent = 0")
    cr.execute("""
        UPDATE project_task pt
        SET predecessor_parent = c.cnt
        FROM (
            SELECT parent_task_id, COUNT(*) AS cnt
            FROM project_task_predecessor
            GROUP BY parent_task_id
        ) c
        WHERE pt.id = c.parent_task_id
    """)
    _logger.info("predecessor_parent recomputed for %d parent tasks", cr.rowcount)
