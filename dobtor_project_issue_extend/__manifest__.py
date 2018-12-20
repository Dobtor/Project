# -*- coding: utf-8 -*-
{
    'name': "dobtor_project_issue_extend",
    'description': """
        Modify Issue Description field datatype to HTML

        Add attachment association

        Issue Stage當狀態移至 Done 則Project中不顯示Counts

        自動產生編號 

        可建立子Issue ，編號流水號直接自動往下帶
    """,
    'author': "Dobtor",
    'website': "https://www.dobtor.com/",
    'category': 'dobtor',
    'version': '0.1',
    'depends': [
        'dobtor_project_core',
        'project_issue',
        'project_issue_stage',
    ],
    'data': [
        # 'security/ir.model.access.csv',
        'views/project_issue_views_extend.xml',
        'data/issue_stage_data.xml',
        'data/issue_ir_sequence_data.xml',
    ],
}
