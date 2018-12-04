# -*- coding: utf-8 -*-
{
    'name': "dobtor_project_issue_extend",

    'description': """
        Issue Description 改為HTML Editor

        新增 attachment 的Smart button

        Issue Stage當狀態移至 Done 則Project中不顯示Counts

        自動產生編號 

        可建立子Issue ，編號流水號直接自動往下帶
    """,

    'author': "Dobtor",
    'website': "https://www.dobtor.com/",

    # Categories can be used to filter modules in modules listing
    # Check https://github.com/odoo/odoo/blob/master/odoo/addons/base/module/module_data.xml
    # for the full list
    'category': 'Uncategorized',
    'version': '0.1',

    # any module necessary for this one to work correctly
    'depends': ['base','project_issue','project_issue_stage'],

    # always loaded
    'data': [
        # 'security/ir.model.access.csv',
        'views/project_issue_views_extend.xml',
        'data/issue_stage_data.xml',
        'data/issue_ir_sequence_data.xml',
    ],
    # only loaded in demonstration mode
    # 'demo': [
    #     'demo/demo.xml',
    # ],
}