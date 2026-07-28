# -*- coding: utf-8 -*-
"""Tests for the unified dependency-cascade engine.

Background
----------
The interactive gantt drag/resize path calls ``action_move_and_cascade`` which
used to run TWO near-duplicate cascade implementations
(``_cascade_dependency_push`` triggered by ``write()`` + an explicit
``_cascade_fs_push``), and ``_cascade_fs_push`` itself wrote pushed targets
*without* ``skip_cascade_push`` — spawning yet another nested cascade. Results
were correct (the pushes are idempotent) but the successor graph was walked
2–3× per gesture.

The two implementations were merged into a single canonical BFS engine
(``_cascade_fs_push``); ``_cascade_dependency_push`` now delegates to it, the
engine's own writes set ``skip_cascade_push=True`` (its BFS stack is the sole
propagator), and ``action_move_and_cascade`` writes step 1 with
``skip_cascade_push=True`` so only the explicit step-2 cascade runs.

These tests lock in the BEHAVIOUR (correct FS/SS pushes, multi-hop chains,
duration preservation, both the gantt RPC path and the plain ``write()`` path)
and guard against regressions of the merge via a single-pass / idempotency
assertion.
"""

from datetime import datetime, timedelta

from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestDependencyCascade(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # use_calendar=False → write() performs no working-time date snapping,
        # so dates stay exactly where the cascade puts them (deterministic).
        cls.project = cls.env["project.project"].create({
            "name": "Cascade Test Project",
            "use_calendar": False,
        })
        cls.Task = cls.env["project.task"]
        cls.Pred = cls.env["project.task.predecessor"]

    def _task(self, name, start, end):
        """Create a manual-mode leaf task with real dates (not planning mode),
        so the explicit dates are authoritative for the cascade.

        ``plan_duration`` is set to match the window: the scheduled hours are
        the single source of truth for a task's length, so a pushed task's end
        is re-derived from them. With ``use_calendar=False`` that derivation is
        plain ``start + hours``, which keeps these fixtures' windows intact.
        """
        return self.Task.create({
            "name": name,
            "project_id": self.project.id,
            "schedule_mode": "manual",
            "date_start": start,
            "date_end": end,
            "plan_duration": (end - start).total_seconds() / 3600.0,
        })

    def _link(self, source, target, link_type="FS", lag_hours=0.0):
        """Create a predecessor link: source → target."""
        return self.Pred.create({
            "parent_task_id": source.id,
            "task_id": target.id,
            "type": link_type,
            "lag_hours": lag_hours,
        })

    # ------------------------------------------------------------------
    # FS — the core gantt drag/resize case
    # ------------------------------------------------------------------
    def test_fs_push_via_move_and_cascade(self):
        """Moving A so it overlaps its FS successor B pushes B to A.end,
        preserving B's duration. Exercises the gantt RPC path."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        b = self._task("B", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 6, 9, 0))
        self._link(a, b, "FS")

        # Move A right by 4 days → A.end (03-07) now overlaps B.start (03-04).
        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 5, 9, 0),
            "date_end": datetime(2026, 3, 7, 9, 0),
        })

        # B pushed to start = A.end, duration (2 days) preserved.
        self.assertEqual(b.date_start, datetime(2026, 3, 7, 9, 0))
        self.assertEqual(b.date_end, datetime(2026, 3, 9, 9, 0))

    def test_fs_no_push_when_no_overlap(self):
        """If the moved task still ends before its successor starts, nothing
        is pushed (push amount <= 0)."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        b = self._task("B", datetime(2026, 3, 10, 9, 0), datetime(2026, 3, 12, 9, 0))
        self._link(a, b, "FS")

        # Move A a little, still ending (03-05) well before B.start (03-10).
        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 3, 9, 0),
            "date_end": datetime(2026, 3, 5, 9, 0),
        })

        self.assertEqual(b.date_start, datetime(2026, 3, 10, 9, 0))
        self.assertEqual(b.date_end, datetime(2026, 3, 12, 9, 0))

    # ------------------------------------------------------------------
    # Multi-hop chain — the merged BFS must propagate transitively
    # ------------------------------------------------------------------
    def test_fs_chain_cascades_transitively(self):
        """A → B → C: moving A cascades through B to C in a single call."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        b = self._task("B", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 6, 9, 0))
        c = self._task("C", datetime(2026, 3, 7, 9, 0), datetime(2026, 3, 9, 9, 0))
        self._link(a, b, "FS")
        self._link(b, c, "FS")

        # Move A far right (start 03-10, end 03-12).
        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 10, 9, 0),
            "date_end": datetime(2026, 3, 12, 9, 0),
        })

        # B → A.end; C → B.end. Both durations (2 days) preserved.
        self.assertEqual(b.date_start, datetime(2026, 3, 12, 9, 0))
        self.assertEqual(b.date_end, datetime(2026, 3, 14, 9, 0))
        self.assertEqual(c.date_start, datetime(2026, 3, 14, 9, 0))
        self.assertEqual(c.date_end, datetime(2026, 3, 16, 9, 0))

    def test_diamond_takes_latest_predecessor(self):
        """A→B, A→C, B→D, C→D: D is pushed by whichever predecessor ends
        latest (max constraint), regardless of traversal order."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        b = self._task("B", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 5, 9, 0))   # 1d
        c = self._task("C", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 8, 9, 0))   # 4d (later end)
        d = self._task("D", datetime(2026, 3, 9, 9, 0), datetime(2026, 3, 11, 9, 0))  # 2d
        self._link(a, b, "FS")
        self._link(a, c, "FS")
        self._link(b, d, "FS")
        self._link(c, d, "FS")

        # Move A right so both B and C shift, and C ends latest.
        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 12, 9, 0),
            "date_end": datetime(2026, 3, 14, 9, 0),
        })

        # A.end = 03-14 → B (1d) ends 03-15, C (4d) ends 03-18.
        self.assertEqual(c.date_end, datetime(2026, 3, 18, 9, 0))
        # D must start at the LATER of B.end / C.end = C.end (03-18), dur 2d.
        self.assertEqual(d.date_start, datetime(2026, 3, 18, 9, 0))
        self.assertEqual(d.date_end, datetime(2026, 3, 20, 9, 0))

    def test_cross_level_convergence(self):
        """A→B, A→C, C→B, B→D. B is pushed by A (early) AND by C (later, since
        C is itself pushed by A). D must follow B's FINAL (C-based) dates, not
        the earlier A-based ones. This guards the cascade's full convergence:
        a node pushed again after it was first processed must still re-propagate
        to its successors (regression test for skipping nested cascades)."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        c = self._task("C", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 8, 9, 0))   # 4d
        b = self._task("B", datetime(2026, 3, 9, 9, 0), datetime(2026, 3, 10, 9, 0))  # 1d
        d = self._task("D", datetime(2026, 3, 11, 9, 0), datetime(2026, 3, 13, 9, 0)) # 2d
        self._link(a, c, "FS")
        self._link(a, b, "FS")
        self._link(c, b, "FS")
        self._link(b, d, "FS")

        # Move A far right.
        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 20, 9, 0),
            "date_end": datetime(2026, 3, 22, 9, 0),
        })

        # C → A.end (03-22), dur 4d → ends 03-26.
        self.assertEqual(c.date_end, datetime(2026, 3, 26, 9, 0))
        # B bound by the LATER of A.end (03-22) and C.end (03-26) → starts 03-26.
        self.assertEqual(b.date_start, datetime(2026, 3, 26, 9, 0))
        self.assertEqual(b.date_end, datetime(2026, 3, 27, 9, 0))
        # D must follow B's FINAL end (03-27), not the early A-based 03-23.
        self.assertEqual(d.date_start, datetime(2026, 3, 27, 9, 0))
        self.assertEqual(d.date_end, datetime(2026, 3, 29, 9, 0))

    # ------------------------------------------------------------------
    # Parent drag must cascade a descendant's external successor
    # ------------------------------------------------------------------
    def test_parent_drag_cascades_descendant_successor(self):
        """Dragging a parent moves its children; a child's EXTERNAL FS successor
        must be cascaded too. The parent-move path seeds all moved descendants
        into the relaxation, not just the parent."""
        parent = self._task("P", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 8, 9, 0))
        child = self._task("C", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 6, 9, 0))
        child.parent_id = parent.id
        succ = self._task("S", datetime(2026, 3, 10, 9, 0), datetime(2026, 3, 12, 9, 0))
        self._link(child, succ, "FS")  # C → S (S is outside the parent subtree)

        # Move the parent (and thus the child) right by 10 days (240h).
        parent.action_move_and_cascade(shift_hours=240.0)

        # Child moved to 03-14 → 03-16; its successor S must follow to 03-16 → 03-18.
        self.assertEqual(child.date_end, datetime(2026, 3, 16, 9, 0))
        self.assertEqual(succ.date_start, datetime(2026, 3, 16, 9, 0))
        self.assertEqual(succ.date_end, datetime(2026, 3, 18, 9, 0))

    # ------------------------------------------------------------------
    # SS link type
    # ------------------------------------------------------------------
    def test_ss_push(self):
        """SS: successor start must be >= source start."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        b = self._task("B", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 5, 9, 0))  # 4d, SS
        self._link(a, b, "SS")

        # Move A right; SS forces B.start to A.start (03-06), duration preserved.
        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 6, 9, 0),
            "date_end": datetime(2026, 3, 8, 9, 0),
        })

        self.assertEqual(b.date_start, datetime(2026, 3, 6, 9, 0))
        self.assertEqual(b.date_end, datetime(2026, 3, 10, 9, 0))

    # ------------------------------------------------------------------
    # write() path (e.g. list-view edit) shares the merged engine
    # ------------------------------------------------------------------
    def test_plain_write_cascades_via_merged_engine(self):
        """A plain write() that moves A onto its FS successor B must cascade B
        through the same merged engine (_cascade_dependency_push delegates)."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        b = self._task("B", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 6, 9, 0))
        self._link(a, b, "FS")

        a.write({
            "date_start": datetime(2026, 3, 8, 9, 0),
            "date_end": datetime(2026, 3, 10, 9, 0),
        })

        self.assertEqual(b.date_start, datetime(2026, 3, 10, 9, 0))
        self.assertEqual(b.date_end, datetime(2026, 3, 12, 9, 0))

    # ------------------------------------------------------------------
    # Single-pass / idempotency — guards the merge against re-introducing
    # extra cascade walks that would (have to) still converge
    # ------------------------------------------------------------------
    def test_cascade_settles_in_single_pass(self):
        """After one cascade the graph is fully settled: a second, no-op
        move_and_cascade reports no further task changes."""
        a = self._task("A", datetime(2026, 3, 1, 9, 0), datetime(2026, 3, 3, 9, 0))
        b = self._task("B", datetime(2026, 3, 4, 9, 0), datetime(2026, 3, 6, 9, 0))
        c = self._task("C", datetime(2026, 3, 7, 9, 0), datetime(2026, 3, 9, 9, 0))
        self._link(a, b, "FS")
        self._link(b, c, "FS")

        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 10, 9, 0),
            "date_end": datetime(2026, 3, 12, 9, 0),
        })
        b_start, b_end = b.date_start, b.date_end
        c_start, c_end = c.date_start, c.date_end

        # Re-apply A's CURRENT dates: no overlap is created, so the cascade must
        # produce no further successor movement (already at the fixpoint).
        diff = a.action_move_and_cascade(vals={
            "date_start": a.date_start,
            "date_end": a.date_end,
        })

        self.assertNotIn(b.id, diff["tasks"],
                         "B moved on a settled graph — cascade did not converge in one pass")
        self.assertNotIn(c.id, diff["tasks"],
                         "C moved on a settled graph — cascade did not converge in one pass")
        self.assertEqual((b.date_start, b.date_end), (b_start, b_end))
        self.assertEqual((c.date_start, c.date_end), (c_start, c_end))


@tagged("post_install", "-at_install")
class TestWorkHoursAreTheSchedule(TransactionCase):
    """The hours a user schedules ARE the schedule.

    Locks in the four rules the gantt must obey with a real work calendar:

    1. A leaf's ``plan_duration`` never changes because something upstream moved.
    2. A leaf never starts or ends outside working time.
    3. A summary task's bar spans exactly first-child-start → last-child-end.
    4. A summary task's hours are the sum of its LEAF descendants, counted once
       per leaf no matter how many outline levels sit in between.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.calendar = cls.env["resource.calendar"].create({
            "name": "Test 8h/day Mon-Fri",
            "tz": "UTC",
            "attendance_ids": [
                (0, 0, {
                    "name": "d%s-%s" % (d, p),
                    "dayofweek": str(d),
                    "hour_from": h_from,
                    "hour_to": h_to,
                    "day_period": p,
                })
                for d in range(5)
                for (p, h_from, h_to) in (
                    ("morning", 8.0, 12.0), ("afternoon", 13.0, 17.0))
            ],
        })
        cls.project = cls.env["project.project"].create({
            "name": "Work-hours Project",
            "use_calendar": True,
            "resource_calendar_id": cls.calendar.id,
            "tz": "UTC",
        })
        cls.Task = cls.env["project.task"]
        cls.Pred = cls.env["project.task.predecessor"]

    def _leaf(self, name, start, hours, parent=None):
        task = self.Task.create({
            "name": name,
            "project_id": self.project.id,
            "schedule_mode": "manual",
            "parent_id": parent.id if parent else False,
            "date_start": start,
            "plan_duration": hours,
        })
        # Derive the window through the calendar, the same way the gantt does.
        task.action_update_plan_duration(hours)
        return task

    def _parent(self, name, parent=None):
        return self.Task.create({
            "name": name,
            "project_id": self.project.id,
            "schedule_mode": "manual",
            "parent_id": parent.id if parent else False,
        })

    # 2026-03-02 is a Monday.
    MON = datetime(2026, 3, 2, 8, 0)

    def test_end_lands_inside_working_time(self):
        """4h from Monday 08:00 ends at 12:00 — never past close of business."""
        t = self._leaf("A", self.MON, 4.0)
        self.assertEqual(t.date_start, datetime(2026, 3, 2, 8, 0))
        self.assertEqual(t.date_end, datetime(2026, 3, 2, 12, 0))
        self.assertAlmostEqual(t.working_duration, 4.0, places=2)

    def test_hours_survive_being_pushed_over_a_weekend(self):
        """A pushed successor keeps its scheduled hours exactly; only its dates
        move, and they move to working time — this is the "工時亂跳" case."""
        a = self._leaf("A", self.MON, 4.0)
        b = self._leaf("B", self.MON, 4.0)
        self.Pred.create({
            "parent_task_id": a.id, "task_id": b.id,
            "type": "FS", "lag_hours": 0.0,
        })
        # Push A to Friday afternoon so B is forced across the weekend.
        a.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 6, 13, 0),
            "date_end": datetime(2026, 3, 6, 17, 0),
        })
        self.assertAlmostEqual(b.plan_duration, 4.0, places=2,
                               msg="scheduled hours changed because the task moved")
        # Friday 17:00 is outside working time → B starts Monday 08:00.
        self.assertEqual(b.date_start, datetime(2026, 3, 9, 8, 0))
        self.assertEqual(b.date_end, datetime(2026, 3, 9, 12, 0))
        self.assertAlmostEqual(b.working_duration, 4.0, places=2)

    def test_parent_span_covers_children(self):
        """The summary bar is first-child-start → last-child-end, exactly."""
        p = self._parent("P")
        c1 = self._leaf("C1", self.MON, 8.0, parent=p)
        c2 = self._leaf("C2", datetime(2026, 3, 4, 8, 0), 8.0, parent=p)
        self.assertEqual(p.date_start, min(c1.date_start, c2.date_start))
        self.assertEqual(p.date_end, max(c1.date_end, c2.date_end))
        self.assertEqual(p.summary_date_start, p.date_start)
        self.assertEqual(p.summary_date_end, p.date_end)

    def test_total_work_hours_sums_leaves_once(self):
        """Multi-level outline: every level reports the LEAF sum, never a
        double count of the intermediate level."""
        top = self._parent("TOP")
        mid = self._parent("MID", parent=top)
        self._leaf("L1", self.MON, 4.0, parent=mid)
        self._leaf("L2", datetime(2026, 3, 3, 8, 0), 6.0, parent=mid)
        other = self._leaf("L3", datetime(2026, 3, 4, 8, 0), 2.0, parent=top)

        self.assertAlmostEqual(mid.total_work_hours, 10.0, places=2)
        self.assertAlmostEqual(top.total_work_hours, 12.0, places=2)
        self.assertAlmostEqual(other.total_work_hours, 2.0, places=2,
                               msg="a leaf's total is its own scheduled hours")

    def test_parent_hours_are_read_only(self):
        """A summary task's hours are derived — editing them is refused."""
        from odoo.exceptions import UserError
        p = self._parent("P")
        self._leaf("C", self.MON, 4.0, parent=p)
        with self.assertRaises(UserError):
            p.action_update_plan_duration(99.0)

    def test_parent_plan_duration_not_overwritten_by_span(self):
        """Moving a child must not rewrite the parent's stored plan_duration
        (that is what made the summary number drift)."""
        p = self._parent("P")
        c = self._leaf("C", self.MON, 4.0, parent=p)
        before = p.plan_duration
        c.action_move_and_cascade(vals={
            "date_start": datetime(2026, 3, 4, 8, 0),
            "date_end": datetime(2026, 3, 4, 12, 0),
        })
        self.assertEqual(p.plan_duration, before)
        self.assertEqual(p.date_start, c.date_start)
        self.assertEqual(p.date_end, c.date_end)

    def test_compact_left_separates_a_collapsed_chain(self):
        """壓縮向左 places each FS successor AT its predecessor's end.

        Regression: the compaction step only ever pulled tasks LEFT, so a chain
        whose members had all been snapped onto the same working instant (e.g.
        several tasks sitting in the same Friday-evening / weekend gap) stayed
        collapsed on that one point and no amount of compacting separated it.
        """
        from odoo.exceptions import UserError  # noqa: F401 (import parity)
        a = self._leaf("A", self.MON, 4.0)
        b = self._leaf("B", self.MON, 4.0)
        c = self._leaf("C", self.MON, 4.0)
        for src, tgt in ((a, b), (b, c)):
            self.Pred.create({
                "parent_task_id": src.id, "task_id": tgt.id,
                "type": "FS", "lag_hours": 0.0,
            })
        # Force the collapsed state the bug produced: all three on one instant.
        for t in (a, b, c):
            t.with_context(skip_date_snap=True, skip_cascade_push=True).write({
                "date_start": self.MON,
                "date_end": datetime(2026, 3, 2, 12, 0),
            })

        self.env["project.task"].action_compact_left(self.project.id)

        # Monday 08:00-12:00 → 13:00-17:00 → Tuesday 08:00-12:00.
        self.assertEqual((a.date_start, a.date_end),
                         (datetime(2026, 3, 2, 8, 0), datetime(2026, 3, 2, 12, 0)))
        self.assertEqual((b.date_start, b.date_end),
                         (datetime(2026, 3, 2, 13, 0), datetime(2026, 3, 2, 17, 0)))
        self.assertEqual((c.date_start, c.date_end),
                         (datetime(2026, 3, 3, 8, 0), datetime(2026, 3, 3, 12, 0)))
        for t in (a, b, c):
            self.assertAlmostEqual(t.plan_duration, 4.0, places=2)
            self.assertAlmostEqual(t.working_duration, 4.0, places=2)
