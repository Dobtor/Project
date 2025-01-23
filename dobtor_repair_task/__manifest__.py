# -*- coding: utf-8 -*-
{
    'name': "Dobtor Repair Task",

    'summary': "訂單派工處理",

    'description': """
        - 訂單安裝、退貨、維修的派工產品相關設定
        - 派工單階段：現場完工、寄回原廠設定
        - 設定order line distributor，創建派工單時代入assignees
        - 訂單退貨建立退貨派工單，並與repair order關聯
    """,

    'author': "My Company",
    'website': "https://www.yourcompany.com",
    'category': 'Uncategorized',
    'version': '0.1',
    'depends': [
        'industry_fsm',
        'sale_project',
        'dobtor_distributor',
        'dobtor_repair_delivery',
    ],

    'data': [
        # 'security/ir.model.access.csv',
        'views/res_config_setting_views.xml',
        'views/sale_order_views.xml',
    ],
}

