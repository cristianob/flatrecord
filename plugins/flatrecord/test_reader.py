#!/usr/bin/env python3
"""Standalone smoke test for the pure-Python FlatRecord reader.

Runs the same parsing code the QGIS plugin uses, but with no Qt /
QGIS dependency — only `flatbuffers`. Useful for quickly verifying a
`.frb` file from the command line.

Usage:

    python test_reader.py path/to/file.frb              # one file
    python test_reader.py path/to/dir                    # all .frb under a dir
    python test_reader.py --self-test                    # parse every test/data/*.frb
                                                          # in the parent repo

The plugin uses relative imports (required by QGIS), so this script
sets up the package context manually before importing `frb_reader`.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path


def _load_reader() -> type:
    """Load `FrbFile` from frb_reader.py with proper package context."""
    plugin_dir = Path(__file__).resolve().parent
    package_name = "_flatrecord_test_pkg"

    # Register the parent package so the reader's relative imports work.
    spec = importlib.util.spec_from_file_location(
        package_name,
        plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load plugin package at {plugin_dir}")
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[package_name] = pkg

    # Same for the fbs sub-packages — Python needs them registered
    # before relative imports can resolve.
    for sub in [
        "flatrecord_fb",
        "flatrecord_fb/FlatGeobuf",
    ]:
        sub_name = f"{package_name}.{sub.replace('/', '.')}"
        sub_path = plugin_dir / sub / "__init__.py"
        sub_spec = importlib.util.spec_from_file_location(
            sub_name, sub_path, submodule_search_locations=[str(plugin_dir / sub)],
        )
        sub_pkg = importlib.util.module_from_spec(sub_spec)
        sys.modules[sub_name] = sub_pkg
        sub_spec.loader.exec_module(sub_pkg)

    reader_spec = importlib.util.spec_from_file_location(
        f"{package_name}.frb_reader",
        plugin_dir / "frb_reader.py",
    )
    reader = importlib.util.module_from_spec(reader_spec)
    sys.modules[f"{package_name}.frb_reader"] = reader
    reader_spec.loader.exec_module(reader)
    return reader.FrbFile


def inspect_file(FrbFile, path: Path) -> None:
    print(f"\n=== {path} ===")
    try:
        frb = FrbFile.from_path(str(path))
    except Exception as exc:  # noqa: BLE001
        print(f"  ERROR: {exc}")
        return

    print(f"  name={frb.name!r}")
    print(f"  title={frb.title!r}")
    print(f"  description={frb.description!r}")
    print(f"  timestamp_ms={frb.timestamp_ms}")
    print(f"  features_count={frb.features_count}")
    print(f"  geometry_type={frb.geometry_type}")
    print(f"  has_geometry={frb.has_geometry}")
    print(f"  envelope={frb.envelope}")
    print(f"  columns={[(c['name'], c['type']) for c in frb.columns]}")

    n = 0
    samples = []
    for geom, props in frb.iter_features():
        if n < 3:
            samples.append((geom, props))
        n += 1
    print(f"  iter_features yielded {n} record(s) (expected {frb.features_count})")
    for i, (geom, props) in enumerate(samples, 1):
        gtype = (geom or {}).get("type", "—")
        print(f"    sample {i}: geom={gtype}  props={props}")
    if n != frb.features_count:
        print(f"  WARN: feature count mismatch")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="A .frb file or a directory containing .frb files",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run against every .frb under ../../test/data of the repo",
    )
    args = parser.parse_args()

    FrbFile = _load_reader()

    paths: list[Path] = []
    if args.self_test:
        repo_root = Path(__file__).resolve().parents[2]
        data_dir = repo_root / "test" / "data"
        if not data_dir.exists():
            print(f"--self-test: data dir not found at {data_dir}", file=sys.stderr)
            return 2
        paths.extend(sorted(data_dir.glob("*.frb")))

    for raw in args.paths:
        if raw.is_dir():
            paths.extend(sorted(raw.glob("*.frb")))
        elif raw.exists():
            paths.append(raw)
        else:
            print(f"Not found: {raw}", file=sys.stderr)
            return 2

    if not paths:
        parser.print_help()
        return 1

    for p in paths:
        inspect_file(FrbFile, p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
