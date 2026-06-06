# -*- coding: utf-8 -*-
"""Cost tracking and Earned Value Management (EVM) for the native Gantt.

Adds OmniPlan-style cost and earned-value analysis on top of the scheduling
engine:

* resource hourly cost rate (see resource_resource.py)
* per-task planned/actual cost, planned value (PV/BCWS), earned value
  (EV/BCWP), cost & schedule variance and the CPI/SPI performance indices
* project-level rollups of all of the above
* baseline variance (current vs snapshot)

EV definitions used here (status date = project.status_date or "now"):
    hourly_rate   = Σ links (load_factor × resource.cost_rate→company currency)
    planned_cost  = allocated_hours × hourly_rate            (BAC)
    actual_cost   = effective_hours × hourly_rate            (AC / ACWP)
    earned_value  = planned_cost × (progress / 100)          (EV / BCWP)
    planned_value = planned_cost × scheduled_fraction(status) (PV / BCWS)
    cost_variance     = EV − AC
    schedule_variance = EV − PV
    cpi = EV / AC   (0 when AC = 0)
    spi = EV / PV   (0 when PV = 0)

PV (and therefore SV/SPI) is schedule-based and only meaningful once tasks have
real start/end dates; in pure planning mode (virtual timeline only) PV is 0 by
design — see _scheduled_fraction.

All cost/earned-value figures are sensitive, so every monetary/index field is
restricted to the dedicated cost group (COST_GROUP).
"""

from odoo import models, fields, api

# Group allowed to see cost & earned-value figures (defined in security XML).
COST_GROUP = 'dobtor_project.group_project_cost_manager'


class ProjectTaskCost(models.Model):
    _inherit = 'project.task'

    currency_id = fields.Many2one(
        'res.currency',
        string='幣別',
        related='company_id.currency_id',
        readonly=True,
    )
    cost_hourly_rate = fields.Monetary(
        string='每小時成本',
        compute='_compute_cost_hourly_rate',
        currency_field='currency_id',
        store=True,
        groups=COST_GROUP,
        help='本任務所有指派資源的（負載率×每小時成本）總和，已換算為公司幣別。',
    )
    planned_cost = fields.Monetary(
        string='預算成本 (BAC)',
        compute='_compute_cost_values',
        currency_field='currency_id',
        store=True,
        groups=COST_GROUP,
        help='計畫工時 × 每小時成本。',
    )
    actual_cost = fields.Monetary(
        string='實際成本 (AC)',
        compute='_compute_cost_values',
        currency_field='currency_id',
        store=True,
        groups=COST_GROUP,
        help='已登錄工時 × 每小時成本。',
    )
    earned_value = fields.Monetary(
        string='賺得值 (EV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        groups=COST_GROUP,
        help='預算成本 × 完成百分比。',
    )
    planned_value = fields.Monetary(
        string='計畫值 (PV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        groups=COST_GROUP,
        help='依狀態日的排程進度應完成的預算成本（需有真實排程日期）。',
    )
    cost_variance = fields.Monetary(
        string='成本差異 (CV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        groups=COST_GROUP,
        help='EV − AC，負值代表超出預算。',
    )
    schedule_variance = fields.Monetary(
        string='進度差異 (SV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        groups=COST_GROUP,
        help='EV − PV，負值代表落後進度。',
    )
    cpi = fields.Float(
        string='成本績效 (CPI)',
        compute='_compute_ev_values',
        store=True,
        digits=(12, 2),
        groups=COST_GROUP,
        help='EV / AC，<1 代表超出預算。',
    )
    spi = fields.Float(
        string='進度績效 (SPI)',
        compute='_compute_ev_values',
        store=True,
        digits=(12, 2),
        groups=COST_GROUP,
        help='EV / PV，<1 代表落後進度。',
    )

    def _resource_rate_in_company_currency(self, link):
        """A resource link's cost_rate converted to the task's company currency."""
        rate = link.resource_id.cost_rate or 0.0
        if not rate:
            return 0.0
        res_cur = link.resource_id.cost_currency_id
        company = self.company_id or self.env.company
        comp_cur = company.currency_id
        if res_cur and comp_cur and res_cur != comp_cur:
            rate = res_cur._convert(
                rate, comp_cur, company, fields.Date.context_today(self))
        return rate

    @api.depends(
        'task_resource_ids.load_factor',
        'task_resource_ids.resource_id.cost_rate',
        'task_resource_ids.resource_id.cost_currency_id',
        'company_id',
    )
    def _compute_cost_hourly_rate(self):
        # Separate compute so that changing allocated/effective hours does not
        # re-run the (heavier) per-resource rate summation, and vice-versa.
        for task in self:
            task.cost_hourly_rate = sum(
                (link.load_factor or 0.0) * task._resource_rate_in_company_currency(link)
                for link in task.task_resource_ids
            )

    @api.depends('cost_hourly_rate', 'allocated_hours', 'effective_hours')
    def _compute_cost_values(self):
        for task in self:
            rate = task.cost_hourly_rate or 0.0
            task.planned_cost = (task.allocated_hours or 0.0) * rate
            task.actual_cost = (task.effective_hours or 0.0) * rate

    @api.depends(
        'planned_cost', 'actual_cost', 'progress',
        'date_start', 'date_end', 'project_id.status_date',
    )
    def _compute_ev_values(self):
        for task in self:
            planned = task.planned_cost or 0.0
            ev = planned * (task.progress or 0.0) / 100.0
            pv = planned * task._scheduled_fraction()
            ac = task.actual_cost or 0.0
            task.earned_value = ev
            task.planned_value = pv
            task.cost_variance = ev - ac
            task.schedule_variance = ev - pv
            task.cpi = (ev / ac) if ac else 0.0
            task.spi = (ev / pv) if pv else 0.0

    def _scheduled_fraction(self):
        """Fraction of the task that *should* be done by the status date (0..1).

        Schedule-based, so it needs real start/end dates. In planning mode
        (no real dates) it returns 0 — PV/SV/SPI are not defined there.
        """
        self.ensure_one()
        if not self.date_start or not self.date_end:
            return 0.0
        status = self.project_id.status_date or fields.Datetime.now()
        if status <= self.date_start:
            return 0.0
        if status >= self.date_end:
            return 1.0
        total = (self.date_end - self.date_start).total_seconds()
        if total <= 0:
            return 1.0
        return (status - self.date_start).total_seconds() / total


