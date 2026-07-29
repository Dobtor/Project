# -*- coding: utf-8 -*-
"""Every named import in this module's JS must actually be exported.

    python3 dobtor_project/tests/test_static_imports.py -v

A JS module that imports a name nothing exports does not fail to build — Odoo
bundles it happily and the name is simply ``undefined`` at runtime, so the first
line that touches it throws and takes the whole view down. ``node --check`` sees
nothing (the syntax is perfect) and neither does a code review, because
``import { DateTime } from "@web/core/l10n/dates"`` reads exactly like the two
dozen imports around it that are real. That import is not real: dates.js exports
date HELPERS, and the DateTime class comes from the ``luxon`` global. It shipped
in this branch and was caught by review rather than by anything automatic —
hence this.

Resolves ``@web/...`` against the running Odoo when there is one, and against
ODOO_SRC (or a local checkout) when run standalone; skips if it cannot find one,
because a missing checkout must not look like a failure.
"""

import os
import pathlib
import re
import unittest

MODULE_ROOT = pathlib.Path(__file__).resolve().parents[1]

# Bare specifiers that are neither @web nor relative: owl and friends live in the
# bundle, not on disk in a form worth parsing.
IGNORED_PREFIXES = ("@odoo/",)


def _find_web_src():
    """The web addon's static/src, or None."""
    try:  # inside Odoo: derive it from the running installation
        import odoo
        candidate = pathlib.Path(odoo.__file__).resolve().parent.parent / "addons" / "web" / "static" / "src"
        if candidate.is_dir():
            return candidate
    except Exception:
        pass
    for raw in (os.environ.get("ODOO_SRC"),
                "~/Desktop/Claude/odoo-18.0",
                "~/Documents/GitHub/odoo"):
        if not raw:
            continue
        candidate = pathlib.Path(raw).expanduser() / "addons" / "web" / "static" / "src"
        if candidate.is_dir():
            return candidate
    return None


WEB_SRC = _find_web_src()

NAMED_IMPORT = re.compile(r'import\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]')
EXPORT_DECL = re.compile(
    r'^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)', re.M)
EXPORT_LIST = re.compile(r'^export\s*\{([^}]*)\}', re.M)


def _exports_of(path):
    src = path.read_text(encoding="utf-8")
    names = set(EXPORT_DECL.findall(src))
    for group in EXPORT_LIST.findall(src):
        names |= {part.strip().split(" as ")[-1]
                  for part in group.split(",") if part.strip()}
    return names


class TestStaticImports(unittest.TestCase):

    @unittest.skipIf(WEB_SRC is None,
                     "no Odoo source found (set ODOO_SRC to enable)")
    def test_every_named_import_resolves(self):
        unresolved = []
        for js in sorted((MODULE_ROOT / "static" / "src").rglob("*.js")):
            src = js.read_text(encoding="utf-8")
            for names_group, spec in NAMED_IMPORT.findall(src):
                names = [n.strip().split(" as ")[0]
                         for n in names_group.split(",") if n.strip()]
                if spec.startswith(IGNORED_PREFIXES):
                    continue
                if spec.startswith("@web/"):
                    target = WEB_SRC / (spec[len("@web/"):] + ".js")
                elif spec.startswith("."):
                    target = (js.parent / (spec + ".js")).resolve()
                else:
                    continue
                rel = js.relative_to(MODULE_ROOT)
                if not target.is_file():
                    unresolved.append(f"{rel}: '{spec}' — no such module")
                    continue
                exported = _exports_of(target)
                for name in names:
                    if name not in exported:
                        unresolved.append(
                            f"{rel}: '{spec}' does not export {name}")
        self.assertEqual(unresolved, [], "\n" + "\n".join(unresolved))

    def test_no_named_import_is_unused(self):
        """An import nobody uses is either a leftover or a rename that only half
        happened; both mislead the next reader about what a module depends on."""
        unused = []
        for js in sorted((MODULE_ROOT / "static" / "src").rglob("*.js")):
            src = js.read_text(encoding="utf-8")
            body = NAMED_IMPORT.sub("", src)          # everything but the imports
            for names_group, _spec in NAMED_IMPORT.findall(src):
                for raw in names_group.split(","):
                    if not raw.strip():
                        continue
                    name = raw.strip().split(" as ")[-1]
                    if not re.search(r"\b" + re.escape(name) + r"\b", body):
                        unused.append(f"{js.relative_to(MODULE_ROOT)}: {name}")
        self.assertEqual(unused, [], "\n" + "\n".join(unused))


class TestTemplateReferences(unittest.TestCase):
    """Every member the OWL template calls must exist on a component.

    A template that calls a method nothing defines throws only when that branch
    renders — which can be a context menu nobody opened during testing. The
    scanner below caught nothing the day it was written; it is here for the day
    a member is renamed and one t-att-class is missed.
    """

    COMPONENT_DIR = MODULE_ROOT / "static" / "src" / "components" / "gantt_view"
    # Bare identifiers in QWeb that are not component members.
    QWEB_GLOBALS = {
        "props", "state", "env", "true", "false", "null", "undefined", "this",
        "Math", "Object", "JSON", "Array", "Number", "String", "Boolean",
        "parseInt", "parseFloat", "isNaN", "luxon", "console",
    }
    MEMBER_LIKE = re.compile(r"^(on[A-Z]|get[A-Z]|is[A-Z]|has[A-Z]|format[A-Z]|"
                             r"toggle[A-Z]|set[A-Z]|_)")

    def test_every_template_member_is_defined(self):
        xml_files = list(self.COMPONENT_DIR.glob("*.xml"))
        self.assertTrue(xml_files, "no component template found")

        defined = set()
        for js in self.COMPONENT_DIR.glob("*.js"):
            defined |= set(re.findall(
                r"^\s{4}(?:static\s+)?(?:async\s+)?(?:get\s+)?([A-Za-z_]\w*)\s*\(",
                js.read_text(encoding="utf-8"), re.M))

        missing = []
        for xml in xml_files:
            src = xml.read_text(encoding="utf-8")
            local = set(re.findall(r't-set="(\w+)"', src))
            local |= set(re.findall(r't-as="(\w+)"', src))
            exprs = re.findall(r't-[a-z-]+(?:\.[a-z]+)?="([^"]*)"', src)
            exprs += re.findall(r"\{\{([^}]*)\}\}", src)
            for expr in exprs:
                # `this.X(` — a CALL must resolve to a method. A bare
                # `this.state.foo` is a property and is none of our business.
                names = set(re.findall(r"\bthis\.([A-Za-z_]\w*)\s*\(", expr))
                for bare in re.findall(r"(?<![\w.])([A-Za-z_]\w*)\s*\(", expr):
                    if (bare not in local and bare not in self.QWEB_GLOBALS
                            and self.MEMBER_LIKE.match(bare)):
                        names.add(bare)
                for name in names:
                    if name not in defined:
                        missing.append(f"{xml.name}: {name}")
        self.assertEqual(sorted(set(missing)), [], "\n" + "\n".join(sorted(set(missing))))


if __name__ == "__main__":
    unittest.main()
