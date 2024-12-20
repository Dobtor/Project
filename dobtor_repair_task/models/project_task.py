# -*- coding: utf-8 -*-
from odoo import models, fields, api


class Task(models.Model):
    _inherit = 'project.task'

    user_ids = fields.Many2many(domain="[('active', '=', True)]")
