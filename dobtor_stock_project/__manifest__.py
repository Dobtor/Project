# -*- coding: utf-8 -*-
{
    'name': "Dobtor Stock Project",

    'summary': "",

    'description': """
    """,

    'author': "My Company",
    'website': "https://www.yourcompany.com",

    # Categories can be used to filter modules in modules listing
    # Check https://github.com/odoo/odoo/blob/15.0/odoo/addons/base/data/ir_module_category_data.xml
    # for the full list
    'category': 'Uncategorized',
    'version': '0.1',

    # any module necessary for this one to work correctly
    'depends': ["stock", "project"],

    # always loaded
    'data': [
        # 'security/ir.model.access.csv',
        "views/res_config_settings_views.xml",
        "views/stock_views.xml",
    ],
    # only loaded in demonstration mode
    'demo': [
        'demo/demo.xml',
    ],
}

