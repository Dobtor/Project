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


def _strip_js_comments(text):
    """Prose is full of "NO IMPORTS." and "24 HOURS"; only code counts."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<![:\\])//[^\n]*", "", text)


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


    def test_module_level_names_are_imported(self):
        """A name that is always module-level must be imported where it is used.

        `_t`, the `useX` hooks and SCREAMING_CONSTANTS are never local variables
        in this codebase — they arrive by import or they are undefined. Undefined
        is not a build error: the bundle loads, and the ReferenceError waits
        inside whichever method touches it. Splitting the renderer left `_t`
        behind in the gestures module exactly that way, and the first thing that
        happened in production was the whole view failing to mount.
        """
        # Names that are never local in this codebase: the translation function,
        # the hooks, SCREAMING constants, and CamelCase things that get called or
        # dotted (components, classes, luxon's DateTime).
        MODULE_LEVEL = re.compile(
            r"(?<![\w.$])(?:new\s+)?(_t|use[A-Z]\w*|[A-Z][A-Z0-9_]{2,}|[A-Z][a-zA-Z0-9]+)\s*[(.]")
        BUILTINS = {
            "Math", "Object", "Promise", "Set", "Map", "Array", "JSON", "Number",
            "String", "Boolean", "Date", "Error", "RegExp", "Symbol", "WeakMap",
            "WeakSet", "Intl", "ResizeObserver", "MutationObserver", "Infinity",
            "IntersectionObserver", "Element", "Node", "Event", "CustomEvent",
            "DOMParser", "XMLHttpRequest", "FormData", "URL", "URLSearchParams",
            "Blob", "File", "FileReader", "Image", "Audio", "Worker", "NaN",
            "Notification", "AbortController", "TextEncoder", "TextDecoder",
        }


        missing = []
        for js in sorted((MODULE_ROOT / "static" / "src").rglob("*.js")):
            raw = js.read_text(encoding="utf-8")
            src = _strip_js_comments(raw)
            imported = set()
            for group, _spec in NAMED_IMPORT.findall(src):
                imported |= {n.strip().split(" as ")[-1]
                             for n in group.split(",") if n.strip()}
            imported |= set(re.findall(r"^import\s+(\w+)\s+from", src, re.M))
            # Declarations anywhere, not only at the top level: a SCREAMING
            # constant is often built inside the method that uses it.
            declared = set(re.findall(
                r"(?:^|[\s;{(])(?:export\s+)?(?:const|let|var|function|class)\s+(\w+)",
                src, re.M))
            declared |= set(re.findall(r"const\s*\{([^}]*)\}\s*=", src)and
                            [n.strip() for g in re.findall(r"const\s*\{([^}]*)\}\s*=", src)
                             for n in g.split(",")] or [])
            for name in set(MODULE_LEVEL.findall(src)):
                if name in imported or name in declared or name in BUILTINS:
                    continue
                missing.append(f"{js.relative_to(MODULE_ROOT)}: {name}")
        self.assertEqual(sorted(missing), [], "\n" + "\n".join(sorted(missing)))


    def test_own_exports_are_imported_where_used(self):
        """The check above only sees names that LOOK module-level (_t, useX,
        CamelCase). A lowercase helper — humanizeHours, cellsDeltaToDuration —
        looks exactly like a local variable, so it needs a different rule: if a
        name this module EXPORTS somewhere is used in another file without being
        imported or declared there, that use is undefined.
        """
        js_files = sorted((MODULE_ROOT / "static" / "src").rglob("*.js"))
        exported = {}
        for js in js_files:
            src = js.read_text(encoding="utf-8")
            for name in re.findall(
                    r"^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)",
                    src, re.M):
                exported[name] = js
            for group in re.findall(r"^export\s*\{([^}]*)\}", src, re.M):
                for raw in group.split(","):
                    name = raw.strip().split(" as ")[-1]
                    if name:
                        exported.setdefault(name, js)
        self.assertTrue(exported, "no exports found — the scan is broken")

        missing = []
        for js in js_files:
            src = _strip_js_comments(js.read_text(encoding="utf-8"))
            imported = set()
            for group, _spec in NAMED_IMPORT.findall(src):
                imported |= {n.strip().split(" as ")[-1]
                             for n in group.split(",") if n.strip()}
            imported |= set(re.findall(r"^import\s+(\w+)\s+from", src, re.M))
            declared = set(re.findall(
                r"(?:^|[\s;{(,])(?:export\s+)?(?:const|let|var|function|class)\s+(\w+)",
                src, re.M))
            for name, home in exported.items():
                if home == js or name in imported or name in declared:
                    continue
                if re.search(r"(?<![\w.$])" + re.escape(name) + r"\s*[(.]", src):
                    missing.append(f"{js.relative_to(MODULE_ROOT)}: {name} "
                                   f"(exported by {home.name})")
        self.assertEqual(sorted(missing), [], "\n" + "\n".join(sorted(missing)))


class TestRendererMixins(unittest.TestCase):
    """The renderer and its mixins share one prototype, so a method call must
    find a definition SOMEWHERE in the trio.

    Splitting a component moves methods between files; a call left pointing at a
    method that did not come along fails only when that path runs. Both
    production failures in this branch were the file-scope version of this.
    """

    TRIO = ("gantt_renderer.js", "gantt_renderer_axis.js",
            "gantt_renderer_gestures.js")
    COMPONENT_DIR = MODULE_ROOT / "static" / "src" / "components" / "gantt_view"
    OWL_MEMBERS = {"render", "mounted", "willUnmount", "willStart",
                   "willUpdateProps", "patched", "setup"}

    def test_every_this_call_resolves(self):
        sources = {}
        for name in self.TRIO:
            path = self.COMPONENT_DIR / name
            self.assertTrue(path.is_file(), "%s is missing" % name)
            sources[name] = path.read_text(encoding="utf-8")

        defined = set(self.OWL_MEMBERS)
        for src in sources.values():
            defined |= set(re.findall(
                r"^\s{4}(?:static\s+)?(?:async\s+)?(?:get\s+)?([A-Za-z_]\w*)\s*\(",
                src, re.M))
            # properties assigned in setup(), e.g. this.displayDialog = useOwnedDialogs()
            defined |= set(re.findall(r"this\.(\w+)\s*=", src))

        missing = []
        for name, src in sources.items():
            for called in set(re.findall(r"this\.(\w+)\s*\(", _strip_js_comments(src))):
                if called not in defined:
                    missing.append(f"{name}: this.{called}()")
        self.assertEqual(sorted(missing), [], "\n" + "\n".join(sorted(missing)))


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
