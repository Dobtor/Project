#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Every check that runs without a database, in one command.

    python3 dobtor_project/tests/run_checks.py

Roughly four seconds. Run it before pushing; it is the difference between
finding a mistake here and finding it in the browser, which is where the last
three went. Exits non-zero if anything fails, so it drops straight into a hook:

    git config core.hooksPath .githooks
    mkdir -p .githooks && cat > .githooks/pre-commit <<'SH'
    #!/bin/sh
    exec python3 dobtor_project/tests/run_checks.py
    SH
    chmod +x .githooks/pre-commit

WHAT IT DOES NOT COVER: anything that needs a database or a browser. The 24
cases in tests/test_cascade.py are the server's behaviour — cascades, work
hours, constraints — and they need Odoo:

    odoo-bin -d <db> -u dobtor_project --test-enable \\
             --test-tags /dobtor_project --stop-after-init
"""

import pathlib
import subprocess
import sys
import time

MODULE_ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO_ROOT = MODULE_ROOT.parent

# (label, argv, what it protects)
CHECKS = [
    ("py compile", [sys.executable, "-m", "compileall", "-q",
                    str(MODULE_ROOT / "models"), str(MODULE_ROOT / "report"),
                    str(MODULE_ROOT / "wizard"), str(MODULE_ROOT / "tests"),
                    str(MODULE_ROOT / "migrations")],
     "python syntax"),
    ("imports & members", [sys.executable, str(MODULE_ROOT / "tests" / "test_static_imports.py")],
     "a name that is used but never imported, an import nobody uses, a template "
     "calling a method that does not exist, a this.X() with no definition"),
    ("scss classes", [sys.executable, str(MODULE_ROOT / "tests" / "test_scss_classes.py")],
     "styling a class nothing applies — and NOT deleting one composed at runtime"),
    ("plan axis (py)", [sys.executable, str(MODULE_ROOT / "tests" / "test_plan_axis.py")],
     "the report's planning maths"),
    ("palette (py)", [sys.executable, str(MODULE_ROOT / "tests" / "test_report_colors.py")],
     "the report's colours matching the chart's"),
    ("plan axis (js)", ["node", str(MODULE_ROOT / "tests" / "geometry" / "plan_axis_sweep.mjs")],
     "equal planned hours drawing equal length"),
    ("work-time axis", ["node", str(MODULE_ROOT / "tests" / "geometry" / "worktime_axis_sweep.mjs")],
     "a day cell being the day's work, breaks and nights taking no width"),
    ("timezone axis", ["node", str(MODULE_ROOT / "tests" / "geometry" / "axis_timezone_sweep.mjs")],
     "the calendar being read on the project's clock, not the viewer's"),
    ("connectors", ["node", str(MODULE_ROOT / "tests" / "geometry" / "arrow_path_sweep.mjs")],
     "no backfold, attached at both ends, 45° exits"),
    ("palette (js)", ["node", str(MODULE_ROOT / "tests" / "geometry" / "colors_check.mjs")],
     "the chart's colours matching the fixture"),
]


def _node_available():
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def main():
    have_node = _node_available()
    failures = []
    skipped = []
    started = time.time()

    for label, argv, protects in CHECKS:
        if argv[0] == "node" and not have_node:
            skipped.append((label, "node not installed"))
            print(f"  SKIP  {label:20s} (node not installed)")
            continue
        result = subprocess.run(argv, capture_output=True, text=True, cwd=REPO_ROOT)
        if result.returncode == 0:
            print(f"  ok    {label:20s} {protects}")
        else:
            failures.append((label, result))
            print(f"  FAIL  {label:20s} {protects}")

    elapsed = time.time() - started
    print()
    if failures:
        for label, result in failures:
            print(f"--- {label} " + "-" * (60 - len(label)))
            output = (result.stdout + result.stderr).strip()
            print(output[-2000:] if output else "(no output)")
            print()
        print(f"{len(failures)} check(s) failed in {elapsed:.1f}s")
        return 1

    note = f", {len(skipped)} skipped" if skipped else ""
    print(f"all {len(CHECKS) - len(skipped)} checks passed in {elapsed:.1f}s{note}")
    print("(a database is still needed for tests/test_cascade.py — see the docstring)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
