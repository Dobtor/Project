# -*- coding: utf-8 -*-
"""Scheduler, write() snapping/constraints, planning mode, permissions, violations.

Complements ``test_cascade.py`` (which covers the cascade engine itself). Calendar:
Mon-Fri 08-12 / 13-17 UTC, project tz UTC, so every expected instant below is plain
UTC wall-clock.
"""

from datetime import datetime

from odoo.exceptions import AccessError, UserError
from odoo.tests.common import TransactionCase, new_test_user, tagged


def d(day, hour=8, month=11):
    return datetime(2026, month, day, hour, 0)


class SchedulingCase(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.calendar = env["resource.calendar"].create({
            "name": "Sched 8-12/13-17", "tz": "UTC",
            "attendance_ids": [
                (0, 0, {"name": "x", "dayofweek": str(day), "hour_from": a, "hour_to": b})
                for day in range(5) for a, b in ((8, 12), (13, 17))],
        })
        cls.project = cls._project("Sched Project")
        cls.Task = env["project.task"]
        cls.Pred = env["project.task.predecessor"]

    @classmethod
    def _project(cls, name, **extra):
        vals = {"name": name, "use_calendar": True, "tz": "UTC",
                "resource_calendar_id": cls.calendar.id, "scheduling_type": "forward",
                "schedule_start": d(2, 0)}
        vals.update(extra)
        return cls.env["project.project"].create(vals)

    def _task(self, name, start=None, end=None, hours=8.0, project=None, **extra):
        vals = {"name": name, "project_id": (project or self.project).id,
                "schedule_mode": "auto", "plan_duration": hours,
                "date_start": start or False, "date_end": end or False}
        vals.update(extra)
        return self.Task.create(vals)

    def _link(self, src, tgt, kind="FS"):
        return self.Pred.create({"parent_task_id": src.id, "task_id": tgt.id, "type": kind})


@tagged("post_install", "-at_install")
class TestSchedulerPlan(SchedulingCase):

    def test_forward_plan_chains_tasks_through_work_time(self):
        a = self._task("A", d(2), d(2, 17))
        b = self._task("B", d(2), d(2, 17))
        c = self._task("C", d(2), d(2, 17))
        self._link(a, b)
        self._link(b, c)
        self.Task.scheduler_plan(self.project.id)
        self.assertEqual(a.date_start, d(2))
        self.assertEqual((b.date_start, b.date_end), (d(3), d(3, 17)))
        self.assertEqual((c.date_start, c.date_end), (d(4), d(4, 17)))
        # every task ends inside working time and keeps its 8 planned hours
        for t in (a, b, c):
            self.assertEqual(t.working_duration, 8.0)

    def test_plan_skips_the_weekend(self):
        # the forward plan restarts from the project's schedule_start (Mon 11-02):
        # the 5th task is Friday, the 6th lands on the next Monday.
        tasks = [self._task("T%s" % i, d(2), d(2, 17)) for i in range(6)]
        for src, tgt in zip(tasks, tasks[1:]):
            self._link(src, tgt)
        self.Task.scheduler_plan(self.project.id)
        self.assertEqual(tasks[4].date_start, d(6))
        self.assertEqual(tasks[5].date_start, d(9))

    def test_plan_writes_project_schedule_end(self):
        a = self._task("A", d(2), d(2, 17))
        b = self._task("B", d(2), d(2, 17))
        self._link(a, b)
        self.Task.scheduler_plan(self.project.id)
        self.assertEqual(self.project.schedule_end, b.date_end)

    def test_plan_clears_plan_action(self):
        a = self._task("A", d(2), d(2, 17))
        self.assertTrue(a.plan_action)
        self.Task.scheduler_plan(self.project.id)
        self.assertFalse(a.plan_action)

    def test_manual_project_refuses_to_plan(self):
        project = self._project("Manual", scheduling_type="manual")
        self._task("A", d(2), d(2, 17), project=project)
        with self.assertRaises(UserError):
            self.Task.scheduler_plan(project.id)

    def test_unknown_project_is_a_user_error(self):
        with self.assertRaises(UserError):
            self.Task.scheduler_plan(10 ** 8)

    def test_plan_is_gated_on_task_write_access(self):
        self._task("A", d(2), d(2, 17))
        manager = new_test_user(self.env, login="sched_manager",
                                groups="base.group_user,project.group_project_manager")
        self.Task.with_user(manager).scheduler_plan(self.project.id)
        # a plain internal user (no project group) may not write tasks
        plain = new_test_user(self.env, login="sched_plain", groups="base.group_user")
        with self.assertRaises(AccessError):
            self.Task.with_user(plain).scheduler_plan(self.project.id)

    def test_plan_only_touches_tasks_the_user_can_see(self):
        followers = self._project("Followers only", privacy_visibility="followers")
        hidden = self._task("Hidden", d(2), d(2, 17), project=followers)
        user = new_test_user(self.env, login="sched_user",
                             groups="base.group_user,project.group_project_user")
        visible = self.Task.with_user(user).search([("project_id", "=", followers.id)])
        self.assertFalse(visible)
        # the engine's search honours record rules, so the hidden task is not in scope
        before = hidden.date_start
        try:
            self.Task.with_user(user).scheduler_plan(followers.id)
        except (AccessError, UserError):
            pass
        self.assertEqual(hidden.date_start, before)


@tagged("post_install", "-at_install")
class TestWriteSnapAndConstraints(SchedulingCase):

    def test_single_edge_write_snaps_into_work_time(self):
        t = self._task("T", d(2), d(2, 17))
        t.write({"date_start": d(3, 12) .replace(minute=30)})      # lunch break
        self.assertEqual(t.date_start, d(3, 13))                    # forward to 13:00
        t.write({"date_end": d(4, 12).replace(minute=30)})
        self.assertEqual(t.date_end, d(4, 12))                      # backward to 12:00

    def test_start_in_the_evening_snaps_to_next_morning(self):
        t = self._task("T", d(2), d(2, 17))
        t.write({"date_start": d(3, 19)})
        self.assertEqual(t.date_start, d(4))

    def test_both_edges_in_one_write_are_a_drag_and_do_not_snap(self):
        t = self._task("T", d(2), d(2, 17))
        t.write({"date_start": d(3, 6), "date_end": d(3, 20)})
        self.assertEqual((t.date_start, t.date_end), (d(3, 6), d(3, 20)))

    def test_skip_date_snap_context_disables_snapping(self):
        t = self._task("T", d(2), d(2, 17))
        t.with_context(skip_date_snap=True).write({"date_start": d(7, 10)})   # Saturday
        self.assertEqual(t.date_start, d(7, 10))

    def test_no_calendar_means_no_snapping(self):
        project = self._project("No calendar", use_calendar=False)
        t = self._task("T", d(2), d(2, 17), project=project)
        t.write({"date_start": d(7, 10)})
        self.assertEqual(t.date_start, d(7, 10))

    def test_snet_pushes_an_early_task(self):
        t = self._task("T", d(2), d(2, 17))
        t.write({"constrain_type": "snet", "constrain_date": d(5)})
        self.assertEqual((t.date_start, t.date_end), (d(5), d(5, 17)))

    def test_snet_leaves_a_late_task_alone(self):
        t = self._task("T", d(9), d(9, 17))
        t.write({"constrain_type": "snet", "constrain_date": d(5)})
        self.assertEqual(t.date_start, d(9))

    def test_mso_moves_to_the_exact_start(self):
        t = self._task("T", d(2), d(2, 17))
        t.write({"constrain_type": "mso", "constrain_date": d(4)})
        self.assertEqual(t.date_start, d(4))

    def test_fnlt_pulls_a_late_task_back(self):
        t = self._task("T", d(9), d(9, 17))
        t.write({"constrain_type": "fnlt", "constrain_date": d(5, 17)})
        self.assertEqual(t.date_end, d(5, 17))
        self.assertEqual(t.working_duration, 8.0)

    def test_constraint_date_is_snapped_to_work_time(self):
        t = self._task("T", d(2), d(2, 17))
        t.write({"constrain_type": "snet", "constrain_date": d(7, 10)})   # Saturday 10:00
        self.assertEqual(t.constrain_date, d(9))                          # next Monday 08:00

    def test_multi_record_constraint_write_is_resolved_per_task(self):
        a = self._task("A", d(2), d(2, 17))
        b = self._task("B", d(9), d(9, 17))
        (a | b).write({"constrain_type": "snet", "constrain_date": d(5)})
        self.assertEqual(a.date_start, d(5))        # pushed
        self.assertEqual(b.date_start, d(9))        # untouched, not dragged to A's window

    def test_write_extends_the_parent_summary(self):
        parent = self._task("P", d(2), d(2, 17))
        child = self._task("C", d(2), d(2, 17), parent_id=parent.id)
        child.write({"date_start": d(4), "date_end": d(4, 17)})
        self.assertEqual((parent.date_start, parent.date_end), (d(4), d(4, 17)))

    def test_parent_with_children_cannot_be_deleted(self):
        parent = self._task("P", d(2), d(2, 17))
        self._task("C", d(2), d(2, 17), parent_id=parent.id)
        with self.assertRaises(UserError):
            parent.unlink()


@tagged("post_install", "-at_install")
class TestPlanningMode(SchedulingCase):
    """No dates, only ``plan_offset`` (hours from T+0)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.plan_project = cls._project("Planning", use_calendar=False, schedule_start=False)

    def _p(self, name, offset, hours=8.0):
        return self._task(name, project=self.plan_project, hours=hours,
                          schedule_mode="manual", plan_offset=offset)

    def test_planning_tasks_have_no_dates(self):
        t = self._p("A", 0)
        self.assertFalse(t.date_start)
        self.assertFalse(t.date_end)

    def test_offset_move_pushes_successor_offset(self):
        a, b = self._p("A", 0), self._p("B", 8)
        self._link(a, b)
        diff = a.action_move_and_cascade(vals={"plan_offset": 24.0})
        self.assertEqual(b.plan_offset, 32.0)
        self.assertEqual(diff["tasks"][b.id]["plan_offset"], 32.0)
        self.assertNotIn("date_start", diff["tasks"][b.id])

    def test_no_push_when_there_is_room(self):
        a, b = self._p("A", 0), self._p("B", 100)
        self._link(a, b)
        a.action_move_and_cascade(vals={"plan_offset": 24.0})
        self.assertEqual(b.plan_offset, 100.0)

    def test_shift_hours_moves_a_summary_and_its_children(self):
        parent = self._p("P", 0)
        c1 = self._task("c1", project=self.plan_project, hours=8, schedule_mode="manual",
                        plan_offset=0, parent_id=parent.id)
        parent.action_move_and_cascade(shift_hours=16.0)
        self.assertEqual(c1.plan_offset, 16.0)

    def test_ff_link_pushes_the_end_in_planning_mode(self):
        a, b = self._p("A", 0, hours=16), self._p("B", 0, hours=8)
        self._link(a, b, "FF")
        a.action_move_and_cascade(vals={"plan_offset": 8.0})        # A now ends at 24
        self.assertEqual(b.plan_offset, 16.0)                        # B must end at 24

    def test_lag_is_recalculated(self):
        a, b = self._p("A", 0), self._p("B", 100)
        pred = self._link(a, b)
        diff = a.action_move_and_cascade(vals={"plan_offset": 24.0})
        # B is not pushed (room to spare); the lag is the new gap: B.start 100 - A.end 32
        self.assertEqual(pred.lag_hours, 68.0)
        self.assertEqual(diff["predecessors"][pred.id], {"lag_hours": 68.0})


@tagged("post_install", "-at_install")
class TestGesturePermissions(SchedulingCase):

    def test_gesture_requires_write_access_on_the_moved_task(self):
        t = self._task("T", d(2), d(2, 17), schedule_mode="manual")
        plain = new_test_user(self.env, login="gest_plain", groups="base.group_user")
        with self.assertRaises(AccessError):
            t.with_user(plain).action_move_and_cascade(
                vals={"date_start": d(3), "date_end": d(3, 17)})

    def test_gesture_field_whitelist(self):
        t = self._task("T", d(2), d(2, 17), schedule_mode="manual")
        with self.assertRaises(UserError):
            t.action_move_and_cascade(vals={"name": "hacked"})
        with self.assertRaises(UserError):
            t.action_move_and_cascade(vals={"user_ids": [(6, 0, [])]})

    def test_cascading_into_a_task_the_user_cannot_see_fails_without_side_effects(self):
        followers = self._project("Followers only", privacy_visibility="followers")
        a = self._task("A", d(2), d(2, 17), schedule_mode="manual")
        z = self._task("Z", d(3), d(3, 17), project=followers, schedule_mode="manual")
        self._link(a, z)
        user = new_test_user(self.env, login="gest_user",
                             groups="base.group_user,project.group_project_user")
        before = (a.date_start, z.date_start)
        with self.assertRaises(AccessError):
            with self.env.cr.savepoint():
                a.with_user(user).action_move_and_cascade(
                    vals={"date_start": d(9), "date_end": d(9, 17)})
        self.assertEqual((a.date_start, z.date_start), before)

    def test_align_dependencies_repairs_a_violation(self):
        a = self._task("A", d(3), d(3, 17), schedule_mode="manual")
        b = self._task("B", d(2), d(2, 17), schedule_mode="manual")
        self._link(a, b)                    # B starts before A ends: violated
        diff = self.Task.action_align_dependencies(self.project.id)
        self.assertEqual(b.date_start, d(4))
        self.assertIn(b.id, diff["tasks"])


@tagged("post_install", "-at_install")
class TestViolations(SchedulingCase):

    def kinds(self, project=None):
        return sorted({v["type"] for v in (project or self.project).check_violations()})

    def test_clean_project_has_no_error_or_warning(self):
        a = self._task("A", d(2), d(2, 17), schedule_mode="manual")
        b = self._task("B", d(3), d(3, 17), schedule_mode="manual")
        self._link(a, b)
        self.assertEqual([v for v in self.project.check_violations()
                          if v["severity"] != "info"], [])

    def test_overdue_deadline(self):
        self._task("A", d(2), d(2, 17), schedule_mode="manual", date_deadline="2026-11-02").write(
            {"date_end": d(3, 17), "date_start": d(3)})
        self.assertIn("overdue", self.kinds())

    def test_constraint_conflict(self):
        t = self._task("A", d(5), d(5, 17), schedule_mode="manual")
        t.with_context(skip_date_snap=True).write({"constrain_type": "snlt", "constrain_date": d(3)})
        self.assertIn("constraint", self.kinds())

    def test_mso_has_a_60_second_tolerance(self):
        t = self._task("A", d(5), d(5, 17), schedule_mode="manual")
        t.with_context(skip_date_snap=True).write({
            "constrain_type": "mso", "constrain_date": d(5).replace(second=30)})
        self.assertNotIn("constraint", self.kinds())

    def test_unlinked_auto_task_is_info(self):
        self._task("A", d(2), d(2, 17), schedule_mode="auto")
        found = [v for v in self.project.check_violations() if v["type"] == "unlinked"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["severity"], "info")

    def test_resource_overload(self):
        res = self.env["resource.resource"].create({"name": "R", "max_capacity": 1.0})
        a = self._task("A", d(2), d(2, 17), schedule_mode="manual")
        b = self._task("B", d(2), d(2, 17), schedule_mode="manual")
        self.env["project.task.resource.link"].create(
            [{"task_id": t.id, "resource_id": res.id, "load_factor": 1.0} for t in (a, b)])
        self.assertIn("resource_overload", self.kinds())

    def test_half_loads_are_legal(self):
        res = self.env["resource.resource"].create({"name": "R2", "max_capacity": 1.0})
        a = self._task("A", d(2), d(2, 17), schedule_mode="manual")
        b = self._task("B", d(2), d(2, 17), schedule_mode="manual")
        self.env["project.task.resource.link"].create(
            [{"task_id": t.id, "resource_id": res.id, "load_factor": 0.5} for t in (a, b)])
        self.assertNotIn("resource_overload", self.kinds())

    def test_back_to_back_is_not_an_overload(self):
        res = self.env["resource.resource"].create({"name": "R3", "max_capacity": 1.0})
        a = self._task("A", d(2), d(2, 17), schedule_mode="manual")
        b = self._task("B", d(2, 17), d(3, 17), schedule_mode="manual")
        self.env["project.task.resource.link"].create(
            [{"task_id": t.id, "resource_id": res.id, "load_factor": 1.0} for t in (a, b)])
        self.assertNotIn("resource_overload", self.kinds())

    def test_circular_dependency_is_rejected_at_link_time(self):
        a = self._task("A", d(2), d(2, 17), schedule_mode="manual")
        b = self._task("B", d(3), d(3, 17), schedule_mode="manual")
        self._link(a, b)
        from odoo.exceptions import ValidationError
        with self.assertRaises(ValidationError):
            with self.env.cr.savepoint():
                self._link(b, a)
