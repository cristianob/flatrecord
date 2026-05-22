# FlatRecord QGIS plugin

Open `.frb` (FlatRecord) files as native QGIS vector layers.

## What it does

1. Adds a menu entry **Vector → FlatRecord → Open .frb…** (also as a toolbar icon).
2. Opens any `.frb` file you choose, parses the directory header, and reads the features block.
3. Builds an in-memory `QgsVectorLayer` with the right geometry type and schema, and adds it to the current QGIS project.
4. Surfaces the dataset's identity strings (`name`, `title`, `description`, `timestamp`) in the QGIS log.

## Scope (v1.0.0)

Supported file modes:

| Mode | Geometry? | Links? | Behaviour |
|---|---|---|---|
| `geo` | yes | no | ✅ Features loaded as a vector layer |
| `geograph` | yes | yes | ✅ Features loaded; links not (yet) surfaced |
| `table` | no | no | ⚠️ Skipped with a warning (no geometry to display) |
| `graph` | no | yes | ⚠️ Skipped with a warning |

Supported geometry types: Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, GeometryCollection.

Property columns: every type from the FlatRecord encoding (Bool, integers, Float, Double, String, Json, DateTime, Binary). Json values are stringified for the QGIS attribute table.

The CRC32 header slot is currently read but not verified — corrupted headers will surface as parse errors at feature iteration time. Future versions will fail fast.

## Installation

QGIS loads plugins from a per-profile directory. The folder name MUST be `flatrecord` (no hyphen — it has to be a valid Python module name). Pick whichever installation method fits your situation.

### Where does QGIS look for plugins?

| OS | Default profile path |
|---|---|
| Linux | `~/.local/share/QGIS/QGIS3/profiles/default/python/plugins/` |
| macOS | `~/Library/Application Support/QGIS/QGIS3/profiles/default/python/plugins/` |
| Windows | `%APPDATA%\QGIS\QGIS3\profiles\default\python\plugins\` |

If you use a non-default QGIS profile, replace `default` with that profile's name. To check: in QGIS, **Settings → User Profiles → Open Active Profile Folder**.

### Method A — Symlink (recommended for local development)

Keeps the plugin pointed at this repo so any edit is picked up on QGIS restart.

```bash
# Linux
ln -s "$(pwd)/plugins/flatrecord" \
      "$HOME/.local/share/QGIS/QGIS3/profiles/default/python/plugins/flatrecord"

# macOS
ln -s "$(pwd)/plugins/flatrecord" \
      "$HOME/Library/Application Support/QGIS/QGIS3/profiles/default/python/plugins/flatrecord"

# Windows (PowerShell, as administrator — symlinks need elevation)
New-Item -ItemType SymbolicLink `
  -Path "$env:APPDATA\QGIS\QGIS3\profiles\default\python\plugins\flatrecord" `
  -Target "$PWD\plugins\flatrecord"
```

### Method B — Copy (snapshot install)

Independent of the repo. Re-copy when you want a newer version.

```bash
# Linux / macOS
cp -R plugins/flatrecord \
   "$HOME/.local/share/QGIS/QGIS3/profiles/default/python/plugins/"

# Windows (PowerShell)
Copy-Item -Recurse plugins\flatrecord `
  "$env:APPDATA\QGIS\QGIS3\profiles\default\python\plugins\"
```

### Method C — Install from ZIP via QGIS Plugin Manager

Useful when you want to share the plugin without giving someone the whole repo.

1. Create the zip:
   ```bash
   cd plugins && zip -r flatrecord.zip flatrecord/
   ```
2. In QGIS: **Plugins → Manage and Install Plugins → Install from ZIP** → select `flatrecord.zip`.

### After any install method

1. Restart QGIS (or open Plugin Manager and toggle "Reload" if you have the Plugin Reloader plugin installed).
2. **Plugins → Manage and Install Plugins → Installed** tab → search "FlatRecord" → check the box to enable.
3. New entry should appear under **Vector → FlatRecord → Open .frb…** plus a toolbar icon.

### Verifying the install worked

Quick smoke from outside QGIS first (the reader has no Qt dependency):

```bash
python3 plugins/flatrecord/test_reader.py --self-test
```

You should see 8 fixtures parse cleanly, each printing `iter_features yielded N record(s)`.

Inside QGIS:

1. **Plugins → FlatRecord → Open .frb…**
2. Pick `test/data/cities-network.frb` (or any `geo`/`geograph` fixture from the repo).
3. A vector layer named after the file should appear in the Layers panel.
4. Check **View → Panels → Log Messages** → **FlatRecord** tab to see the dataset metadata (name, title, description, timestamp).

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Plugin doesn't appear in Plugin Manager | Folder name wrong | Folder MUST be named `flatrecord` (no hyphen) and live directly under `…/python/plugins/` |
| "Couldn't load plugin" on enable | Missing `flatbuffers` Python package | QGIS 3.x ships it; if missing, `pip install flatbuffers` into the QGIS Python (Settings → Options → Python Console for the path) |
| Vector menu shows nothing | Plugin loaded but `initGui` failed | Check **View → Panels → Log Messages → Plugins** for a Python traceback |
| Parse error on a real file | `.frb` was written by a different major version | Check `magic[3]` — currently `0x01`. Files from other tools may not be FlatRecord v1 |

## Dependencies

The plugin depends on the `flatbuffers` Python package, which ships with QGIS 3.x by default. No additional packages required.

The auto-generated FlatBuffer Python bindings live under `flatrecord_fb/` and are bundled with the plugin.

## Architecture

```
plugins/flatrecord/
├── metadata.txt              # QGIS plugin metadata
├── __init__.py               # entry point: classFactory()
├── flatrecord_plugin.py      # plugin class — menu wiring, layer construction
├── frb_reader.py             # pure-Python .frb reader (no Node / npm dep)
├── flatrecord_fb/            # auto-generated FlatBuffer bindings
│   └── FlatGeobuf/
│       ├── Header.py
│       ├── Feature.py
│       ├── Geometry.py
│       └── ...
└── README.md                 # this file
```

`frb_reader.FrbFile` exposes a small public surface:

```python
from frb_reader import FrbFile

frb = FrbFile.from_path("airports.frb")
print(frb.name, frb.title, frb.features_count, frb.geometry_type)

for geometry, properties in frb.iter_features():
    # geometry is a GeoJSON-shaped dict (or None on tabular files)
    # properties is a plain {column_name: value} dict
    ...
```

You can also use `frb_reader.py` standalone (outside QGIS) to inspect `.frb` files — it has no Qt / QGIS imports.

## Roadmap

- **v1.1** — surface links from `geograph` files as a second vector layer (with LineString geometries between feature pairs)
- **v1.2** — verify the header CRC32 at open time and surface corrupted files in the QGIS log
- **v1.3** — table / graph mode: load tabular files as a non-spatial QGIS table layer
- **v1.4** — write support (export current QGIS layer to `.frb`)
