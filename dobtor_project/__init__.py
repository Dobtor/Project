# -*- coding: utf-8 -*-
import logging

from . import models
from . import report
from . import wizard

_logger = logging.getLogger(__name__)


def _column_exists(cr, table, column):
    cr.execute("""
        SELECT 1 FROM information_schema.columns
        WHERE table_name = %s AND column_name = %s
    """, (table, column))
    return cr.fetchone()


def _post_init_hook(env):
    """Post-init hook — migrate legacy columns if they exist."""
    _migrate_lag_to_hours(env)
    _migrate_progress_manual(env)


def _migrate_lag_to_hours(env):
    if not _column_exists(env.cr, 'project_task_predecessor', 'lag_qty'):
        _logger.info("lag_qty column not found, skipping migration.")
        return
    if not _column_exists(env.cr, 'project_task_predecessor', 'lag_hours'):
        _logger.info("lag_hours column not found, skipping migration.")
        return
    env.cr.execute("""
        UPDATE project_task_predecessor
        SET lag_hours = CASE
            WHEN lag_type = 'hour' THEN COALESCE(lag_qty, 0)
            WHEN lag_type = 'minute' THEN COALESCE(lag_qty, 0) / 60.0
            ELSE COALESCE(lag_qty, 0) * 24.0
        END
        WHERE COALESCE(lag_qty, 0) != 0
    """)


def _migrate_progress_manual(env):
    if not _column_exists(env.cr, 'project_task', '_progress_manual'):
        _logger.info("_progress_manual column not found, skipping migration.")
        return
    env.cr.execute("""
        UPDATE project_task
        SET _progress_manual = COALESCE(progress, 0)
        WHERE _progress_manual IS NULL OR _progress_manual = 0
    """)
