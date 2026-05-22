"""QGIS plugin: open .frb (FlatRecord) files as in-memory vector layers.

This is the controller that wires the menu action into QGIS, runs the
reader from `frb_reader.py`, and surfaces results as a
`QgsVectorLayer`. The reader is pure Python and has no Node / npm
dependency.

Behaviour:

  * One menu entry under Vector → FlatRecord → Open `.frb`…
  * File-open dialog filtered to `*.frb`
  * Parses the file (header → directory → features block)
  * Builds a memory layer with the appropriate geometry type and
    schema, then bulk-adds features
  * Layer name defaults to the dataset's `name` / `title` header
    string when set, else the filename stem
  * Reports parse / shape errors via QGIS message bar (5-second
    warning, full traceback to the Log Messages panel)
"""

from __future__ import annotations

import json
import os
import traceback
from typing import Any

from qgis.core import (
    Qgis,
    QgsCoordinateReferenceSystem,
    QgsFeature,
    QgsField,
    QgsGeometry,
    QgsMessageLog,
    QgsProject,
    QgsVectorLayer,
)
from qgis.PyQt.QtCore import QCoreApplication, QVariant
from qgis.PyQt.QtGui import QIcon
from qgis.PyQt.QtWidgets import QAction, QFileDialog

from .flatrecord_fb.FlatGeobuf.ColumnType import ColumnType
from .flatrecord_fb.FlatGeobuf.GeometryType import GeometryType
from .frb_reader import FrbError, FrbFile

PLUGIN_NAME = "FlatRecord"
LOG_TAG = "FlatRecord"


def _qvariant_for(col_type: int) -> QVariant.Type:
    """Map FlatRecord column types to QGIS QVariant types."""
    if col_type == ColumnType.Bool:
        return QVariant.Bool
    if col_type in (ColumnType.Byte, ColumnType.UByte, ColumnType.Short, ColumnType.UShort, ColumnType.Int, ColumnType.UInt):
        return QVariant.Int
    if col_type in (ColumnType.Long, ColumnType.ULong):
        return QVariant.LongLong
    if col_type in (ColumnType.Float, ColumnType.Double):
        return QVariant.Double
    if col_type == ColumnType.DateTime:
        return QVariant.DateTime
    if col_type == ColumnType.Json:
        # No native JSON column in older QGIS; store as a string.
        return QVariant.String
    if col_type == ColumnType.Binary:
        return QVariant.ByteArray
    return QVariant.String  # default catch-all


_MEMORY_GEOMETRY_KIND = {
    GeometryType.Point: "Point",
    GeometryType.LineString: "LineString",
    GeometryType.Polygon: "Polygon",
    GeometryType.MultiPoint: "MultiPoint",
    GeometryType.MultiLineString: "MultiLineString",
    GeometryType.MultiPolygon: "MultiPolygon",
    GeometryType.GeometryCollection: "GeometryCollection",
}


