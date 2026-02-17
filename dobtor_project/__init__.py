# -*- coding: utf-8 -*-
from . import models
from . import report
from . import wizard


def _migrate_lag_to_hours(env):
    env.cr.execute("""
        UPDATE project_task_predecessor
        SET lag_hours = CASE
            WHEN lag_type = 'hour' THEN COALESCE(lag_qty, 0)
            WHEN lag_type = 'minute' THEN COALESCE(lag_qty, 0) / 60.0
            ELSE COALESCE(lag_qty, 0) * 24.0
        END
        WHERE COALESCE(lag_qty, 0) != 0
    """)
