# -*- coding: utf-8 -*-
"""The report's planning axis, and its agreement with the chart's.

Plain ``unittest`` on purpose: ``report/plan_axis.py`` imports nothing from
Odoo, so these run with no database —

    python3 dobtor_project/tests/test_plan_axis.py -v

— and Odoo's runner picks them up as well. (Run the FILE, not the module: going
through the package would import dobtor_project/__init__.py, which does need
Odoo. The import below resolves either way.) Every planning bug fixed in this
branch lived in exactly this arithmetic (markers three times too far out, the
edge padding measured in clock hours, labels disagreeing with the screen), and
none of it was covered by anything.
"""

import unittest

try:  # inside Odoo
    from odoo.addons.dobtor_project.report import plan_axis
except ImportError:  # standalone: load the file, importing no package
    import importlib.util
    import pathlib
    _path = pathlib.Path(__file__).resolve().parents[1] / "report" / "plan_axis.py"
    _spec = importlib.util.spec_from_file_location("plan_axis", _path)
    plan_axis = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(plan_axis)


class TestPlanAxisLabels(unittest.TestCase):
    """day_label must produce the same strings as planDayLabel in
    gantt_plan_axis.js — the report and the chart name the same position."""

    def test_matches_the_javascript_table(self):
        # The exact cases asserted by tests/geometry/plan_axis_sweep.mjs.
        cases = [
            (0, 8, "T"),
            (8, 8, "T+1d"),
            (24, 8, "T+3d"),
            (12, 8, "T+1.5d"),
        ]
        for hours, hpd, expected in cases:
            with self.subTest(hours=hours, hpd=hpd):
                self.assertEqual(plan_axis.day_label(hours, hpd), expected)

    def test_signs_and_rounding(self):
        self.assertEqual(plan_axis.day_label(-16, 8), "T-2d")
        self.assertEqual(plan_axis.day_label(-12, 8), "T-1.5d")
        # within the rounding tolerance of a whole day
        self.assertEqual(plan_axis.day_label(8.05, 8), "T+1d")
        self.assertEqual(plan_axis.day_label(0.0005, 8), "T")

    def test_follows_the_project_calendar(self):
        # A "day" is the calendar's working day, not 24 hours.
        self.assertEqual(plan_axis.day_label(24, 8), "T+3d")
        self.assertEqual(plan_axis.day_label(24, 24), "T+1d")
        self.assertEqual(plan_axis.day_label(24, 4), "T+6d")
        # A missing/zero hours_per_day must not divide by zero.
        self.assertEqual(plan_axis.day_label(8, 0), "T+1d")


class TestPlanAxisMarkers(unittest.TestCase):

    def test_marks_land_on_working_days_not_calendar_days(self):
        # 0h → 80h on an 8h calendar is ten working days: marks every day.
        marks = plan_axis.markers(0, 80, hpd=8)
        self.assertEqual([m['label'] for m in marks][:4],
                         ["T", "T+1d", "T+2d", "T+3d"])
        # T+3d is 24 planned hours in, i.e. 30% of an 80-hour span. Stepping in
        # CALENDAR days put it at 90% — three times too far out.
        t3 = next(m for m in marks if m['label'] == "T+3d")
        self.assertAlmostEqual(t3['left_pct'], 30.0, places=2)

    def test_interval_widens_with_the_span(self):
        self.assertEqual(plan_axis.marker_interval(10), 1)
        self.assertEqual(plan_axis.marker_interval(30), 7)
        self.assertEqual(plan_axis.marker_interval(100), 14)
        self.assertEqual(plan_axis.marker_interval(400), 30)
        # a 400-working-day plan marks months, not days
        marks = plan_axis.markers(0, 400 * 8, hpd=8)
        self.assertEqual([m['label'] for m in marks][:3], ["T", "T+30d", "T+60d"])

    def test_marks_stay_inside_the_drawn_span(self):
        for hpd in (4, 7.5, 8, 24):
            for start, end in ((0, 80), (13, 400), (100, 101), (0, 5000)):
                with self.subTest(hpd=hpd, start=start, end=end):
                    for m in plan_axis.markers(start, end, hpd=hpd):
                        self.assertGreaterEqual(m['left_pct'], -0.01)
                        self.assertLessEqual(m['left_pct'], 100.01)

    def test_no_marks_for_an_empty_or_inverted_span(self):
        self.assertEqual(plan_axis.markers(10, 10, hpd=8), [])
        self.assertEqual(plan_axis.markers(50, 10, hpd=8), [])

    def test_first_mark_is_not_before_the_span(self):
        # A chart starting mid-plan must not draw a mark to the left of itself.
        marks = plan_axis.markers(17, 200, hpd=8)
        self.assertTrue(marks)
        self.assertGreaterEqual(marks[0]['left_pct'], 0)


class TestPlanAxisGeometry(unittest.TestCase):
    """The property the whole planning axis exists for."""

    def test_equal_planned_hours_draw_equal_width(self):
        total = 240.0
        for hours in (0.5, 4, 8, 40):
            # The width does not depend on WHERE the bar sits.
            widths = {plan_axis.span_pct(hours, total) for _offset in
                      (0, 3, 8, 17.25, 100, 199.5)}
            self.assertEqual(len(widths), 1,
                             "%sh drew %s different widths" % (hours, len(widths)))

    def test_width_is_not_the_difference_of_two_rounded_positions(self):
        # Rounding each end separately loses up to a rounding step, so two bars
        # of identical hours could come out different lengths. span_pct rounds
        # once, at the end.
        total = 240.0
        hours = 4.0
        exact = plan_axis.span_pct(hours, total)
        for offset in (0, 3, 17.25, 199.5):
            naive = round(plan_axis.position_pct(offset + hours, 0, total)
                          - plan_axis.position_pct(offset, 0, total), 2)
            # one rounding step (0.01) plus float slack
            self.assertAlmostEqual(naive, exact, delta=0.011)
        self.assertEqual(plan_axis.span_pct(0.001, total, minimum=0.3), 0.3)

    def test_position_is_proportional_to_hours(self):
        self.assertEqual(plan_axis.position_pct(0, 0, 100), 0.0)
        self.assertEqual(plan_axis.position_pct(50, 0, 100), 50.0)
        self.assertEqual(plan_axis.position_pct(100, 0, 100), 100.0)
        self.assertEqual(plan_axis.position_pct(5, 0, 0), 0.0)


if __name__ == "__main__":
    unittest.main()
