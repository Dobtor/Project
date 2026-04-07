# -*- coding: utf-8 -*-
"""Post-migration: sync enable_blocking + depend_on_ids from predecessors.

On upgrade to 18.0.1.0.5, the new `enable_blocking` column is added to
`project_task_predecessor`. This migration:
  1. Sets enable_blocking=False for non-FS predecessors (FS keeps default True)
  2. Rebuilds `task_dependencies_rel` from blocking predecessors
  3. Recomputes task state for affected tasks
"""
import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return

    _logger.info("Post-migrate 18.0.1.0.5: syncing predecessor blocking state")

    # Step 1: Set non-FS predecessors to enable_blocking=False
    # The ORM creates the column with default=True before this runs
    cr.execute("""
        UPDATE project_task_predecessor
        SET enable_blocking = FALSE
        WHERE type != 'FS'
        AND enable_blocking = TRUE
    """)
    updated = cr.rowcount
    _logger.info("Set enable_blocking=False for %d non-FS predecessors", updated)

    # Step 2: Rebuild depend_on_ids (task_dependencies_rel) from predecessors
    cr.execute("DELETE FROM task_dependencies_rel")

    cr.execute("""
        INSERT INTO task_dependencies_rel (task_id, depends_on_id)
        SELECT task_id, parent_task_id
        FROM project_task_predecessor
        WHERE enable_blocking = TRUE
        ON CONFLICT DO NOTHING
    """)
    inserted = cr.rowcount
    _logger.info("Rebuilt task_dependencies_rel: %d blocking links", inserted)

    # Step 3: Trigger state recompute for tasks with blocking predecessors
    # We mark the computed field as needing recomputation; Odoo will
    # recompute `state` on next registry load.
    cr.execute("""
        UPDATE project_task
        SET state = '04_waiting_normal'
        WHERE id IN (
            SELECT DISTINCT p.task_id
            FROM project_task_predecessor p
            JOIN project_task pt ON pt.id = p.parent_task_id
            WHERE p.enable_blocking = TRUE
            AND pt.state NOT IN ('1_done', '1_canceled')
        )
        AND state NOT IN ('1_done', '1_canceled')
    """)
    waiting = cr.rowcount
    _logger.info("Set %d tasks to waiting state (blocked by open predecessors)", waiting)

    # Step 4: Release tasks that should NOT be waiting
    # (all their blocking predecessors are closed)
    cr.execute("""
        UPDATE project_task
        SET state = '01_in_progress'
        WHERE state = '04_waiting_normal'
        AND id NOT IN (
            SELECT DISTINCT p.task_id
            FROM project_task_predecessor p
            JOIN project_task pt ON pt.id = p.parent_task_id
            WHERE p.enable_blocking = TRUE
            AND pt.state NOT IN ('1_done', '1_canceled')
        )
    """)
    released = cr.rowcount
    _logger.info("Released %d tasks from waiting (no open blockers)", released)
