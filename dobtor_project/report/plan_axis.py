# -*- coding: utf-8 -*-
"""The planning axis, for the PDF report — pure arithmetic, NO ODOO IMPORTS.

This is the Python side of ``static/src/components/gantt_view/gantt_plan_axis.js``
and it must agree with it: the report and the screen draw the same plan, and a
label that reads T+3d on one has to read T+3d on the other.

In planning mode a task has no dates. Its position is ``plan_offset`` and its
length ``plan_duration``, both in WORKING HOURS from T+0. A "day" on this axis is
therefore ``hours_per_day`` of it, not 24 — the report used to step its T+Xd
markers in calendar days, which put every mark three times too far out on an
8-hour calendar and left the labels not lining up with the bars underneath.

Kept free of ``odoo`` imports so ``tests/test_plan_axis.py`` can exercise it
directly, with no database.
"""

DEFAULT_HOURS_PER_DAY = 8.0


def working_days(hours, hpd=DEFAULT_HOURS_PER_DAY):
    """Working days represented by ``hours`` of planned work."""
    return hours / (hpd or DEFAULT_HOURS_PER_DAY)


def day_label(hours, hpd=DEFAULT_HOURS_PER_DAY):
    """T / T+3d / T+1.5d for a point on the plan.

    Mirrors ``planDayLabel`` in gantt_plan_axis.js, including the sign, so the
    report and the chart never disagree about what a position is called.
    """
    days = working_days(hours, hpd)
    if abs(days) < 0.001:
        return "T"
    sign = "+" if days > 0 else ""
    if abs(days - round(days)) < 0.01:
        return "T%s%dd" % (sign, round(days))
    return "T%s%.1fd" % (sign, days)


def marker_interval(span_days):
    """Working days between two axis marks, chosen from the span in days."""
    if span_days <= 14:
        return 1
    if span_days <= 60:
        return 7
    if span_days <= 180:
        return 14
    return 30


def markers(start_hours, end_hours, hpd=DEFAULT_HOURS_PER_DAY):
    """Axis marks for [start_hours, end_hours], as ``{label, left_pct}``.

    ``left_pct`` is the mark's position as a percentage of the drawn span, which
    is how the template places it. Marks fall on whole ``interval`` working days
    counted from T+0, so they line up with the bars: a bar that starts at 24
    planned hours on an 8-hour calendar sits exactly on the T+3d mark.
    """
    total = end_hours - start_hours
    if total <= 0:
        return []
    hours_per_day = hpd or DEFAULT_HOURS_PER_DAY
    interval = marker_interval(working_days(total, hours_per_day))

    start_days = working_days(start_hours, hours_per_day)
    day_offset = max(0, int(start_days // interval) * interval)
    if day_offset < start_days:
        day_offset += interval

    out = []
    while True:
        mark_hours = day_offset * hours_per_day
        if mark_hours > end_hours:
            break
        if mark_hours >= start_hours:
            out.append({
                'label': "T" if day_offset <= 0 else "T+%dd" % day_offset,
                'left_pct': round((mark_hours - start_hours) / total * 100, 2),
            })
        day_offset += interval
    return out


def position_pct(hours, start_hours, total_hours):
    """Where ``hours`` sits inside the drawn span, in percent."""
    if total_hours <= 0:
        return 0.0
    return round((hours - start_hours) / total_hours * 100, 2)


def span_pct(hours, total_hours, minimum=0.0):
    """Width of a ``hours``-long bar, in percent of the drawn span.

    Measured from the DURATION, never as the difference of two rounded
    positions: rounding each end separately makes two bars of identical planned
    hours come out a rounding step apart, which is precisely the "same hours,
    different length" the planning axis exists to prevent.
    """
    if total_hours <= 0:
        return minimum
    return round(max(hours / total_hours * 100, minimum), 2)
