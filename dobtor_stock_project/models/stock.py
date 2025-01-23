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
            tasks_ids = None
            if "repair_task_id" in self.env["repair.order"]._fields and picking.return_id:
                tasks_ids = picking and picking.return_id and picking.return_id.repair_ids and picking.return_id.repair_ids.repair_task_id 
            if order and order.task_id:
                tasks_ids = order.task_id
            if tasks_ids:
                if order:
                    all_done = all(p.state == "done" for p in order.picking_ids)
                    if not all_done:
                        continue
                
                delivery_stage = self.env.company.stock_delivery_stage
                
                if delivery_stage:
                    tasks_ids.sudo().write({
                        "stage_id": delivery_stage.id
                    })