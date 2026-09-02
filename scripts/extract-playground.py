"""Extract the surveyed layers the model does not use yet, as one sandbox file.

  drainage_polygon              -> chamber outlines, 1,012 with real WIDTH and
                                   LENGTH. The pipe model assumes a 1 m2 shaft
                                   for every one of its 6,903 manholes, and
                                   shaft area is what decides how fast a node
                                   surcharges and spills
  ทิศทางการไหลของน้ำ            -> surveyed flow direction, 1,842 runs. The
                                   model infers direction from geometry today
  พื้นที่เสี่ยงต่อการเกิดน้ำท่วม -> 17 polygons of where the city says it
                                   floods - the first independent spatial
                                   check the project has had

All three go into public/data/playground.geojson with a `kind` property, so
the map can offer them behind one toggle while we decide which of them earn a
permanent place.

Usage:
  python scripts/extract-playground.py [path/to/Data_Pattaya.gdb]
"""
import json
import math
import sys
import warnings
from pathlib import Path

warnings.filterwarnings('ignore')

import numpy as np
import pyogrio.raw as raw
from pyproj import Transformer
from shapely import from_wkb

GDB = sys.argv[1] if len(sys.argv) > 1 else r'D:\Code\_SCS\data\GIS\1.GIS_Geodatabase\Data_Pattaya.gdb'
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data'
WGS = Transformer.from_crs('EPSG:32647', 'EPSG:4326', always_xy=True)

# layer name, kind, and the fields worth carrying into a popup
LAYERS = [
    ('drainage_polygon', 'chamber',
     [('MH_COVER', 'cover'), ('TYPE_DRAIN', 'type'), ('WIDTH', 'width_m'), ('LENGTH', 'length_m')]),
    ('ทิศทางการไหลของน้ำ', 'flow',
     [('TYPE', 'type')]),
    ('พื้นที่เสี่ยงต่อการเกิดน้ำท่วม', 'flood-risk',
     [('AREA', 'area')]),
]


def clean(value):
    """Drop nulls and NaNs, trim floats - the same rule extract-drainage uses."""
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode('utf-8', 'replace')
    if isinstance(value, str):
        value = value.strip()
        return value or None
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return None if math.isnan(f) else round(f, 3)
    if isinstance(value, (np.integer, int)):
        return int(value)
    return value


def ring(coords):
    lon, lat = WGS.transform([c[0] for c in coords], [c[1] for c in coords])
    return [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)]


def geometry(g):
    """Any shapely geometry as GeoJSON in WGS84, or None if it carries nothing."""
    kind = g.geom_type
    if kind == 'Polygon':
        return {'type': 'Polygon',
                'coordinates': [ring(g.exterior.coords)] + [ring(i.coords) for i in g.interiors]}
    if kind == 'MultiPolygon':
        return {'type': 'MultiPolygon',
                'coordinates': [[ring(p.exterior.coords)] + [ring(i.coords) for i in p.interiors]
                                for p in g.geoms]}
    if kind == 'LineString':
        return {'type': 'LineString', 'coordinates': ring(g.coords)}
    if kind == 'MultiLineString':
        return {'type': 'MultiLineString', 'coordinates': [ring(p.coords) for p in g.geoms]}
    if kind == 'Point':
        return {'type': 'Point', 'coordinates': ring(g.coords)[0]}
    return None


def extract(name, kind, spec):
    meta, _fids, geom, arrays = raw.read(GDB, layer=name)
    fields = {f: a for f, a in zip(meta['fields'], arrays)}
    features = []
    for index, blob in enumerate(geom):
        g = from_wkb(blob) if blob is not None else None
        if g is None or g.is_empty:
            continue
        shape = geometry(g)
        if shape is None:
            continue
        props = {'kind': kind}
        for src, key in spec:
            if src not in fields:
                continue
            value = clean(fields[src][index])
            if value is not None:
                props[key] = value
        features.append({'type': 'Feature', 'id': f'{kind}-{index}',
                         'properties': props, 'geometry': shape})
    print(f'  {name}: {len(features):,} features as "{kind}"')
    return features


if not Path(GDB).exists():
    sys.exit(f'geodatabase not found: {GDB}\nPass its path as the first argument.')

print(f'reading {GDB}')
collected = []
for name, kind, spec in LAYERS:
    try:
        collected += extract(name, kind, spec)
    except Exception as error:  # a layer the export happens not to carry
        print(f'  {name}: skipped ({type(error).__name__}: {error})')

# Which flow-direction runs actually sit on a surveyed drain. The survey drew
# some of them along the street instead, and an arrow there reads as drainage
# that is not present - so those are marked and the map arrows only the rest.
FLOW_TO_PIPE_M = 15.0
CELL_DEG = 0.001  # ~110 m, comfortably wider than the search radius


def mark_on_pipe(features):
    pipes_path = OUT / 'drainage-pipes.geojson'
    if not pipes_path.exists():
        print('  drainage-pipes.geojson not found; leaving flow runs unmarked')
        return
    with pipes_path.open(encoding='utf-8') as stream:
        pipes = json.load(stream)['features']

    buckets = {}
    for feature in pipes:
        ptype = (feature.get('properties') or {}).get('type')
        for lng, lat in feature['geometry']['coordinates']:
            buckets.setdefault((int(lat / CELL_DEG), int(lng / CELL_DEG)), []).append((lat, lng, ptype))

    on = 0
    flow = [f for f in features if f['properties']['kind'] == 'flow']
    for feature in flow:
        coords = feature['geometry']['coordinates']
        if feature['geometry']['type'] == 'MultiLineString':
            coords = coords[0]
        if not coords:
            continue
        lng, lat = coords[len(coords) // 2]
        metres_per_deg_lng = 111320 * math.cos(math.radians(lat))
        best = float('inf')
        best_type = None
        row, col = int(lat / CELL_DEG), int(lng / CELL_DEG)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                for plat, plng, ptype in buckets.get((row + dr, col + dc), ()):
                    d = math.hypot((plat - lat) * 110574, (plng - lng) * metres_per_deg_lng)
                    if d < best:
                        best = d
                        best_type = ptype
        near = best <= FLOW_TO_PIPE_M
        feature['properties']['onPipe'] = bool(near)
        feature['properties']['toPipeM'] = round(best, 1) if best < 1e6 else None
        # The pipe the arrow sits on, so the map can paint the arrow the same
        # colour as the run beneath it.
        if near and best_type:
            feature['properties']['pipeType'] = best_type
        on += near
    print(f'  flow runs on a surveyed drain: {on:,} of {len(flow):,} '
          f'(within {FLOW_TO_PIPE_M:.0f} m)')


mark_on_pipe(collected)

OUT.mkdir(parents=True, exist_ok=True)
path = OUT / 'playground.geojson'
with path.open('w', encoding='utf-8') as stream:
    json.dump({'type': 'FeatureCollection', 'features': collected}, stream,
              ensure_ascii=False, separators=(',', ':'))
print(f'playground.geojson: {len(collected):,} features, {path.stat().st_size / 1e6:.2f} MB')
