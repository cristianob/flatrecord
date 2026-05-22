"""Minimal pure-Python reader for FlatRecord (.frb) files.

Scope of this MVP:

  * `geo` mode (features with geometry) — fully supported
  * `geograph` mode — features are read; links are not surfaced as
    QGIS layer (would need a separate "links" vector layer)
  * `table` / `graph` mode (no geometry) — would need a QGIS table
    layer; out of scope for the v1 plugin

The reader walks the directory, fetches the features block, and
parses each `Feature` flatbuffer record into a `(geometry, properties)`
pair. Geometry is returned as a dict in GeoJSON shape so the QGIS
plugin can convert it via `QgsGeometry.fromWkt` or similar.

Implementation notes:

  * The flatbuffer header parsing uses the auto-generated bindings in
    `flatrecord_fb/`. We bundle those rather than depend on a system
    flatc install.
  * Properties use the column-indexed encoding documented in
    `doc/format-spec.md` (`[col_idx:u16][value_bytes...]` repeated).
  * The header CRC32 slot is read but not verified — QGIS surfaces
    parse errors via exceptions, and a corrupted file will fail later
    anyway. Verification can be added if it becomes useful.
"""

from __future__ import annotations

import struct
from typing import Any, Iterator

import flatbuffers

from .flatrecord_fb.FlatGeobuf.ColumnType import ColumnType
from .flatrecord_fb.FlatGeobuf.Feature import Feature
from .flatrecord_fb.FlatGeobuf.GeometryType import GeometryType
from .flatrecord_fb.FlatGeobuf.Header import Header

MAGIC_PREFIX = b"\x66\x72\x62\x01"  # bytes 0-3 of every FlatRecord file
SIZE_PREFIX_LEN = 4
CRC_LEN = 4


class FrbError(Exception):
    """Raised on a malformed or unsupported FlatRecord file."""


class FrbFile:
    """Parsed `.frb` file, ready to iterate features.

    Construct via `FrbFile.from_path(path)`. Don't instantiate
    directly — the constructor takes already-validated state.
    """

    def __init__(
        self,
        *,
        data: bytes,
        header: Header,
        columns: list[dict[str, Any]],
        features_offset: int,
        features_length: int,
    ) -> None:
        self._data = data
        self._header = header
        self._columns = columns
        self._features_offset = features_offset
        self._features_length = features_length

    @classmethod
    def from_path(cls, path: str) -> "FrbFile":
        with open(path, "rb") as fh:
            data = fh.read()
        return cls.from_bytes(data)

    @classmethod
    def from_bytes(cls, data: bytes) -> "FrbFile":
        if len(data) < 12:
            raise FrbError("File too small to be a FlatRecord")
        if data[:4] != MAGIC_PREFIX:
            raise FrbError(
                f"Not a FlatRecord file (magic bytes {data[:4].hex()} != frb01)"
            )

        (header_size,) = struct.unpack_from("<I", data, 8)
        if header_size < 4 or 8 + SIZE_PREFIX_LEN + header_size > len(data):
            raise FrbError(f"Invalid header size {header_size}")

        # Header lives at byte 8 with a 4-byte size prefix. The
        # generated Python helper expects the buffer to start at the
        # size prefix and the second arg to be the offset of the table
        # root within that buffer (4 = past the size prefix).
        header_buf = data[8 : 8 + SIZE_PREFIX_LEN + header_size]
        header = Header.GetRootAsHeader(header_buf, SIZE_PREFIX_LEN)

        columns: list[dict[str, Any]] = []
        for i in range(header.ColumnsLength()):
            col = header.Columns(i)
            columns.append(
                {
                    "name": col.Name().decode("utf-8") if col.Name() else f"col{i}",
                    "type": col.Type(),
                }
            )

        features_offset = int(header.FeaturesOffset())
        features_length = int(header.FeaturesLength())
        if features_length == 0:
            # `table` / `graph` mode — no features payload (or no
            # geometry, in which case we don't make a vector layer).
            pass
        elif features_offset + features_length > len(data):
            raise FrbError(
                f"Features block (offset={features_offset}, length={features_length}) "
                f"extends past file end ({len(data)})"
            )

        return cls(
            data=data,
            header=header,
            columns=columns,
            features_offset=features_offset,
            features_length=features_length,
        )

    # ── header metadata accessors ────────────────────────────────────

    @property
    def name(self) -> str | None:
        return _decode(self._header.Name())

    @property
    def title(self) -> str | None:
        return _decode(self._header.Title())

    @property
    def description(self) -> str | None:
        return _decode(self._header.Description())

    @property
    def metadata(self) -> str | None:
        return _decode(self._header.Metadata())

    @property
    def timestamp_ms(self) -> int | None:
        ts = int(self._header.Timestamp())
        return ts or None

    @property
    def features_count(self) -> int:
        return int(self._header.FeaturesCount())

    @property
    def geometry_type(self) -> int:
        return int(self._header.GeometryType())

    @property
    def has_geometry(self) -> bool:
        return bool(self._header.HasFeatureGeometry())

    @property
    def columns(self) -> list[dict[str, Any]]:
        return self._columns

    @property
    def envelope(self) -> tuple[float, float, float, float] | None:
        if self._header.EnvelopeLength() != 4:
            return None
        e = self._header.EnvelopeAsNumpy()
        return (float(e[0]), float(e[1]), float(e[2]), float(e[3]))

    # ── feature iteration ────────────────────────────────────────────

    def iter_features(self) -> Iterator[tuple[dict[str, Any] | None, dict[str, Any]]]:
        """Yield `(geometry_geojson, properties)` for each feature.

        `geometry_geojson` is a GeoJSON-shaped dict (`{"type": ..., "coordinates": ...}`)
        or `None` when the file has no per-feature geometry.
        """
        if self._features_length == 0:
            return
        cursor = self._features_offset
        end = cursor + self._features_length
        geom_type = self.geometry_type
        while cursor < end:
            (feature_size,) = struct.unpack_from("<I", self._data, cursor)
            feature_buf = self._data[cursor : cursor + SIZE_PREFIX_LEN + feature_size]
            feature = Feature.GetRootAsFeature(feature_buf, SIZE_PREFIX_LEN)
            geometry = (
                _parse_geometry(feature.Geometry(), geom_type)
                if self.has_geometry and feature.Geometry() is not None
                else None
            )
            properties = _parse_properties(feature, self._columns)
            yield geometry, properties
            cursor += SIZE_PREFIX_LEN + feature_size