class ProjectProjectCost(models.Model):
    _inherit = 'project.project'

    status_date = fields.Datetime(
        string='狀態日',
        help='賺得值（PV）計算的基準時間點；留空則以目前時間計算。',
    )
    # currency_id is provided natively by project.project (_compute_currency_id);
    # do not redefine it. The Monetary fields below reference it via
    # currency_field='currency_id'.
    total_planned_cost = fields.Monetary(
        string='總預算 (BAC)', compute='_compute_cost_rollup', store=True,
        currency_field='currency_id', groups=COST_GROUP)
    total_actual_cost = fields.Monetary(
        string='總實際成本 (AC)', compute='_compute_cost_rollup', store=True,
        currency_field='currency_id', groups=COST_GROUP)
    total_earned_value = fields.Monetary(
        string='總賺得值 (EV)', compute='_compute_cost_rollup', store=True,
        currency_field='currency_id', groups=COST_GROUP)
    total_planned_value = fields.Monetary(
        string='總計畫值 (PV)', compute='_compute_cost_rollup', store=True,
        currency_field='currency_id', groups=COST_GROUP)
    total_cost_variance = fields.Monetary(
        string='總成本差異 (CV)', compute='_compute_cost_rollup', store=True,
        currency_field='currency_id', groups=COST_GROUP)
    total_schedule_variance = fields.Monetary(
        string='總進度差異 (SV)', compute='_compute_cost_rollup', store=True,
        currency_field='currency_id', groups=COST_GROUP)
    project_cpi = fields.Float(
        string='專案 CPI', compute='_compute_project_indices',
        digits=(12, 2), groups=COST_GROUP)
    project_spi = fields.Float(
        string='專案 SPI', compute='_compute_project_indices',
        digits=(12, 2), groups=COST_GROUP)

    @api.depends(
        'task_ids.planned_cost', 'task_ids.actual_cost',
        'task_ids.earned_value', 'task_ids.planned_value',
    )
    def _compute_cost_rollup(self):
        for project in self:
            # Sum every task: a task's cost comes from its OWN resource links
            # (not a child rollup), so summing all tasks never double-counts —
            # and a parent that carries its own resources is correctly included.
            tasks = project.task_ids
            ev = sum(tasks.mapped('earned_value'))
            ac = sum(tasks.mapped('actual_cost'))
            pv = sum(tasks.mapped('planned_value'))
            project.total_planned_cost = sum(tasks.mapped('planned_cost'))
            project.total_actual_cost = ac
            project.total_earned_value = ev
            project.total_planned_value = pv
            project.total_cost_variance = ev - ac
            project.total_schedule_variance = ev - pv

    @api.depends('total_earned_value', 'total_actual_cost', 'total_planned_value')
    def _compute_project_indices(self):
        # Cheap, non-stored: derived purely from the already-stored totals, so
        # reading CPI/SPI never re-scans the whole task set.
        for project in self:
            ac = project.total_actual_cost
            pv = project.total_planned_value
            ev = project.total_earned_value
            project.project_cpi = (ev / ac) if ac else 0.0
            project.project_spi = (ev / pv) if pv else 0.0


class ProjectBaselineLineVariance(models.Model):
    _inherit = 'project.baseline.line'

    start_variance_days = fields.Float(
        string='開始差異(天)', compute='_compute_variance',
        help='目前開始日 − 基線開始日（天）。')
    duration_variance = fields.Float(
        string='工期差異(小時)', compute='_compute_variance')
    progress_variance = fields.Float(
        string='進度差異', compute='_compute_variance')

    @api.depends(
        'date_start', 'duration', 'progress',
        'task_id.date_start', 'task_id.duration', 'task_id.progress',
    )
    def _compute_variance(self):
        for line in self:
            task = line.task_id
            if line.date_start and task.date_start:
                line.start_variance_days = (
                    task.date_start - line.date_start).total_seconds() / 86400.0
            else:
                line.start_variance_days = 0.0
            line.duration_variance = (task.duration or 0.0) - (line.duration or 0.0)
            line.progress_variance = (task.progress or 0.0) - (line.progress or 0.0)
