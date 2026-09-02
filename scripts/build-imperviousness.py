"""How much of each street junction's catchment sheds water, from land use.

Three coats, each source used where it is strong:

  base    LU_CBI_2567 (LDD land-use survey, 2567) - classifies every square
          metre of the province, but coarsely: a city park is absorbed into
          "City, Town, Commercial"
  detail  OSM green ground (chonburi-landcover.geojson, kind=green) - may
          only LOWER imperviousness where a mapped park/pitch/wood stands
  top     OSM buildings (kind=building) - may only RAISE it where roofs
          demonstrably crowd the corridor

OSM's silence proves nothing: an unmapped block keeps its land-use value.
That asymmetry is the whole trick - both OSM coats are incomplete, so each
is allowed to push in only the direction its presence actually evidences.

The road class (U405) is skipped when sampling: it covers every street as two
dissolved polygons, so sampling AT a junction would read "Road" everywhere
and say nothing about the yards and roofs the street collects from. The
junction takes the class of the nearest non-road polygon instead - the block
beside the street, which is what actually drains onto it.

Writes an `imperv` array (0..1, 2 dp) into chonburi-road-network.json.

Usage: python scripts/build-imperviousness.py [path/to/LU_CBI_2567.shp]
"""
import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings('ignore')

import numpy as np
import pyogrio.raw as raw
from pyproj import Transformer
from shapely import STRtree, from_wkb, points, polygons as mk_polygons
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
NETWORK_PATH = ROOT / 'public' / 'data' / 'chonburi-road-network.json'
LANDCOVER_PATH = ROOT / 'public' / 'data' / 'chonburi-landcover.geojson'
LU_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    r'D:\Code\_SCS\data\Landuse_cbi\ชลบุรี2567\การใช้ที่ดิน\LU_CBI_2567.shp')

TO_UTM = Transformer.from_crs('EPSG:4326', 'EPSG:32647', always_xy=True)

# Imperviousness by land-use class. Explicit where the class is common around
# Pattaya; the first letter's default carries everything else. U405 (road) is
# None on purpose: skipped when sampling, see the module docstring.
EXPLICIT = {
    'U101': 0.88, 'U201': 0.55, 'U300': 0.60, 'U301': 0.60, 'U405': None,
    'U502': 0.75, 'U503': 0.75, 'U601': 0.25, 'U602': 0.60, 'U603': 0.60,
    'U701': 0.08, 'M405': 0.40, 'M304': 0.20,
}
PREFIX = {'U': 0.70, 'A': 0.10, 'F': 0.05, 'M': 0.15, 'W': 0.05}

# The OSM coats' push levels and the building-density thresholds.
GREEN_IMPERV = 0.12
BUILDING_DISC_M = 30.0
DENSE_FRACTION, DENSE_IMPERV = 0.35, 0.85
BUILT_FRACTION, BUILT_IMPERV = 0.15, 0.70
NEAREST_REACH_M = 400.0


def imperv_of(code):
    code = (code or '').split('/')[0].strip()
    if code in EXPLICIT:
        return EXPLICIT[code]
    return PREFIX.get(code[:1], 0.30) if code else None


def load_landuse(bounds):
    print(f'reading land use: {LU_PATH.name}')
    meta, _fids, geom, arrays = raw.read(str(LU_PATH), bbox=bounds)
    codes = [str(v) for v in dict(zip(meta['fields'], arrays))['LU_CODE']]
    keep_geoms, keep_vals = [], []
    skipped_road = 0
    for blob, code in zip(geom, codes):
        value = imperv_of(code)
        if value is None:
            skipped_road += 1
            continue
        g = from_wkb(blob)
        if g is None or g.is_empty:
            continue
        keep_geoms.append(g)
        keep_vals.append(value)
    print(f'  {len(keep_geoms):,} polygons kept, {skipped_road:,} road polygons skipped')
    return STRtree(keep_geoms), np.array(keep_vals, dtype=np.float32)


