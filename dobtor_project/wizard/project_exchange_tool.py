# -*- coding: utf-8 -*-

import re
from datetime import datetime, timedelta
from lxml import etree as LxmlET
from xml.dom import minidom
from xml.etree import ElementTree as ET


def prettify(elem):
    """Return a pretty-printed XML string for the Element.

    Supports both stdlib ElementTree and lxml etree elements.
    """
    if hasattr(elem, 'getroottree'):
        # lxml element — use lxml's tostring for correct namespace handling
        return LxmlET.tostring(
            elem, pretty_print=True, xml_declaration=True,
            encoding='unicode',
        )
    rough = ET.tostring(elem, encoding='unicode')
    reparsed = minidom.parseString(rough)
    return reparsed.toprettyxml(indent="  ")


# ---------------------------------------------------------------------------
# Date conversion
# ---------------------------------------------------------------------------

DATE_FMT = "%Y-%m-%dT%H:%M:%S"


def odoo_dt_to_xml(dt_str):
    """Convert Odoo datetime string to XML format."""
    if not dt_str:
        return ""
    if isinstance(dt_str, datetime):
        return dt_str.strftime(DATE_FMT)
    return str(dt_str).replace(" ", "T")[:19]


def xml_dt_to_odoo(xml_str):
    """Convert XML datetime string to Odoo datetime string."""
    if not xml_str:
        return False
    try:
        return datetime.strptime(xml_str[:19], DATE_FMT).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return False


# ---------------------------------------------------------------------------
# ISO 8601 duration
# ---------------------------------------------------------------------------

def hours_to_iso8601(hours):
    """Convert hours (int/float) to ISO 8601 duration: PT8H0M0S"""
    if not hours:
        return "PT0H0M0S"
    total_seconds = int(abs(hours) * 3600)
    h, rem = divmod(total_seconds, 3600)
    m, s = divmod(rem, 60)
    return f"PT{h}H{m}M{s}S"


# Keep old name as alias for backward compatibility
seconds_to_iso8601 = hours_to_iso8601


def iso8601_to_hours(iso_str):
    """Convert ISO 8601 duration PT8H0M0S to hours (float)."""
    if not iso_str:
        return 0.0
    match = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso_str)
    if not match:
        return 0.0
    h = int(match.group(1) or 0)
    m = int(match.group(2) or 0)
    s = int(match.group(3) or 0)
    return h + m / 60.0 + s / 3600.0


# Keep old name as alias for backward compatibility
iso8601_to_seconds = iso8601_to_hours


# ---------------------------------------------------------------------------
# Boolean / mode mappers
# ---------------------------------------------------------------------------

def bool_to_xml(val):
    return "1" if val else "0"


def xml_to_bool(val):
    return val == "1" or val == "true"


SCHEDULE_MODE_MAP = {"auto": "0", "manual": "1"}
SCHEDULE_MODE_MAP_REV = {"0": "auto", "1": "manual"}


def schedule_mode_to_xml(mode):
    return SCHEDULE_MODE_MAP.get(mode, "1")


def xml_to_schedule_mode(val):
    return SCHEDULE_MODE_MAP_REV.get(val, "manual")


SCHEDULING_TYPE_MAP = {"backward": "0", "forward": "1"}
SCHEDULING_TYPE_MAP_REV = {"0": "backward", "1": "forward"}


def scheduling_type_to_xml(stype):
    return SCHEDULING_TYPE_MAP.get(stype, "1")


def xml_to_scheduling_type(val):
    return SCHEDULING_TYPE_MAP_REV.get(val, "forward")


# ---------------------------------------------------------------------------
# Constraint type mapping (8 types)
# ---------------------------------------------------------------------------

CONSTRAINT_MAP = {
    "asap": "0", "alap": "1",
    "mso": "2", "mfo": "3",
    "snet": "4", "snlt": "5",
    "fnet": "6", "fnlt": "7",
}
CONSTRAINT_MAP_REV = {v: k for k, v in CONSTRAINT_MAP.items()}


def constraint_type_to_xml(ctype):
    return CONSTRAINT_MAP.get(ctype, "0")


def xml_to_constraint_type(val):
    return CONSTRAINT_MAP_REV.get(val, "asap")


# ---------------------------------------------------------------------------
# Predecessor link type mapping
# ---------------------------------------------------------------------------

PRED_TYPE_MAP = {"FF": "0", "FS": "1", "SF": "2", "SS": "3"}
PRED_TYPE_MAP_REV = {v: k for k, v in PRED_TYPE_MAP.items()}


def pred_type_to_xml(ptype):
    return PRED_TYPE_MAP.get(ptype, "1")


def xml_to_pred_type(val):
    return PRED_TYPE_MAP_REV.get(val, "FS")


# ---------------------------------------------------------------------------
# Lag format mapping (MS Project XML compatibility)
# Internally lag is stored as Float hours (lag_hours).
# MS Project XML uses LagFormat codes and a multiplier-based LinkLag value.
# These helpers convert between lag_hours and MS Project XML format.
# ---------------------------------------------------------------------------

LAG_FORMAT_MAP = {
    "minute": "3", "hour": "5",
    "day": "7", "week": "9",
    "month": "11", "percent": "19",
}
LAG_FORMAT_MAP_REV = {
    "3": "minute", "4": "minute",
    "5": "hour", "6": "hour",
    "7": "day", "8": "day",
    "9": "week", "10": "week",
    "11": "month", "12": "month",
    "19": "percent", "20": "percent",
    "35": "minute", "36": "minute",
    "37": "hour", "38": "hour",
    "39": "day", "40": "day",
    "41": "week", "42": "week",
}

LAG_MULTIPLIER = {
    "minute": 10, "hour": 10,
    "day": 4800, "week": 4800,
    "month": 4800, "percent": 10,
}

# Conversion factors: unit → hours
_UNIT_TO_HOURS = {
    "minute": 1.0 / 60,
    "hour": 1.0,
    "day": 24.0,
    "week": 168.0,
    "month": 720.0,
}


def lag_hours_to_xml(lag_hours):
    """Convert lag_hours (Float) to MS Project XML (LinkLag str, LagFormat str)."""
    if not lag_hours:
        return "0", "7"  # 0 days
    # Export as hours (LagFormat=5, multiplier=10)
    link_lag = str(int(lag_hours * 10))
    return link_lag, "5"


def xml_lag_to_hours(link_lag_str, lag_format_str):
    """Convert MS Project XML LinkLag + LagFormat to lag_hours (Float)."""
    unit = LAG_FORMAT_MAP_REV.get(lag_format_str, "day")
    mult = LAG_MULTIPLIER.get(unit, 4800)
    if mult == 0:
        return 0.0
    qty_in_unit = float(link_lag_str) / mult
    return qty_in_unit * _UNIT_TO_HOURS.get(unit, 24.0)
