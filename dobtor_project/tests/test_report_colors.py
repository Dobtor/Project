# -*- coding: utf-8 -*-
"""The PDF report's colour palette matches the chart's.

    python3 dobtor_project/tests/test_report_colors.py -v

A bar must be the same colour on screen and on paper. The palette is a
production constant in two languages — static/.../gantt_colors.js and
report/project_gantt_report.py — and the Python copy carried nothing but a
comment saying "must match frontend GANTT_COLORS exactly", which is the same
arrangement that let the planning axis drift. Both sides now assert against
tests/fixtures/gantt_colors.json; the JS half is tests/geometry/colors_check.mjs.

Reads the report module as TEXT rather than importing it: the report imports
odoo, and this has to run without one.
"""

import json
import pathlib
import re
import unittest

MODULE_ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = json.loads((MODULE_ROOT / "tests" / "fixtures" / "gantt_colors.json")
                     .read_text(encoding="utf-8"))
REPORT_SRC = (MODULE_ROOT / "report" / "project_gantt_report.py").read_text(encoding="utf-8")


def _report_palette():
    block = re.search(r"GANTT_COLORS\s*=\s*\[(.*?)\]", REPORT_SRC, re.S)
    assert block, "GANTT_COLORS not found in project_gantt_report.py"
    return re.findall(r'"([^"]*)"', block.group(1))


def _report_no_color_style():
    m = re.search(r'NO_COLOR_STYLE\s*=\s*"([^"]*)"', REPORT_SRC)
    assert m, "NO_COLOR_STYLE not found in project_gantt_report.py"
    return m.group(1)


class TestReportColours(unittest.TestCase):

    def test_palette_matches_the_shared_fixture(self):
        self.assertEqual(_report_palette(), FIXTURE["gantt_colors"])

    def test_no_colour_style_matches(self):
        self.assertEqual(_report_no_color_style(), FIXTURE["no_color_style"])

    def test_index_zero_is_the_no_colour_slot(self):
        # Both sides branch on it: index 0 means "draw the outline, no fill".
        self.assertEqual(_report_palette()[0], "")
        self.assertEqual(FIXTURE["gantt_colors"][0], "")


if __name__ == "__main__":
    unittest.main()
