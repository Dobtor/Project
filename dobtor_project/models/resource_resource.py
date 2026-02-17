# -*- coding: utf-8 -*-
from odoo import models, fields


class ResourceAps(models.Model):
    _inherit = 'resource.resource'

    resource_task_ids = fields.One2many(
        'project.task.resource.link',
        'resource_id',
        string='資源'
    )
