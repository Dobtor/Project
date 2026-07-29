/** @odoo-module **/

/**
 * The task colour palette — plain data, NO IMPORTS.
 *
 * Index 0 is "no colour" (the bar draws with a border and no fill); 1..11 are
 * the values `color_gantt` stores. The chart applies them as inline styles and
 * the PDF report has to arrive at exactly the same colours, so
 * report/project_gantt_report.py carries a copy — the two are pinned together by
 * tests/fixtures/gantt_colors.json, which both sides assert against.
 *
 * Import-free so tests/geometry/colors_check.mjs can load this exact file under
 * plain node, the same arrangement as the geometry and axis modules.
 */
export const GANTT_COLORS = [
    "",          // 0: No color (white/default)
    "#ee2d2d",   // 1: Red
    "#dc8534",   // 2: Orange
    "#e8bb1d",   // 3: Yellow
    "#5794dd",   // 4: Cyan
    "#9f628f",   // 5: Purple
    "#db8865",   // 6: Almond
    "#41a9a2",   // 7: Teal
    "#304be0",   // 8: Blue
    "#ee2f8a",   // 9: Raspberry
    "#61c36e",   // 10: Green
    "#9872e6",   // 11: Violet
];

/** Style for a bar of colour `index`: a fill, or the no-colour outline. */
export const NO_COLOR_STYLE = "background:#fff;border:1.5px solid #999;";