# ── geometry parsing ────────────────────────────────────────────────


def _parse_geometry(geom: Any, header_geom_type: int) -> dict[str, Any] | None:
    if geom is None:
        return None

    # Each Feature.geometry may carry its own type (heterogeneous
    # datasets); fall back to the header's geometry_type for uniform
    # files where the per-feature type is 0 (Unknown).
    gt = geom.Type()
    if gt == GeometryType.Unknown:
        gt = header_geom_type

    if gt == GeometryType.Point:
        return _coords_to_geojson("Point", geom, gt)
    if gt == GeometryType.LineString:
        return _coords_to_geojson("LineString", geom, gt)
    if gt == GeometryType.Polygon:
        return _polygon_to_geojson(geom)
    if gt == GeometryType.MultiPoint:
        return _coords_to_geojson("MultiPoint", geom, gt)
    if gt == GeometryType.MultiLineString:
        return _multi_linestring_to_geojson(geom)
    if gt == GeometryType.MultiPolygon:
        return _multi_polygon_to_geojson(geom)
    if gt == GeometryType.GeometryCollection:
        parts = []
        for i in range(geom.PartsLength()):
            part = geom.Parts(i)
            sub = _parse_geometry(part, GeometryType.Unknown)
            if sub is not None:
                parts.append(sub)
        return {"type": "GeometryCollection", "geometries": parts}

    raise FrbError(f"Unsupported geometry type {gt}")


def _xy_pairs(geom: Any) -> list[list[float]]:
    xy = geom.XyAsNumpy()
    if xy is None or len(xy) == 0:
        return []
    out: list[list[float]] = []
    for i in range(0, len(xy), 2):
        out.append([float(xy[i]), float(xy[i + 1])])
    return out


def _coords_to_geojson(kind: str, geom: Any, gt: int) -> dict[str, Any]:
    coords = _xy_pairs(geom)
    if kind == "Point":
        return {"type": "Point", "coordinates": coords[0] if coords else []}
    return {"type": kind, "coordinates": coords if kind == "LineString" or kind == "MultiPoint" else coords}


