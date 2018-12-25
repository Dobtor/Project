# -*- coding: utf-8 -*-
{
    'name': "dobtor_project_issue_extend",
    'description': """
        Flexible editing of description text.
        Add attachment association.
        Setting the number of project issues.
        Setting the serial of project issues.
        Create Subissue.
    """,
    'author': "Dobtor SI",
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
        'views/project_issue_views.xml',
        'data/issue_stage_data.xml',
        'data/issue_ir_sequence_data.xml',
    ],
}
