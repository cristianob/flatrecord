"""QGIS plugin entry point for FlatRecord.

QGIS imports the plugin by calling `classFactory(iface)` at startup,
where `iface` is the active `QgisInterface`. The factory returns an
object with `initGui()` and `unload()` methods that QGIS calls when
enabling / disabling the plugin.
"""

from __future__ import annotations


def classFactory(iface):  # noqa: N802 — required by QGIS
    from .flatrecord_plugin import FlatRecordPlugin
    return FlatRecordPlugin(iface)
