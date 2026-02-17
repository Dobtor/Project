import logging

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    """Convert color_gantt from varchar (RGBA string) to integer before ORM init."""
    if not version:
        return

    # Drop color_gantt_set column (removed field)
    cr.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'project_task' AND column_name = 'color_gantt_set'
    """)
    if cr.fetchone():
        cr.execute("ALTER TABLE project_task DROP COLUMN color_gantt_set")
        _logger.info("Dropped project_task.color_gantt_set column")

    # Convert color_gantt from varchar to int4
    cr.execute("""
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'project_task' AND column_name = 'color_gantt'
    """)
    row = cr.fetchone()
    if row and row[0] in ('character varying', 'text'):
        # Reset all RGBA string values to 0 (no color) before type conversion
        cr.execute("UPDATE project_task SET color_gantt = '0'")
        cr.execute(
            "ALTER TABLE project_task ALTER COLUMN color_gantt TYPE int4 "
            "USING color_gantt::int4"
        )
        _logger.info("Converted project_task.color_gantt from varchar to int4")

    # Same for project_task_detail_plan
    cr.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'project_task_detail_plan' AND column_name = 'color_gantt_set'
    """)
    if cr.fetchone():
        cr.execute("ALTER TABLE project_task_detail_plan DROP COLUMN color_gantt_set")
        _logger.info("Dropped project_task_detail_plan.color_gantt_set column")

    cr.execute("""
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'project_task_detail_plan' AND column_name = 'color_gantt'
    """)
    row = cr.fetchone()
    if row and row[0] in ('character varying', 'text'):
        cr.execute("UPDATE project_task_detail_plan SET color_gantt = '0'")
        cr.execute(
            "ALTER TABLE project_task_detail_plan ALTER COLUMN color_gantt TYPE int4 "
            "USING color_gantt::int4"
        )
        _logger.info("Converted project_task_detail_plan.color_gantt from varchar to int4")
