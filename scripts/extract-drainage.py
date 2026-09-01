"""Extract Pattaya's surveyed drainage network from the city's File
Geodatabase to the compact WGS84 GeoJSON the map loads.

  drainage_line  -> public/data/drainage-pipes.geojson   gravity drains + culverts
  drainage_point -> public/data/drainage-covers.geojson  manholes / inlet covers
  pumpstation    -> public/data/drainage-pumps.geojson   pump stations (name only)
  ความลึกหลังท่อระบายน้ำ -> public/data/drainage-depths.geojson  depth to the back
                                                          of the drain, 9k points
  ผังบ่อสูบน้ำ_polygon   -> public/data/drainage-sumps.geojson   pump sump footprints

The three files are also the input of scripts/build-drainage-model.py, which
turns them into the pipe graph the water simulation runs on.

The geodatabase (Data_Pattaya.gdb, feature datasets `drain` / `water_pipe`)
is the municipal utility survey, in UTM Zone 47N; this reprojects to WGS84,
keeps only the fields a popup shows, drops empty values and trims coordinate
precision. Thai attribute values are kept verbatim - they are the datum, and
the map glosses them to English at display time.

Usage:
  python scripts/extract-drainage.py [path/to/Data_Pattaya.gdb]

Needs geopandas' GDAL engine, which the OpenFileGDB driver rides on:
  pip install geopandas pyogrio
The .gdb itself is not in this repo (it is large and not ours to publish);
point the script at wherever the city GIS export lives.
"""
import json
import math
import sys
import warnings
from pathlib import Path

warnings.filterwarnings('ignore')

import numpy as np
import pyogrio.raw as raw
from shapely import from_wkb, get_coordinates, get_parts, get_type_id
from pyproj import Transformer

DEFAULT_GDB = r'D:\Code\_SCS\data\1.GIS_Geodatabase\Data_Pattaya.gdb'
GDB = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GDB
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data'
WGS = Transformer.from_crs('EPSG:32647', 'EPSG:4326', always_xy=True)

# field -> output key, in the order a popup should read
PIPE_FIELDS = [
    ('RC_NAME', 'road'),
    ('DRAIN_TYPE', 'type'),
    ('DRAIN_SIZE', 'size'),
    ('DRAIN_MATL', 'material'),
    ('Shape_Length', 'length_m'),
]
COVER_FIELDS = [
    ('RC_NAME', 'road'),
    ('MH_USE', 'use'),
    ('MH_COVER', 'cover'),
    ('DEEP_MH', 'depth_m'),
    ('WIDTH_COVER', 'cover_w'),
    ('LENGTH_COVER', 'cover_l'),
    ('DIA_COVER', 'cover_dia'),
    ('WIDTH_MH', 'mh_w'),
    ('LENGTH_MH', 'mh_l'),
    ('SOURCE', 'source'),
    ('ID_SUV', 'id'),
]
# The survey records a pump station's name and nothing else - no rated flow,
# no start level. Those are model settings for now (see config.js).
PUMP_FIELDS = [
    ('STA_NAME', 'name'),
]
# How deep the drain sits below the ground it runs under. The only depth
# measurement the survey carries for the pipes themselves, so it is what the
# pipe model's invert levels are built from where a manhole depth is missing.
DEPTH_FIELDS = [
    ('DEPTH_M', 'depth_m'),
]


def clean(value):
    """A JSON-safe, trimmed value, or None if it is effectively empty."""
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        value = value.decode('utf-8', 'replace')
    if isinstance(value, str):
        return value.strip().replace('\x00', '') or None
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return None if math.isnan(f) else round(f, 3)
    if isinstance(value, (np.integer, int)):
        return int(value)
    return value


def read(name):
    meta, _fids, geom, arrays = raw.read(GDB, layer=name)
    return geom, {fname: arr for fname, arr in zip(meta['fields'], arrays)}


def to_lonlat(xs, ys):
    lon, lat = WGS.transform(xs, ys)
    return [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)]


