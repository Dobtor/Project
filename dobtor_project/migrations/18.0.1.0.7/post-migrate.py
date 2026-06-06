# -*- coding: utf-8 -*-
"""Post-migration 18.0.1.0.7.

EVM compute methods changed in this version:
  * project rollups now sum ALL tasks (previously leaf-only, which dropped the
    cost of parent tasks that carry their own resources)
  * resource cost_rate is converted to the company currency
  * cost_hourly_rate moved to its own compute

Changed compute methods are not auto-recomputed on upgrade, so force a refresh
of the stored cost / earned-value fields. EVM only ships recently so the data
volume is small.
"""
import logging

from odoo import api, SUPERUSER_ID

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    tasks = env['project.task'].search([])
    if tasks:
        tasks._compute_cost_hourly_rate()
        tasks._compute_cost_values()
        tasks._compute_ev_values()
    projects = env['project.project'].search([])
    if projects:
        projects._compute_cost_rollup()
    _logger.info(
        "Post-migrate 18.0.1.0.7: recomputed EVM for %d tasks / %d projects",
        len(tasks), len(projects))