def _polygon_to_geojson(geom: Any) -> dict[str, Any]:
    xy = _xy_pairs(geom)
    rings: list[list[list[float]]] = []
    ends_len = geom.EndsLength()
    if ends_len == 0:
        rings.append(xy)
    else:
        prev = 0
        for i in range(ends_len):
            end = int(geom.Ends(i))
            rings.append(xy[prev:end])
            prev = end
    return {"type": "Polygon", "coordinates": rings}


def _multi_linestring_to_geojson(geom: Any) -> dict[str, Any]:
    xy = _xy_pairs(geom)
    parts: list[list[list[float]]] = []
    ends_len = geom.EndsLength()
    if ends_len == 0:
        parts.append(xy)
    else:
        prev = 0
        for i in range(ends_len):
            end = int(geom.Ends(i))
            parts.append(xy[prev:end])
            prev = end
    return {"type": "MultiLineString", "coordinates": parts}


def _multi_polygon_to_geojson(geom: Any) -> dict[str, Any]:
    polys: list[dict[str, Any]] = []
    for i in range(geom.PartsLength()):
        polys.append(_polygon_to_geojson(geom.Parts(i)))
    return {"type": "MultiPolygon", "coordinates": [p["coordinates"] for p in polys]}


# ── properties parsing (column-indexed encoding) ────────────────────


def _parse_properties(feature: Any, columns: list[dict[str, Any]]) -> dict[str, Any]:
    if not columns:
        return {}
    raw = feature.PropertiesAsNumpy()
    if raw is None or len(raw) == 0:
        return {}
    buf = bytes(raw)
    out: dict[str, Any] = {}
    offset = 0
    length = len(buf)
    while offset < length:
        (col_idx,) = struct.unpack_from("<H", buf, offset)
        offset += 2
        if col_idx >= len(columns):
            break
        col = columns[col_idx]
        col_type = col["type"]
        value, consumed = _read_value(buf, offset, col_type)
        out[col["name"]] = value
        offset += consumed
    return out


def _read_value(buf: bytes, offset: int, col_type: int) -> tuple[Any, int]:
    if col_type == ColumnType.Bool:
        return bool(buf[offset]), 1
    if col_type == ColumnType.Byte:
        return struct.unpack_from("<b", buf, offset)[0], 1
    if col_type == ColumnType.UByte:
        return struct.unpack_from("<B", buf, offset)[0], 1
    if col_type == ColumnType.Short:
        return struct.unpack_from("<h", buf, offset)[0], 2
    if col_type == ColumnType.UShort:
        return struct.unpack_from("<H", buf, offset)[0], 2
    if col_type == ColumnType.Int:
        return struct.unpack_from("<i", buf, offset)[0], 4
    if col_type == ColumnType.UInt:
        return struct.unpack_from("<I", buf, offset)[0], 4
    if col_type == ColumnType.Long:
        return struct.unpack_from("<q", buf, offset)[0], 8
    if col_type == ColumnType.ULong:
        return struct.unpack_from("<Q", buf, offset)[0], 8
    if col_type == ColumnType.Float:
        return struct.unpack_from("<f", buf, offset)[0], 4
    if col_type == ColumnType.Double:
        return struct.unpack_from("<d", buf, offset)[0], 8
    if col_type in (ColumnType.String, ColumnType.DateTime):
        (n,) = struct.unpack_from("<I", buf, offset)
        text = buf[offset + 4 : offset + 4 + n].decode("utf-8")
        return text, 4 + n
    if col_type == ColumnType.Json:
        import json

        (n,) = struct.unpack_from("<I", buf, offset)
        text = buf[offset + 4 : offset + 4 + n].decode("utf-8")
        return json.loads(text), 4 + n
    if col_type == ColumnType.Binary:
        (n,) = struct.unpack_from("<I", buf, offset)
        return bytes(buf[offset + 4 : offset + 4 + n]), 4 + n
    raise FrbError(f"Unsupported column type {col_type}")


# ── helpers ─────────────────────────────────────────────────────────


def _decode(raw: bytes | None) -> str | None:
    if raw is None:
        return None
    return raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)


_ = flatbuffers  # silence "unused import" — kept for bundle integrity