class FlatRecordPlugin:
    """QGIS plugin entry — added to Vector menu."""

    def __init__(self, iface) -> None:
        self.iface = iface
        self.actions: list[QAction] = []
        self.menu = f"&{PLUGIN_NAME}"

    # ── lifecycle ─────────────────────────────────────────────────

    def initGui(self) -> None:  # noqa: N802
        icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
        icon = QIcon(icon_path) if os.path.exists(icon_path) else QIcon()
        action = QAction(icon, "Open .frb…", self.iface.mainWindow())
        action.triggered.connect(self.run)
        action.setStatusTip("Open a FlatRecord (.frb) file as a QGIS vector layer")
        action.setObjectName("flatrecord_open")
        self.iface.addPluginToVectorMenu(self.menu, action)
        self.iface.addToolBarIcon(action)
        self.actions.append(action)

    def unload(self) -> None:
        for action in self.actions:
            self.iface.removePluginVectorMenu(self.menu, action)
            self.iface.removeToolBarIcon(action)
        self.actions = []

    # ── action handler ────────────────────────────────────────────

    def run(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self.iface.mainWindow(),
            "Open FlatRecord file",
            "",
            "FlatRecord (*.frb);;All files (*)",
        )
        if not path:
            return

        try:
            self._load_file(path)
        except FrbError as exc:
            self._show_error(f"Invalid FlatRecord file: {exc}", path)
        except Exception as exc:  # noqa: BLE001 — surface full trace to log
            self._show_error(f"Unexpected error: {exc}", path, full_trace=True)

    # ── core: parse + add layer ───────────────────────────────────

    def _load_file(self, path: str) -> None:
        frb = FrbFile.from_path(path)

        layer_name = frb.name or frb.title or os.path.splitext(os.path.basename(path))[0]

        if not frb.has_geometry:
            self._show_warning(
                f'"{layer_name}" has no per-feature geometry (mode={"graph" if frb.features_count else "table"}). '
                "This MVP plugin only supports geo / geograph files.",
                path,
            )
            return

        geom_kind = _MEMORY_GEOMETRY_KIND.get(frb.geometry_type)
        if geom_kind is None:
            # Heterogeneous file (geometry_type=Unknown but
            # has_feature_geometry=true). Default to a generic
            # `Geometry` memory layer; QGIS will adapt per feature.
            geom_kind = "GeometryCollection"

        uri = f"{geom_kind}?crs=EPSG:4326"
        layer = QgsVectorLayer(uri, layer_name, "memory")
        if not layer.isValid():
            raise FrbError(f"Could not create memory layer for geometry kind {geom_kind}")

        # Build field schema from the header's column metadata.
        provider = layer.dataProvider()
        if frb.columns:
            qgis_fields = [
                QgsField(col["name"], _qvariant_for(col["type"]))
                for col in frb.columns
            ]
            provider.addAttributes(qgis_fields)
            layer.updateFields()

        # Bulk-add features.
        features = []
        for geometry, properties in frb.iter_features():
            qfeat = QgsFeature(layer.fields())
            if geometry is not None:
                qgeom = QgsGeometry.fromWkt(_geojson_to_wkt(geometry))
                if qgeom is not None and not qgeom.isEmpty():
                    qfeat.setGeometry(qgeom)
            attrs = []
            for col in frb.columns:
                v = properties.get(col["name"])
                # Json columns: stringify the parsed value so QGIS can
                # display it (no native dict-as-attribute support).
                if col["type"] == ColumnType.Json and not isinstance(v, str):
                    v = json.dumps(v, ensure_ascii=False) if v is not None else None
                attrs.append(v)
            qfeat.setAttributes(attrs)
            features.append(qfeat)

        provider.addFeatures(features)
        layer.updateExtents()

        QgsProject.instance().addMapLayer(layer)

        # Surface dataset metadata in the QGIS log so users can see it
        # without inspecting layer properties.
        msg_lines = [f"Loaded {len(features)} features from {path}"]
        if frb.name:
            msg_lines.append(f"  name: {frb.name}")
        if frb.title:
            msg_lines.append(f"  title: {frb.title}")
        if frb.description:
            msg_lines.append(f"  description: {frb.description}")
        if frb.timestamp_ms is not None:
            msg_lines.append(f"  timestamp (ms): {frb.timestamp_ms}")
        QgsMessageLog.logMessage("\n".join(msg_lines), LOG_TAG, Qgis.Info)

        self.iface.messageBar().pushSuccess(
            PLUGIN_NAME,
            f"Loaded {len(features)} features from {os.path.basename(path)}",
        )

    # ── error surface ────────────────────────────────────────────

    def _show_error(self, message: str, path: str, *, full_trace: bool = False) -> None:
        QgsMessageLog.logMessage(
            f"{message}\nFile: {path}\n{traceback.format_exc() if full_trace else ''}",
            LOG_TAG,
            Qgis.Critical,
        )
        self.iface.messageBar().pushCritical(PLUGIN_NAME, message)

    def _show_warning(self, message: str, path: str) -> None:
        QgsMessageLog.logMessage(f"{message}\nFile: {path}", LOG_TAG, Qgis.Warning)
        self.iface.messageBar().pushWarning(PLUGIN_NAME, message)


# Type stubs are not used at import time; this silences linters that
# don't follow the QGIS plugin loading model.
_ = QCoreApplication
_ = QgsCoordinateReferenceSystem


def _geojson_to_wkt(geometry: dict[str, Any]) -> str:
    """Convert a GeoJSON-shaped geometry dict to WKT."""
    gtype = geometry["type"]
    coords = geometry.get("coordinates")
    if gtype == "Point":
        x, y = coords[0], coords[1]
        return f"POINT({x} {y})"
    if gtype == "LineString":
        return "LINESTRING(" + _ring(coords) + ")"
    if gtype == "Polygon":
        return "POLYGON(" + ",".join(f"({_ring(r)})" for r in coords) + ")"
    if gtype == "MultiPoint":
        return "MULTIPOINT(" + ",".join(f"({c[0]} {c[1]})" for c in coords) + ")"
    if gtype == "MultiLineString":
        return "MULTILINESTRING(" + ",".join(f"({_ring(r)})" for r in coords) + ")"
    if gtype == "MultiPolygon":
        return (
            "MULTIPOLYGON("
            + ",".join(
                "(" + ",".join(f"({_ring(r)})" for r in poly) + ")" for poly in coords
            )
            + ")"
        )
    if gtype == "GeometryCollection":
        return (
            "GEOMETRYCOLLECTION("
            + ",".join(_geojson_to_wkt(g) for g in geometry.get("geometries", []))
            + ")"
        )
    raise FrbError(f"Unsupported GeoJSON geometry type: {gtype}")


def _ring(coords: list[list[float]]) -> str:
    return ",".join(f"{c[0]} {c[1]}" for c in coords)
