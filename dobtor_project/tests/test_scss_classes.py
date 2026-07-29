# -*- coding: utf-8 -*-
"""Every class this module styles is a class this module applies.

    python3 dobtor_project/tests/test_scss_classes.py -v

Dead CSS is invisible: nothing breaks, the bundle just carries rules for markup
that no longer exists. This branch deleted 166 lines of it — a colour-swatch
feature whose consumer had been replaced by inline styles, a loading skeleton,
and a badge whose JS had been removed two commits earlier.

The trap is that a scan alone would ALSO have deleted the violation classes,
which look equally unreferenced and are perfectly alive: they are composed at
runtime as ``'o_gantt_violation_' + severity``. So the whitelist here is not
hand-maintained — it is discovered from the code, by reading the string literals
that get concatenated onto something else and treating them as prefixes.
"""

import pathlib
import re
import unittest

MODULE_ROOT = pathlib.Path(__file__).resolve().parents[1]
SCSS = MODULE_ROOT / "static" / "src" / "scss" / "gantt_native.scss"

# Classes owned by Odoo core that this module deliberately restyles; they are
# never written in our markup because they are not ours to write.
FOREIGN = {
    "o_control_panel", "o_datetime_input", "o_form_view", "o_content",
    "o_action_manager", "modal", "btn", "dropdown", "fa",
}

CLASS_SELECTOR = re.compile(r"^\s*\.([a-z][\w-]+)", re.M)
# A class name built at runtime: "… o_gantt_violation_" + severity, or
# `o_gantt_color_${i}`. What matters is the LAST token of the literal that gets
# something concatenated onto it — that token is the prefix of a whole family of
# class names no scan can see.
CONCAT_LITERAL = re.compile(r"""["'`]([^"'`\n]*?)["'`]\s*\+""")
TEMPLATE_PREFIX = re.compile(r"""`([^`\n]*?)\$\{""")


def _dynamic_prefixes(text):
    out = set()
    for literal in CONCAT_LITERAL.findall(text) + TEMPLATE_PREFIX.findall(text):
        token = literal.split()[-1] if literal.split() else ""
        if token.endswith(("_", "-")) and re.match(r"^[a-z][\w-]*$", token):
            out.add(token)
    return out


def _consumers():
    """All markup/behaviour that can apply a class."""
    text = []
    for pattern in ("static/src/**/*.js", "static/src/**/*.xml", "report/*.xml",
                    "views/*.xml"):
        for path in MODULE_ROOT.glob(pattern):
            text.append(path.read_text(encoding="utf-8"))
    return "\n".join(text)


class TestScssClasses(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.scss = SCSS.read_text(encoding="utf-8")
        cls.consumers = _consumers()
        cls.prefixes = sorted(_dynamic_prefixes(cls.consumers))

    def test_dynamic_prefixes_were_discovered(self):
        """If this stops finding prefixes the whitelist has silently emptied and
        the test below would start reporting live classes as dead."""
        self.assertIn("o_gantt_violation_", self.prefixes)

    def test_no_styled_class_is_unused(self):
        classes = set(CLASS_SELECTOR.findall(self.scss))
        self.assertGreater(len(classes), 100, "SCSS selectors not parsed")

        dead = []
        for cls_name in sorted(classes):
            if cls_name in FOREIGN:
                continue
            if re.search(r"[\"'\s.(]" + re.escape(cls_name) + r"[\"'\s.)]",
                         self.consumers):
                continue
            if any(cls_name.startswith(p) for p in self.prefixes):
                continue          # composed at runtime, e.g. 'o_gantt_violation_' + severity
            dead.append(cls_name)

        self.assertEqual(dead, [], "\nstyled but never applied:\n  " + "\n  ".join(dead))


if __name__ == "__main__":
    unittest.main()