def load_landcover():
    if not LANDCOVER_PATH.exists():
        print('no chonburi-landcover.geojson - base coat only (run npm run fetch:landcover)')
        return None, None, None
    data = json.loads(LANDCOVER_PATH.read_text(encoding='utf-8'))
    green, bld, bld_area = [], [], []
    for feature in data.get('features', []):
        props = feature.get('properties', {})
        try:
            g = shape(feature['geometry'])
        except Exception:
            continue
        if g.is_empty:
            continue
        # into UTM, so distances below are metres
        xs, ys = TO_UTM.transform(*zip(*g.exterior.coords))
        g = mk_polygons(np.column_stack([xs, ys]))
        if props.get('kind') == 'green':
            green.append(g)
        elif props.get('kind') == 'building':
            bld.append(g)
            bld_area.append(props.get('areaM2') or g.area)
    print(f'landcover: {len(green):,} green polygons, {len(bld):,} buildings')
    return (STRtree(green) if green else None,
            STRtree(bld) if bld else None,
            np.array(bld_area, dtype=np.float32))


def main():
    network = json.loads(NETWORK_PATH.read_text(encoding='utf-8'))
    lat = np.asarray(network['lat'], dtype=np.float64)
    lng = np.asarray(network['lng'], dtype=np.float64)
    n = len(lat)
    x, y = TO_UTM.transform(lng, lat)
    pts = points(np.column_stack([x, y]))
    pad = 500
    bounds = (x.min() - pad, y.min() - pad, x.max() + pad, y.max() + pad)

    tree, values = load_landuse(bounds)
    imperv = np.full(n, -1.0, dtype=np.float32)

    # Base coat: the class the junction stands in (roads excluded)...
    inside_pt, inside_poly = tree.query(pts, predicate='within')
    imperv[inside_pt] = values[inside_poly]
    # ...and the nearest block for the road-covered rest.
    missing = np.flatnonzero(imperv < 0)
    if len(missing):
        near = tree.query_nearest(pts[missing], max_distance=NEAREST_REACH_M,
                                  all_matches=False)
        imperv[missing[near[0]]] = values[near[1]]
    still = np.flatnonzero(imperv < 0)
    imperv[still] = 0.30
    print(f'base coat: {n - len(missing):,} in a block, {len(missing) - len(still):,} '
          f'from the nearest block, {len(still):,} fell back to 0.30')

    green_tree, bld_tree, bld_area = load_landcover()

    if green_tree is not None:
        g_pt, _ = green_tree.query(pts, predicate='within')
        lowered = np.unique(g_pt)
        imperv[lowered] = np.minimum(imperv[lowered], GREEN_IMPERV)
        print(f'green coat: {len(lowered):,} junctions under mapped green ground')

    if bld_tree is not None and len(bld_area):
        from shapely import buffer
        discs = buffer(pts, BUILDING_DISC_M, quad_segs=4)
        d_pt, d_bld = bld_tree.query(discs, predicate='intersects')
        cover = np.zeros(n, dtype=np.float32)
        # Whole building areas against the disc: an approximation that leans
        # high, which suits a coat that may only raise.
        np.add.at(cover, d_pt, bld_area[d_bld])
        frac = cover / (np.pi * BUILDING_DISC_M ** 2)
        dense = frac >= DENSE_FRACTION
        built = (frac >= BUILT_FRACTION) & ~dense
        imperv[dense] = np.maximum(imperv[dense], DENSE_IMPERV)
        imperv[built] = np.maximum(imperv[built], BUILT_IMPERV)
        print(f'building coat: {int(dense.sum()):,} raised to {DENSE_IMPERV}, '
              f'{int(built.sum()):,} to {BUILT_IMPERV}')

    network['imperv'] = [round(float(v), 2) for v in imperv]
    NETWORK_PATH.write_text(json.dumps(network, separators=(',', ':')), encoding='utf-8')

    hist, edges = np.histogram(imperv, bins=[0, .1, .2, .4, .6, .8, .95, 1.001])
    print('\nimperviousness across the network:')
    for count, lo, hi in zip(hist, edges[:-1], edges[1:]):
        print(f'  {lo:.2f}-{hi:.2f}  {count:>8,}  {100 * count / n:5.1f}%')
    print(f'\nwrote imperv for {n:,} junctions into {NETWORK_PATH.name} '
          f'({NETWORK_PATH.stat().st_size / 1e6:.1f} MB)')


main()
