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
    hourly_rate   = Σ links (load_factor × resource.cost_rate)
    planned_cost  = allocated_hours × hourly_rate            (BAC)
    actual_cost   = effective_hours × hourly_rate            (AC / ACWP)
    earned_value  = planned_cost × (progress / 100)          (EV / BCWP)
    planned_value = planned_cost × scheduled_fraction(status) (PV / BCWS)
    cost_variance     = EV − AC
    schedule_variance = EV − PV
    cpi = EV / AC   (0 when AC = 0)
    spi = EV / PV   (0 when PV = 0)
"""

from odoo import models, fields, api


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
        compute='_compute_cost_values',
        currency_field='currency_id',
        store=True,
        help='本任務所有指派資源的（負載率×每小時成本）總和。',
    )
    planned_cost = fields.Monetary(
        string='預算成本 (BAC)',
        compute='_compute_cost_values',
        currency_field='currency_id',
        store=True,
        help='計畫工時 × 每小時成本。',
    )
    actual_cost = fields.Monetary(
        string='實際成本 (AC)',
        compute='_compute_cost_values',
        currency_field='currency_id',
        store=True,
        help='已登錄工時 × 每小時成本。',
    )
    earned_value = fields.Monetary(
        string='賺得值 (EV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        help='預算成本 × 完成百分比。',
    )
    planned_value = fields.Monetary(
        string='計畫值 (PV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        help='依狀態日的排程進度應完成的預算成本。',
    )
    cost_variance = fields.Monetary(
        string='成本差異 (CV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        help='EV − AC，負值代表超出預算。',
    )
    schedule_variance = fields.Monetary(
        string='進度差異 (SV)',
        compute='_compute_ev_values',
        currency_field='currency_id',
        store=True,
        help='EV − PV，負值代表落後進度。',
    )
    cpi = fields.Float(
        string='成本績效 (CPI)',
        compute='_compute_ev_values',
        store=True,
        digits=(12, 2),
        help='EV / AC，<1 代表超出預算。',
    )
    spi = fields.Float(
        string='進度績效 (SPI)',
        compute='_compute_ev_values',
        store=True,
        digits=(12, 2),
        help='EV / PV，<1 代表落後進度。',
    )

    @api.depends(
        'allocated_hours', 'effective_hours',
        'task_resource_ids.load_factor',
        'task_resource_ids.resource_id.cost_rate',
    )
    def _compute_cost_values(self):
        for task in self:
            hourly_rate = sum(
                (link.load_factor or 0.0) * (link.resource_id.cost_rate or 0.0)
                for link in task.task_resource_ids
            )
            task.cost_hourly_rate = hourly_rate
            task.planned_cost = (task.allocated_hours or 0.0) * hourly_rate
            task.actual_cost = (task.effective_hours or 0.0) * hourly_rate

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
        """Fraction of the task that *should* be done by the status date (0..1)."""
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
        string='總預算 (BAC)', compute='_compute_cost_rollup',
        currency_field='currency_id')
    total_actual_cost = fields.Monetary(
        string='總實際成本 (AC)', compute='_compute_cost_rollup',
        currency_field='currency_id')
    total_earned_value = fields.Monetary(
        string='總賺得值 (EV)', compute='_compute_cost_rollup',
        currency_field='currency_id')
    total_planned_value = fields.Monetary(
        string='總計畫值 (PV)', compute='_compute_cost_rollup',
        currency_field='currency_id')
    total_cost_variance = fields.Monetary(
        string='總成本差異 (CV)', compute='_compute_cost_rollup',
        currency_field='currency_id')
    total_schedule_variance = fields.Monetary(
        string='總進度差異 (SV)', compute='_compute_cost_rollup',
        currency_field='currency_id')
    project_cpi = fields.Float(
        string='專案 CPI', compute='_compute_cost_rollup', digits=(12, 2))
    project_spi = fields.Float(
        string='專案 SPI', compute='_compute_cost_rollup', digits=(12, 2))

    @api.depends(
        'task_ids.planned_cost', 'task_ids.actual_cost',
        'task_ids.earned_value', 'task_ids.planned_value',
        'task_ids.child_ids',
    )
    def _compute_cost_rollup(self):
        for project in self:
            # Sum leaf tasks only, so a parent carrying its own resources does
            # not double-count its children.
            leaves = project.task_ids.filtered(lambda t: not t.child_ids)
            bac = sum(leaves.mapped('planned_cost'))
            ac = sum(leaves.mapped('actual_cost'))
            ev = sum(leaves.mapped('earned_value'))
            pv = sum(leaves.mapped('planned_value'))
            project.total_planned_cost = bac
            project.total_actual_cost = ac
            project.total_earned_value = ev
            project.total_planned_value = pv
            project.total_cost_variance = ev - ac
            project.total_schedule_variance = ev - pv
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