def size_in_metres(value):
    """DRAIN_SIZE, normalised to metres.

    The field is written as text and mixes units: most runs are metres
    ("0.80", "1.50x1.50") but a handful - the HDPE pressure mains among them -
    were entered in millimetres ("315", "2200"). No drain in this city is
    10 m across, so anything reading past that is millimetres. Box culverts
    keep their WxH form, each side converted on its own.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    def one(part):
        try:
            metres = float(part)
        except ValueError:
            return part.strip()
        if metres > 10:
            metres /= 1000
        # Trailing zeros off, but keep it looking like a measurement.
        return f'{metres:g}'

    for mark in ('x', 'X', '×'):
        if mark in text:
            return 'x'.join(one(part) for part in text.split(mark))
    return one(text)


def properties(fields, index, spec):
    props = {}
    for src, key in spec:
        if src not in fields:
            continue
        val = clean(fields[src][index])
        if val is None:
            continue
        if key == 'length_m' and isinstance(val, float):
            val = round(val, 1)
        if key == 'size':
            val = size_in_metres(val)
        props[key] = val
    return props


def extract_pipes():
    geom, fields = read('drainage_line')
    geoms = from_wkb(geom)
    features = []
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        props = properties(fields, i, PIPE_FIELDS)
        # One feature per part, so each drawn line is one clickable pipe run.
        parts = get_parts(g) if get_type_id(g) == 5 else [g]
        for part in parts:
            coords = get_coordinates(part)
            if len(coords) < 2:
                continue
            features.append({
                'type': 'Feature',
                'properties': props,
                'geometry': {'type': 'LineString', 'coordinates': to_lonlat(coords[:, 0], coords[:, 1])},
            })
    return features


def extract_covers():
    geom, fields = read('drainage_point')
    geoms = from_wkb(geom)
    coords = get_coordinates(geoms)
    lonlat = to_lonlat(coords[:, 0], coords[:, 1])
    features = []
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        features.append({
            'type': 'Feature',
            'properties': properties(fields, i, COVER_FIELDS),
            'geometry': {'type': 'Point', 'coordinates': lonlat[i]},
        })
    return features


def extract_pumps():
    geom, fields = read('pumpstation')
    geoms = from_wkb(geom)
    features = []
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        coords = get_coordinates(g)
        features.append({
            'type': 'Feature',
            'properties': properties(fields, i, PUMP_FIELDS),
            'geometry': {'type': 'Point', 'coordinates': to_lonlat(coords[:1, 0], coords[:1, 1])[0]},
        })
    return features


def extract_points(layer, spec):
    """Any point layer, as points with the fields `spec` names."""
    geom, fields = read(layer)
    geoms = from_wkb(geom)
    features = []
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        coords = get_coordinates(g)
        if len(coords) == 0:
            continue
        props = properties(fields, i, spec)
        if not props:
            continue
        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': {'type': 'Point', 'coordinates': to_lonlat(coords[:1, 0], coords[:1, 1])[0]},
        })
    return features


def extract_sumps():
    """Pump sump footprints, as their centre and their plan area. The area is
    what a pump's sump can actually hold water over; the model otherwise
    assumes a one-square-metre shaft like any other manhole."""
    geom, fields = read('ผังบ่อสูบน้ำ_polygon')
    geoms = from_wkb(geom)
    features = []
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        centre = g.centroid
        props = {'area_m2': round(float(g.area), 1)}
        name = clean(fields['RefName'][i]) if 'RefName' in fields else None
        if name:
            props['name'] = name
        features.append({
            'type': 'Feature',
            'properties': props,
            'geometry': {
                'type': 'Point',
                'coordinates': to_lonlat([centre.x], [centre.y])[0],
            },
        })
    return features


def write(features, name):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    # Streamed to the file rather than built as one string first: the 80k
    # covers make a 19 MB document, and holding it whole beside the parsed
    # geometry ran out of memory.
    with path.open('w', encoding='utf-8') as stream:
        json.dump({'type': 'FeatureCollection', 'features': features}, stream,
                  ensure_ascii=False, separators=(',', ':'))
    print(f'{name}: {len(features):,} features, {path.stat().st_size / 1e6:.2f} MB')


if not Path(GDB).exists():
    sys.exit(f'geodatabase not found: {GDB}\nPass its path as the first argument.')

write(extract_pipes(), 'drainage-pipes.geojson')
write(extract_covers(), 'drainage-covers.geojson')
write(extract_pumps(), 'drainage-pumps.geojson')
write(extract_points('ความลึกหลังท่อระบายน้ำ', DEPTH_FIELDS), 'drainage-depths.geojson')
write(extract_sumps(), 'drainage-sumps.geojson')
