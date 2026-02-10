# -*- coding: utf-8 -*-
from odoo import models
from datetime import timedelta
import pytz


class ProjectTaskNativeCalendar(models.Model):
    _inherit = 'project.task'

    @staticmethod
    def merge_range(ranges: list, start_key: str, end_key: str):
        """Merge overlapping ranges"""
        ranges = sorted(ranges, key=lambda x: x[start_key])

        if ranges:
            saved = dict(ranges[0])

            for range_set in sorted(ranges, key=lambda x: x[start_key]):
                if range_set[start_key] <= saved[end_key]:
                    saved[end_key] = max(saved[end_key], range_set[end_key])
                else:
                    yield dict(saved)
                    saved[start_key] = range_set[start_key]
                    saved[end_key] = range_set[end_key]

            yield dict(saved)
        else:
            return ()

    def get_sec(self, from_time):
        h = from_time.hour
        m = from_time.minute
        s = from_time.second
        return int(h) * 3600 + int(m) * 60 + int(s)

    def to_tz(self, dt, tz_name):
        tz = pytz.timezone(tz_name)
        return pytz.UTC.localize(dt.replace(tzinfo=None), is_dst=False).astimezone(tz).replace(tzinfo=None)

    def to_naive_user_tz(self, dt, tz_name):
        tz = tz_name and pytz.timezone(tz_name) or pytz.UTC
        return pytz.UTC.localize(dt.replace(tzinfo=None), is_dst=False).astimezone(tz).replace(tzinfo=None)

    def to_naive_utc(self, dt, tz_name):
        tz = tz_name and pytz.timezone(tz_name) or pytz.UTC
        return tz.localize(dt.replace(tzinfo=None), is_dst=False).astimezone(pytz.UTC).replace(tzinfo=None)

    def _get_date_from_level(self, levels, value=None, type_op=None):
        """
        :param levels: list of calendar level with leaves and attendance
        :param value: get to_Datetime or from_Datetime
        :param type_op: what return max,min or list
        :return:
        """
        obj_list = []
        for level in levels:
            if level["type"] == "attendance":
                obj_list.append(level[value])

        if type_op == "max" and obj_list:
            return max(obj_list)
        elif type_op == "min" and obj_list:
            return min(obj_list)
        elif type_op == "list" and obj_list:
            return obj_list
        else:
            return False

    def _get_calendar_level(self, task_obj, date_in, duration, t_params, direction="normal"):
        """
        :param task: Task obj
        :param date_in: datetime start date or end date
        :param duration: duration in seconds
        :param direction: normal or revers mode: from start date or end date
        :return: list of calendar levels
        """
        if task_obj["project_id"] and task_obj["project_id"].use_calendar or task_obj["task_resource_ids"].ids:
            diff = timedelta(seconds=duration)
            tz_name = task_obj["project_id"].tz

            if tz_name and date_in:
                date_in = self.to_tz(date_in, tz_name)

            if date_in:
                return self._get_planned_x(
                    t_params=t_params,
                    x_date=date_in,
                    diff=diff,
                    level=[],
                    tz_name=tz_name,
                    iteration=0,
                    task=task_obj,
                    direct=direction
                )
            return False
        else:
            return False

    def _get_planned_x(self, t_params, x_date, diff, level=None, tz_name=None, iteration=None, task=None, direct=None):
        """Calculate planned intervals based on calendar and resource availability"""
        level = level or []  # Initialize empty list if None
        attendance_ids_param = t_params["attendance_ids"]
        global_leave_ids_param = t_params["leave_ids"]
        task_res = task["task_res"]
        fixed_calc_type = task["fixed_calc_type"]

        _calendar_ids, diff_e_counter = self._get_diff_e_counter(task_res, fixed_calc_type, diff)
        attendance_ids = list(filter(lambda x: x["calendar_id"] in _calendar_ids, attendance_ids_param))

        x_date_e = x_date
        next_step = True

        while next_step:
            if not attendance_ids:
                return level

            weekday = x_date_e.weekday()
            attendances = self._attendance_from_list(attendance_ids, weekday, x_date_e.date())

            next_step_allow = []
            len_attendances = len(attendances)
            work_already_day = {}

            work_time_day = self._get_work_time_day(attendances, task_res)

            for inx, attendance in enumerate(attendances):
                hour_from_att = timedelta(hours=float(attendance["hour_from"]))
                hour_to_att = timedelta(hours=float(attendance["hour_to"]))

                for _res in task_res:
                    _load_factor = _res["load_factor"]
                    _calendar_id = _res["calendar_id"]
                    _resource_id = _res["resource_id"]
                    _load_control = _res["load_control"]

                    diff_e = diff_e_counter[_resource_id]

                    if attendance["calendar_id"] == _calendar_id and diff_e > timedelta(hours=0):
                        flag_task = "{}_{}".format(task["id"], task["name"])
                        flag_project = None
                        if task["project_id"] and _load_control == "in_project":
                            proj = task["project_id"]
                            flag_project = "{}_{}".format(proj.id, proj.name)

                        work_time, work_time_already = self._get_work_intervals(
                            _resource_id, work_already_day, work_time_day, _load_factor
                        )

                        hour_from, hour_to = self.check_load_factor(
                            _load_factor, hour_to_att, hour_from_att, len_attendances, inx, work_time, work_time_already
                        )

                        hour_from_date = x_date_e.replace(hour=0, minute=0, second=0, microsecond=0) + hour_from
                        hour_to_date = x_date_e.replace(hour=0, minute=0, second=0, microsecond=0) + hour_to

                        global_leave_ids = self.check_load_control(
                            _load_control, _calendar_id, _resource_id,
                            global_leave_ids_param, direct, flag_task, flag_project
                        )

                        global_leave_merge = list(self.merge_range(
                            ranges=global_leave_ids, start_key='date_from', end_key='date_to'
                        ))

                        global_leave, cut_hour = self._check_leave(
                            global_leave_merge, dt_work_from=hour_from_date, dt_work_to=hour_to_date, tz_name=tz_name
                        )

                        if cut_hour:
                            hour_from_date = cut_hour["from"]
                            hour_to_date = cut_hour["to"]
                            hour_from = timedelta(seconds=self.get_sec(hour_from_date.time()))
                            hour_to = timedelta(seconds=self.get_sec(hour_to_date.time()))

                        if not global_leave:
                            date_from, date_to, diff_e = self._calc_from_to(
                                x_date_e, tz_name, hour_from_date, hour_to_date, hour_from, hour_to, direct, diff_e
                            )

                            if date_to and date_from:
                                if _resource_id in work_already_day:
                                    work_already_day[_resource_id] = work_already_day[_resource_id] + (date_to - date_from)
                                else:
                                    work_already_day[_resource_id] = (date_to - date_from)

                                diff_e_counter[_resource_id] = diff_e

                                level, global_leave_ids_param = self._push_interval_log(
                                    level, global_leave_ids_param, attendance, date_from, date_to,
                                    iteration, _resource_id, _calendar_id, flag_task, flag_project, _load_control, direct=direct
                                )

            for _res in task_res:
                _resource_id = _res["resource_id"]
                res_diff = diff_e_counter[_resource_id]
                if res_diff > timedelta(hours=0):
                    next_step_allow.append(True)

            date_next = self._get_planned_interval_next_date(day_before=x_date_e, direct=direct)
            next_step = False

            if next_step_allow and all(next_step_allow) and date_next:
                iteration += 1
                next_step = True
                x_date_e = date_next

        return level

    def _check_leave(self, global_leave_ids, dt_work_from, dt_work_to, tz_name):
        """Check if work period falls within leave period"""
        if tz_name:
            for global_leave_id in global_leave_ids:
                dt_leave_from = global_leave_id["date_from"]
                dt_leave_to = global_leave_id["date_to"]

                dt_leave_from = self.to_tz(dt_leave_from, tz_name)
                dt_leave_to = self.to_tz(dt_leave_to, tz_name)

                global_leave = not dt_leave_from > dt_work_from and not dt_leave_to < dt_work_to

                if not global_leave:
                    new_dt_work_from = dt_work_from
                    if dt_leave_from <= dt_work_from and dt_leave_to.date() == dt_work_from.date():
                        td_from = dt_leave_to - dt_work_from
                        if td_from.days == 0:
                            new_dt_work_from = dt_work_from + td_from

                    new_dt_work_to = dt_work_to
                    if dt_leave_to >= dt_work_to and dt_leave_from.date() == dt_work_to.date():
                        td_to = dt_work_to - dt_leave_from
                        if td_to.days == 0:
                            new_dt_work_to = dt_work_to - td_to

                    if new_dt_work_from != dt_work_from or new_dt_work_to != dt_work_to:
                        return False, {
                            "name": global_leave_id["name"],
                            "from": new_dt_work_from,
                            "to": new_dt_work_to
                        }
                else:
                    return True, False

        return False, False

    def _attendance_from_list(self, els, wkd, start_date):
        _list = []

        for x in els:
            _ok = False

            if x['dayofweek'] == str(wkd):
                _ok = True

                if x['date_from'] and x['date_to']:
                    _ok = False
                    if x['date_from'] <= start_date and x['date_to'] >= start_date:
                        _ok = True

            if _ok:
                _list.append(x)

        _list = sorted(_list, key=lambda k: k['hour_from'])
        return _list

    def _push_interval_log(self, level, global_leave_ids_param, attendance, date_from, date_to, iteration,
                           res_id, cal_id, flag_task, flag_project, _load_control, direct="normal"):
        level.append({
            "name": attendance["display_name"],
            "type": "attendance",
            "date_from": date_from,
            "date_to": date_to,
            "interval": (date_to - date_from),
            "iteration": iteration,
            "res_ids": res_id
        })

        if res_id != -1 and _load_control in ["in_project", "everywhere"]:
            load = {
                "leave_id": "l{}r{}".format(cal_id, res_id),
                "calendar_id": cal_id,
                "name": direct,
                "resource_id": str(res_id),
                "date_from": date_from,
                "date_to": date_to,
                "flag_task": flag_task,
                "flag_project": flag_project
            }
            global_leave_ids_param.append(load)

        return level, global_leave_ids_param

    def check_load_factor(self, _load_factor, hour_to, hour_from, len_attendances, inx, work_time, work_time_already):
        interval_next = hour_to - hour_from
        time_already_next = work_time_already + interval_next

        if _load_factor < 1 and time_already_next > work_time:
            interval_next = work_time - work_time_already

        if _load_factor > 1 and inx == len_attendances - 1 and work_time > time_already_next:
            interval_next = work_time - work_time_already

        hour_to = hour_from + interval_next

        if hour_to > timedelta(hours=24):
            hour_to = timedelta(hours=24)

        return hour_from, hour_to

    def check_load_control(self, _load_control, _calendar_id, _resource_id, global_leave_ids_param, direct,
                           flag_task, flag_project):
        if direct == "normal":
            direct = "revers"
        elif direct == "revers":
            direct = "normal"

        global_leave_ids = list(filter(lambda x: x["calendar_id"] == _calendar_id, global_leave_ids_param))
        global_leave_ids = list(filter(lambda x: x["name"] != direct, global_leave_ids))
        global_leave_ids = list(filter(lambda x: x["flag_task"] != flag_task, global_leave_ids))

        if _load_control == "in_project":
            global_leave_ids = list(filter(
                lambda x: x["flag_project"] == flag_project and x["resource_id"] == str(_resource_id) or x["resource_id"] == "-1",
                global_leave_ids
            ))
        elif _load_control == "everywhere":
            global_leave_ids = list(filter(lambda x: x["resource_id"] in [str(_resource_id), _resource_id, "-1"], global_leave_ids))
        else:
            global_leave_ids = list(filter(lambda x: x["resource_id"] in [_resource_id, "-1"], global_leave_ids))

        return global_leave_ids

    def _calc_from_to(self, x_date_e, tz_name, hour_from_date, hour_to_date, hour_from, hour_to, direct, diff_e):
        date_to = False
        date_from = False

        if direct == "normal":
            summ_hours = timedelta(hours=0)
            if x_date_e <= hour_from_date:
                date_from = hour_from_date
                summ_hours = hour_to - hour_from
            elif hour_from_date <= x_date_e < hour_to_date:
                date_from = x_date_e
                summ_hours = hour_to_date - date_from

            if diff_e <= summ_hours:
                summ_hours = diff_e

            if date_from and summ_hours > timedelta(hours=0):
                diff_e = diff_e - summ_hours
                date_to = date_from + summ_hours

            if date_from and date_to:
                date_from = self.to_naive_utc(date_from, tz_name)
                date_to = self.to_naive_utc(date_to, tz_name)

        if direct == "revers":
            summ_hours = timedelta(hours=0)
            if x_date_e >= hour_to_date:
                date_to = hour_to_date
                summ_hours = hour_to - hour_from
            elif hour_from_date < x_date_e <= hour_to_date:
                date_to = x_date_e
                summ_hours = date_to - hour_from_date

            if diff_e <= summ_hours:
                summ_hours = diff_e

            if date_to and summ_hours > timedelta(hours=0):
                diff_e = diff_e - summ_hours
                date_from = hour_from_date
                date_to = hour_from_date + summ_hours

            if date_from and date_to:
                date_from = self.to_naive_utc(date_from, tz_name)
                date_to = self.to_naive_utc(date_to, tz_name)

        return date_from, date_to, diff_e

    def _get_work_time_day(self, attendances, task_res):
        work_time = {}

        for attendance in attendances:
            for _res in task_res:
                _calendar_id = _res["calendar_id"]
                _resource_id = _res["resource_id"]

                if attendance["calendar_id"] == _calendar_id:
                    hour_from_att = timedelta(hours=float(attendance["hour_from"]))
                    hour_to_att = timedelta(hours=float(attendance["hour_to"]))

                    working_time_res_id = timedelta(hours=0)
                    if _resource_id in work_time:
                        working_time_res_id = work_time[_resource_id]

                    work_time[_resource_id] = working_time_res_id + (hour_to_att - hour_from_att)

        return work_time

    def _get_diff_e_counter(self, task_res, fixed_calc_type, diff):
        diff_e_counter = {}
        _calendar_ids = []

        for _res in task_res:
            _calendar_ids.append(_res["calendar_id"])
            _load_factor = _res["load_factor"]
            _resource_id = _res["resource_id"]
            diff_k = diff

            if fixed_calc_type == "duration":
                diff_e_counter[_resource_id] = diff_k * _load_factor
            if fixed_calc_type == "work":
                diff_k = diff / len(task_res)
                diff_e_counter[_resource_id] = diff_k

        return _calendar_ids, diff_e_counter

    def _get_work_intervals(self, _resource_id, work_already_day, work_time_day, _load_factor):
        work_time_already = timedelta(hours=0)
        if _resource_id in work_already_day:
            work_time_already = work_already_day[_resource_id]

        work_time = work_time_day[_resource_id] * _load_factor
        return work_time, work_time_already

    def _get_planned_interval_next_date(self, day_before, direct="normal"):
        if direct == "normal":
            start_date = (day_before + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            return start_date

        if direct == "revers":
            end_date = (day_before - timedelta(days=1)).replace(hour=23, minute=59, second=59, microsecond=0)
            return end_date
