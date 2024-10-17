from odoo import models, fields, api

class StockPicking(models.Model):
    _inherit = "stock.picking"
    
    target_task_stage = fields.Many2one("project.task.stage", string="Taget Task Stage")
    
    def button_validate(self):
        res = super(StockPicking, self).button_validate()
        if res:
            self.process_task()
        return res
    
    def process_task(self):
        for picking in self:
            order = self.env["sale.order"].search([("picking_ids", "in", [picking.id])], limit=1)
            if order and order.tasks_ids:
                all_done = all(p.state == "done" for p in order.picking_ids)
                if not all_done:
                    continue
                
                delivery_stage = order.company_id.stock_delivery_stage
                
                if delivery_stage:
                    order.tasks_ids.sudo().write({
                        "stage_id": delivery_stage.id
                    })