"""Turns the surveyed drainage GeoJSON into the pipe graph the simulation runs.

    drainage-pipes.geojson   (4.5k drain runs: size, type, material)
    drainage-covers.geojson  (80k covers: which are grated inlets, grate size,
                              manhole size and depth)
    drainage-pumps.geojson   (64 pump stations)
    chonburi-road-network.json (street junctions with DEM heights)
        |
        v
    public/data/drainage-model.json

What the survey does NOT record is filled in with stated assumptions, each
behind an environment variable so better data can replace it later:

  * pipe ends are snapped together within DRAIN_SNAP_M to make junctions, and
    a run ending on the side of another run becomes a T-junction;
  * ground level at a junction is the nearest street junction's height, and
    the invert is measured from it where the survey says how deep the drain
    runs - a manhole depth (DEEP_MH, 10.6k covers) first, else the depth to
    the back of the drain (9k points) plus the pipe height - falling back to
    PIPE_COVER_DEPTH_M where neither is near. The survey carries no levelled
    inverts, so none of these are true invert levels;
  * a run end within DRAIN_SEA_OUTFALL_M of the coast is a sea outfall (its
    water level is the tide), one within DRAIN_CANAL_OUTFALL_M of an OSM
    waterway is a canal outfall (free discharge), and a network with neither
    gets its lowest dead end declared a free outfall so it can drain at all;
  * every street junction the drain runs under gets an inlet into it, sized
    from the grated covers beside it where the survey recorded any and from a
    default kerb opening where it did not. The survey classes only 3,800 of
    its 79,929 covers as gratings, which would leave one inlet per seventeen
    street junctions - and the city's own road sensors show streets shedding
    a metre of water in about a quarter of an hour, which one inlet per
    seventeen junctions cannot do and one opening per junction can. A Thai
    street drain is a covered trench along the kerb, taking water all along
    itself, not at a handful of gratings.

Run: npm run build:drainage   (after build:roads, whose node numbering it uses)
"""
import json
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
PIPES_PATH = DATA / 'drainage-pipes.geojson'
COVERS_PATH = DATA / 'drainage-covers.geojson'
PUMPS_PATH = DATA / 'drainage-pumps.geojson'
DEPTHS_PATH = DATA / 'drainage-depths.geojson'
SUMPS_PATH = DATA / 'drainage-sumps.geojson'
PLAYGROUND_PATH = DATA / 'playground.geojson'
ROADS_PATH = DATA / 'chonburi-road-network.json'
RIVERS_PATH = DATA / 'chonburi-rivers.geojson'
BOUNDARY_PATH = ROOT / 'data' / 'chonburi.geojson'
OUT_PATH = DATA / 'drainage-model.json'

SNAP_M = float(os.environ.get('DRAIN_SNAP_M', 3.0))
COVER_DEPTH_M = float(os.environ.get('PIPE_COVER_DEPTH_M', 0.6))
SEA_OUTFALL_M = float(os.environ.get('DRAIN_SEA_OUTFALL_M', 250.0))
CANAL_OUTFALL_M = float(os.environ.get('DRAIN_CANAL_OUTFALL_M', 40.0))
INLET_TO_PIPE_M = 40.0
INLET_TO_STREET_M = 25.0
# A street junction this close to a drain junction sheds into it.
STREET_TO_PIPE_M = float(os.environ.get('DRAIN_STREET_INLET_M', 35.0))
# The kerb opening assumed at a junction the survey recorded no grating for:
# open area in m2 and wetted perimeter in m. Calibrated against the road
# sensors - see the note at the top - and overridable while that is checked.
KERB_INLET_AREA_M2 = float(os.environ.get('KERB_INLET_AREA_M2', 0.30))
KERB_INLET_PERIMETER_M = float(os.environ.get('KERB_INLET_PERIMETER_M', 2.4))
NODE_TO_STREET_M = 60.0
PUMP_TO_PIPE_M = 80.0
MANHOLE_TO_PIPE_M = 5.0
# A surveyed chamber outline (drainage_polygon) sizes the junction this near
# to it. Looser than the cover radius: a chamber is matched by the centroid of
# a polygon several metres long, not by a point dropped on the lid.
CHAMBER_TO_PIPE_M = 10.0
# The chamber plan areas worth believing. Below this it is a lid, not a
# chamber; above it the feature is a basin or a long channel run, and giving
# one junction that much storage would quietly stop it ever surcharging.
CHAMBER_MIN_M2 = 0.3
CHAMBER_MAX_M2 = 60.0
# How far a junction may look for a measured depth before it falls back to
# the assumed cover. A manhole depth is the better measurement - it is the
# depth of the chamber the pipes meet in - so it is looked for first, and
# closer, than the depth to the back of the drain.
MANHOLE_DEPTH_SEARCH_M = 15.0
DRAIN_DEPTH_SEARCH_M = 30.0
# A pump's sump footprint counts as its shaft area if it is this near.
SUMP_TO_PUMP_M = 120.0
# A drain is laid to fall towards its outfall, deepening as it goes; it does
# not follow the ground. Measured depths give the depth at a point, not that
# fall, so on a flat city they leave a pipe with nowhere to send its water -
# 22% of the runs came out flatter than 1 in 1000. This is the least fall a
# run is given, working back from its outfall, and it is only imposed where
# the pipe can still be buried.
MIN_GRADE = float(os.environ.get('DRAIN_MIN_GRADE', 0.0015))
MIN_COVER_M = 0.15

# Pump station capacities, from the city's flood-response plan
# (004.การรับมือปัญหาน้ำท่วมเมืองพัทยา, สำนักช่างสุขาภิบาล, slides 32-37).
# Matched to the survey's station names by the pattern given; stations the
# plan does not list keep the configured default at run time. The survey
# records names only, so this is the only source of rated flows there is.
#   Sump 1-6  the stormwater sumps along Sukhumvit and the railway road,
#             pumping to the 100,000 m3 retention pond (แก้มลิง)
#   PS7       the beach pumping station by Walking Street, 2 x 18,000 m3/h
#   PSK       Khlong Pluk Plub, 3 x 9,000 m3/h
#   Khao Noi  the railway-road flood pump station, 6 x 3,600 m3/h
PUMP_RATES_M3S = [
    (r'SUMP\s*1\b', 1.65),
    (r'SUMP\s*2\b', 0.99),
    (r'SUMP\s*3\b', 0.99),
    (r'SUMP\s*4\b', 1.98),
    (r'SUMP\s*5\b', 3.30),
    (r'SUMP\s*6\b', 3.30),
    (r'\bPS\s*7\b', 2 * 18000 / 3600),
    (r'ปึกพลับ|ปลึกพลับ|\bPSK\b', 3 * 9000 / 3600),
    (r'เขาน้อย', 6 * 3600 / 3600),
]


def rated_flow(name):
    """The plan's rated flow for a station name, or None."""
    text = str(name or '')
    for pattern, rate in PUMP_RATES_M3S:
        if re.search(pattern, text, re.I):
            return rate
    return None


# Stations the plan describes that the survey's pump layer does not carry.
# The plan gives no coordinates, only a description: Khao Noi is "on the
# railway road" (slide 37), and Sump 3 sits on the same road "near the Khao
# Noi junction", so it is placed on the railway road just south of Sump 3.
# Move it when the station is surveyed; the marker says it is approximate.
EXTRA_PUMPS = [
    {'name': 'สถานีสูบน้ำเขาน้อย', 'lng': 100.9031, 'lat': 12.9220},
]
GRATE_OPEN_FRACTION = 0.5
DEFAULT_GRATE_M = (0.4, 0.6)
DEFAULT_SHAFT_M2 = 1.0
DEFAULT_SIZE_M = 0.6
INLET_MATERIALS = {'เหล็กตะแกรง', 'ฝาตะแกรงรับน้ำ'}
MANNING_N = {'HDPE': 0.011, 'PVC': 0.011, 'concrete': 0.013}

SHAPE_CIRCULAR = 0
SHAPE_BOX = 1


# --- geometry helpers --------------------------------------------------------

def load_json(path, required=True):
    if not path.exists():
        if required:
            sys.exit(f'missing {path}')
        return None
    return json.loads(path.read_text(encoding='utf-8'))


class LocalFrame:
    """Lon/lat to metres east/north of an origin. Good to well under a metre
    across the 30 km the drainage survey spans."""

    def __init__(self, lat0, lng0):
        self.lat0 = lat0
        self.lng0 = lng0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110574.0

    def to_xy(self, lng, lat):
        return (lng - self.lng0) * self.kx, (lat - self.lat0) * self.ky


class PointIndex:
    """Bucketed points for nearest-neighbour queries within a radius."""

    def __init__(self, xs, ys, cell):
        self.xs = xs
        self.ys = ys
        self.cell = cell
        self.buckets = {}
        for i, (x, y) in enumerate(zip(xs, ys)):
            self.buckets.setdefault((int(x // cell), int(y // cell)), []).append(i)

    def nearest(self, x, y, radius):
        reach = int(math.ceil(radius / self.cell))
        cx, cy = int(x // self.cell), int(y // self.cell)
        best, best_d = -1, radius
        for i in range(cx - reach, cx + reach + 1):
            for j in range(cy - reach, cy + reach + 1):
                for k in self.buckets.get((i, j), ()):
                    d = math.hypot(self.xs[k] - x, self.ys[k] - y)
                    if d < best_d:
                        best, best_d = k, d
        return best, best_d


def segment_distances(px, py, ax, ay, bx, by):
    """Distance from one point to many segments (numpy arrays a, b)."""
    dx = bx - ax
    dy = by - ay
    length2 = dx * dx + dy * dy
    safe = np.where(length2 > 0, length2, 1.0)
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / safe, 0.0, 1.0)
    qx = ax + t * dx
    qy = ay + t * dy
    return np.hypot(px - qx, py - qy)


def parse_size(text):
    """'0.60' -> round 0.6 m; '2.00x1.50' -> box 2.0 x 1.5 m; '800' -> 0.8 m."""
    numbers = [float(v) for v in re.findall(r'[\d.]+', str(text or '')) if v not in ('', '.')]
    if not numbers:
        return SHAPE_CIRCULAR, DEFAULT_SIZE_M, DEFAULT_SIZE_M
    # Anything over 20 is in millimetres.
    numbers = [v / 1000 if v > 20 else v for v in numbers]
    numbers = [v for v in numbers if 0.1 <= v <= 6]
    if not numbers:
        return SHAPE_CIRCULAR, DEFAULT_SIZE_M, DEFAULT_SIZE_M
    if len(numbers) >= 2 and re.search(r'[xX×]', str(text)):
        return SHAPE_BOX, numbers[0], numbers[1]
    return SHAPE_CIRCULAR, numbers[0], numbers[0]


def manning_for(material):
    text = str(material or '')
    if 'HDPE' in text or 'PE' in text:
        return MANNING_N['HDPE']
    if 'PVC' in text:
        return MANNING_N['PVC']
    return MANNING_N['concrete']


# --- build -------------------------------------------------------------------

def polygon_centre(geometry):
    """The mean of a (Multi)Polygon's outer ring, as [lng, lat].

    Good enough to match a chamber to the junction it sits on: these outlines
    are a few metres across, well inside the matching radius.
    """
    if not geometry:
        return None
    kind = geometry.get('type')
    if kind == 'Polygon':
        rings = [geometry['coordinates'][0]]
    elif kind == 'MultiPolygon':
        rings = [part[0] for part in geometry['coordinates'] if part]
    else:
        return None
    points = [point for ring in rings for point in ring]
    if not points:
        return None
    return [sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)]


def main():
    pipes = load_json(PIPES_PATH)['features']
    covers = load_json(COVERS_PATH)['features']
    pumps = (load_json(PUMPS_PATH, required=False) or {'features': []})['features']
    # Surveyed chamber outlines, if scripts/extract-playground.py has been run.
    # These are the CHAMBER footprint; the covers' own mh_w/mh_l describe the
    # lid, which is a different and much smaller thing.
    chambers = [
        f for f in (load_json(PLAYGROUND_PATH, required=False) or {'features': []})['features']
        if f.get('properties', {}).get('kind') == 'chamber'
    ]
    roads = load_json(ROADS_PATH)
    rivers = load_json(RIVERS_PATH, required=False)
    boundary = load_json(BOUNDARY_PATH, required=False)

    all_lng = [c[0] for f in pipes for c in f['geometry']['coordinates']]
    all_lat = [c[1] for f in pipes for c in f['geometry']['coordinates']]
    frame = LocalFrame((min(all_lat) + max(all_lat)) / 2, (min(all_lng) + max(all_lng)) / 2)
    bbox = (min(all_lng), min(all_lat), max(all_lng), max(all_lat))
    print(f'{len(pipes):,} drain runs, {len(covers):,} covers, {len(pumps)} pump stations')

    # Every run as a list of (x, y) in metres.
    runs = []
    for feature in pipes:
        runs.append([frame.to_xy(lng, lat) for lng, lat in feature['geometry']['coordinates']])

    # --- 1. junctions: snap run ends together ------------------------------
    node_x, node_y = [], []
    node_buckets = {}

    def bucket_key(x, y):
        return int(x // SNAP_M), int(y // SNAP_M)

    def find_node(x, y):
        cx, cy = bucket_key(x, y)
        best, best_d = -1, SNAP_M
        for i in range(cx - 1, cx + 2):
            for j in range(cy - 1, cy + 2):
                for k in node_buckets.get((i, j), ()):
                    d = math.hypot(node_x[k] - x, node_y[k] - y)
                    if d < best_d:
                        best, best_d = k, d
        return best

    def find_or_create_node(x, y):
        found = find_node(x, y)
        if found >= 0:
            return found
        index = len(node_x)
        node_x.append(x)
        node_y.append(y)
        node_buckets.setdefault(bucket_key(x, y), []).append(index)
        return index

    # vertex_node[f][v] is the junction at vertex v of run f, or -1 mid-run.
    vertex_node = []
    for run in runs:
        marks = [-1] * len(run)
        marks[0] = find_or_create_node(*run[0])
        marks[-1] = find_or_create_node(*run[-1])
        vertex_node.append(marks)

    # Interior vertices that land on a junction are junctions too (a lateral
    # meeting a trunk exactly at one of the trunk's bends).
    vertex_joins = 0
    for f, run in enumerate(runs):
        for v in range(1, len(run) - 1):
            found = find_node(*run[v])
            if found >= 0:
                vertex_node[f][v] = found
                vertex_joins += 1

    # A run ending against the SIDE of another run, between its vertices, is a
    # T-junction: split that segment at the foot of the perpendicular.
    segment_buckets = {}
    SEG_CELL = 50.0
    for f, run in enumerate(runs):
        for s in range(len(run) - 1):
            (ax, ay), (bx, by) = run[s], run[s + 1]
            for i in range(int(min(ax, bx) // SEG_CELL), int(max(ax, bx) // SEG_CELL) + 1):
                for j in range(int(min(ay, by) // SEG_CELL), int(max(ay, by) // SEG_CELL) + 1):
                    segment_buckets.setdefault((i, j), []).append((f, s))

    endpoint_runs = {}
    for f, marks in enumerate(vertex_node):
        endpoint_runs.setdefault(marks[0], set()).add(f)
        endpoint_runs.setdefault(marks[-1], set()).add(f)

    splits = {}  # (f, s) -> list of (t, node)
    side_joins = 0
    for n in range(len(node_x)):
        x, y = node_x[n], node_y[n]
        own = endpoint_runs.get(n, set())
        cx, cy = int(x // SEG_CELL), int(y // SEG_CELL)
        for i in range(cx - 1, cx + 2):
            for j in range(cy - 1, cy + 2):
                for f, s in segment_buckets.get((i, j), ()):
                    if f in own:
                        continue
                    (ax, ay), (bx, by) = runs[f][s], runs[f][s + 1]
                    dx, dy = bx - ax, by - ay
                    length2 = dx * dx + dy * dy
                    if length2 == 0:
                        continue
                    t = ((x - ax) * dx + (y - ay) * dy) / length2
                    if t <= 0 or t >= 1:
                        continue
                    qx, qy = ax + t * dx, ay + t * dy
                    if math.hypot(qx - x, qy - y) >= SNAP_M:
                        continue
                    # Not within snapping distance of either end: those cases
                    # were handled as vertex joins above.
                    if math.hypot(qx - ax, qy - ay) < SNAP_M or math.hypot(qx - bx, qy - by) < SNAP_M:
                        continue
                    splits.setdefault((f, s), []).append((t, n))
                    side_joins += 1

    # --- 2. conduits: walk each run from junction to junction ---------------
    con_from, con_to, con_len, con_shape, con_w, con_h, con_n, con_feature = [], [], [], [], [], [], [], []
    con_points = []  # each conduit's vertices, for snapping inlets onto it
    dropped = 0
    for f, run in enumerate(runs):
        shape, width, height = parse_size(pipes[f]['properties'].get('size'))
        roughness = manning_for(pipes[f]['properties'].get('material'))

        # The run's vertices with any T-junction points inserted, each tagged
        # with its junction (or -1).
        points = []
        for v in range(len(run)):
            points.append((run[v], vertex_node[f][v]))
            if v < len(run) - 1:
                for t, n in sorted(splits.get((f, v), [])):
                    (ax, ay), (bx, by) = run[v], run[v + 1]
                    points.append(((ax + (bx - ax) * t, ay + (by - ay) * t), n))

        start = points[0][1]
        length = 0.0
        piece = [points[0][0]]
        for k in range(1, len(points)):
            (px, py), n = points[k]
            (qx, qy), _ = points[k - 1]
            length += math.hypot(px - qx, py - qy)
            piece.append((px, py))
            if n < 0:
                continue
            if n != start and length >= 0.5:
                con_from.append(start)
                con_to.append(n)
                con_len.append(length)
                con_shape.append(shape)
                con_w.append(width)
                con_h.append(height)
                con_n.append(roughness)
                con_feature.append(f)
                con_points.append(piece)
            else:
                dropped += 1
            start = n
            length = 0.0
            piece = [(px, py)]

    node_count = len(node_x)
    conduit_count = len(con_from)
    degree = np.zeros(node_count, dtype=int)
    for a, b in zip(con_from, con_to):
        degree[a] += 1
        degree[b] += 1
    print(f'{node_count:,} junctions, {conduit_count:,} conduits '
          f'({vertex_joins} vertex joins, {side_joins} side joins, {dropped} zero-length dropped)')

    # --- 3. ground and invert levels ----------------------------------------
    road_lat = roads['lat']
    road_lng = roads['lng']
    road_elev = roads['elev']
    road_x, road_y = [], []
    for lng, lat in zip(road_lng, road_lat):
        x, y = frame.to_xy(lng, lat)
        road_x.append(x)
        road_y.append(y)
    road_index = PointIndex(road_x, road_y, 60.0)

    ground = np.zeros(node_count)
    street = np.full(node_count, -1, dtype=int)
    far = 0
    for n in range(node_count):
        k, d = road_index.nearest(node_x[n], node_y[n], NODE_TO_STREET_M)
        if k >= 0:
            street[n] = k
        else:
            k, d = road_index.nearest(node_x[n], node_y[n], 600.0)
            far += 1
        ground[n] = road_elev[k] if k >= 0 else float('nan')
    if np.isnan(ground).any():
        ground[np.isnan(ground)] = np.nanmedian(ground)

    height_at = np.zeros(node_count)
    for a, b, h in zip(con_from, con_to, con_h):
        height_at[a] = max(height_at[a], h)
        height_at[b] = max(height_at[b], h)

    # --- inverts, from whatever depth the survey measured nearby ----------
    def depth_index(features, key, low, high):
        xs, ys, ds = [], [], []
        for feature in features:
            value = feature['properties'].get(key)
            if not isinstance(value, (int, float)) or not (low <= value <= high):
                continue
            lng, lat = feature['geometry']['coordinates']
            x, y = frame.to_xy(lng, lat)
            xs.append(x)
            ys.append(y)
            ds.append(float(value))
        return (PointIndex(xs, ys, 30.0) if xs else None), np.asarray(ds)

    mh_index, mh_depth = depth_index(covers, 'depth_m', 0.2, 8.0)
    depth_features = (load_json(DEPTHS_PATH, required=False) or {'features': []})['features']
    dr_index, dr_depth = depth_index(depth_features, 'depth_m', 0.05, 6.0)
    print(f'{len(mh_depth):,} manhole depths and {len(dr_depth):,} drain depths to measure inverts from')

    invert = np.zeros(node_count)
    invert_source = np.zeros(node_count, dtype=int)  # 0 assumed, 1 manhole, 2 drain depth
    for n in range(node_count):
        depth = None
        if mh_index is not None:
            k, _ = mh_index.nearest(node_x[n], node_y[n], MANHOLE_DEPTH_SEARCH_M)
            if k >= 0:
                # A manhole depth is measured to the bottom of the chamber,
                # which is where the pipes run: it IS the invert depth.
                depth = mh_depth[k]
                invert_source[n] = 1
        if depth is None and dr_index is not None:
            k, _ = dr_index.nearest(node_x[n], node_y[n], DRAIN_DEPTH_SEARCH_M)
            if k >= 0:
                # This one is measured to the back (crown) of the pipe, so the
                # bore hangs below it.
                depth = dr_depth[k] + height_at[n]
                invert_source[n] = 2
        if depth is None:
            depth = COVER_DEPTH_M + height_at[n]
        # However it was measured, the pipe cannot break the surface.
        invert[n] = min(ground[n] - depth, ground[n] - height_at[n])

    measured = int((invert_source > 0).sum())
    print(
        f'inverts: {int((invert_source == 1).sum()):,} from a manhole depth, '
        f'{int((invert_source == 2).sum()):,} from a drain depth, '
        f'{node_count - measured:,} assumed ({100 * measured / node_count:.0f}% measured)'
    )

    slopes = []
    for a, b, length in zip(con_from, con_to, con_len):
        slopes.append(abs(invert[a] - invert[b]) / length)
    slopes = np.array(slopes)
    print(f'ground from street heights ({far} junctions farther than {NODE_TO_STREET_M:.0f} m from a street); '
          f'invert slopes: median {np.median(slopes) * 100:.2f}%, {np.mean(slopes < 0.001) * 100:.0f}% flatter than 0.1%')

    # --- 4. manhole sizes and inlets from the covers -------------------------
    pipe_index = PointIndex(node_x, node_y, 40.0)

    # Inlets sit anywhere along a run, not just at its ends, so each one is
    # matched to the nearest CONDUIT and drains into the nearer of its two
    # junctions. Same for pump stations, which sit on a trunk.
    conduit_buckets = {}
    for c, pts in enumerate(con_points):
        for s in range(len(pts) - 1):
            (ax, ay), (bx, by) = pts[s], pts[s + 1]
            for i in range(int(min(ax, bx) // SEG_CELL), int(max(ax, bx) // SEG_CELL) + 1):
                for j in range(int(min(ay, by) // SEG_CELL), int(max(ay, by) // SEG_CELL) + 1):
                    conduit_buckets.setdefault((i, j), []).append((c, s))

    def nearest_junction_by_conduit(x, y, radius):
        """The pipe junction to feed from (x, y): an end of the nearest conduit."""
        reach = int(math.ceil(radius / SEG_CELL))
        cx, cy = int(x // SEG_CELL), int(y // SEG_CELL)
        best, best_d = -1, radius
        for i in range(cx - reach, cx + reach + 1):
            for j in range(cy - reach, cy + reach + 1):
                for c, s in conduit_buckets.get((i, j), ()):
                    (ax, ay), (bx, by) = con_points[c][s], con_points[c][s + 1]
                    d = float(segment_distances(x, y, np.array([ax]), np.array([ay]), np.array([bx]), np.array([by]))[0])
                    if d < best_d:
                        best, best_d = c, d
        if best < 0:
            return -1, best_d
        a, b = con_from[best], con_to[best]
        da = math.hypot(node_x[a] - x, node_y[a] - y)
        db = math.hypot(node_x[b] - x, node_y[b] - y)
        return (a if da <= db else b), best_d

    shaft = np.full(node_count, DEFAULT_SHAFT_M2)

    # Surveyed chamber outlines size the junction they sit on. This is the
    # storage a manhole actually has above its pipes, and it decides how fast
    # a node surcharges and spills onto the street - so a default of 1 m2
    # across 6,592 of 6,903 junctions was making the whole network spill
    # earlier than it should.
    chamber_sized = 0
    for feature in chambers:
        props = feature.get('properties', {})
        w, l = props.get('width_m'), props.get('length_m')
        if not (isinstance(w, (int, float)) and isinstance(l, (int, float))):
            continue
        area = float(w) * float(l)
        if not (CHAMBER_MIN_M2 <= area <= CHAMBER_MAX_M2):
            continue
        centre = polygon_centre(feature['geometry'])
        if centre is None:
            continue
        x, y = frame.to_xy(centre[0], centre[1])
        k, _ = pipe_index.nearest(x, y, CHAMBER_TO_PIPE_M)
        if k >= 0 and area > shaft[k]:
            shaft[k] = area
            chamber_sized += 1
    if chambers:
        print(f'  {chamber_sized:,} junctions sized by a surveyed chamber '
              f'(of {len(chambers):,} outlines)')

    # Manhole chambers size the junctions they sit on, and any grated cover
    # lends its opening to the street junction nearest it.
    grate_area = defaultdict(float)
    grate_perimeter = defaultdict(float)
    grated = 0
    for cover in covers:
        props = cover['properties']
        lng, lat = cover['geometry']['coordinates']
        x, y = frame.to_xy(lng, lat)

        mh_w, mh_l = props.get('mh_w'), props.get('mh_l')
        if isinstance(mh_w, (int, float)) and isinstance(mh_l, (int, float)) and 0.3 <= mh_w <= 5 and 0.3 <= mh_l <= 5:
            k, _ = pipe_index.nearest(x, y, MANHOLE_TO_PIPE_M)
            if k >= 0:
                shaft[k] = max(shaft[k], mh_w * mh_l)

        if props.get('cover') not in INLET_MATERIALS:
            continue
        grated += 1
        s, _ = road_index.nearest(x, y, INLET_TO_STREET_M)
        if s < 0:
            continue

        dia = props.get('cover_dia')
        w, l = props.get('cover_w'), props.get('cover_l')
        if isinstance(dia, (int, float)) and 0.2 <= dia <= 2:
            perimeter = math.pi * dia
            area = math.pi * dia * dia / 4 * GRATE_OPEN_FRACTION
        elif isinstance(w, (int, float)) and isinstance(l, (int, float)) and 0.15 <= w <= 3 and 0.15 <= l <= 3:
            perimeter = 2 * (w + l)
            area = w * l * GRATE_OPEN_FRACTION
        else:
            w, l = DEFAULT_GRATE_M
            perimeter = 2 * (w + l)
            area = w * l * GRATE_OPEN_FRACTION
        grate_area[s] += area
        grate_perimeter[s] += perimeter

    # One inlet per street junction the drain runs under. Where the survey
    # recorded gratings beside that junction they are its opening; where it
    # did not, the kerb opening a covered trench has anyway.
    inlet_node, inlet_street, inlet_perimeter, inlet_area = [], [], [], []
    from_survey = 0
    for s in range(len(road_x)):
        k, _ = nearest_junction_by_conduit(road_x[s], road_y[s], STREET_TO_PIPE_M)
        if k < 0:
            continue
        if s in grate_area:
            area = grate_area[s]
            perimeter = grate_perimeter[s]
            from_survey += 1
        else:
            area = KERB_INLET_AREA_M2
            perimeter = KERB_INLET_PERIMETER_M
        inlet_node.append(k)
        inlet_street.append(s)
        inlet_perimeter.append(round(perimeter, 2))
        inlet_area.append(round(area, 3))
    print(
        f'{len(inlet_node):,} inlets - one per street junction within {STREET_TO_PIPE_M:.0f} m of a drain '
        f'({from_survey:,} sized by surveyed gratings out of {grated:,}, the rest a '
        f'{KERB_INLET_AREA_M2:.2f} m2 kerb opening)'
    )

    # --- 5. outfalls ----------------------------------------------------------
    kind = np.zeros(node_count, dtype=int)  # 0 manhole, 1 sea outfall, 2 free outfall
    is_pump = np.zeros(node_count, dtype=int)  # separate: a pump can sit on an outfall
    assumed = np.zeros(node_count, dtype=int)
    ends = [n for n in range(node_count) if degree[n] == 1]

    def segments_near_bbox(features, pad_deg=0.02):
        ax, ay, bx, by = [], [], [], []
        west, south, east, north = bbox[0] - pad_deg, bbox[1] - pad_deg, bbox[2] + pad_deg, bbox[3] + pad_deg

        def add_ring(coords):
            for (lng1, lat1), (lng2, lat2) in zip(coords, coords[1:]):
                if not (west <= lng1 <= east and south <= lat1 <= north) and not (west <= lng2 <= east and south <= lat2 <= north):
                    continue
                x1, y1 = frame.to_xy(lng1, lat1)
                x2, y2 = frame.to_xy(lng2, lat2)
                ax.append(x1)
                ay.append(y1)
                bx.append(x2)
                by.append(y2)

        for feature in features:
            geometry = feature.get('geometry') or {}
            kind_ = geometry.get('type')
            coords = geometry.get('coordinates') or []
            if kind_ == 'LineString':
                add_ring(coords)
            elif kind_ == 'MultiLineString' or kind_ == 'Polygon':
                for part in coords:
                    add_ring(part)
            elif kind_ == 'MultiPolygon':
                for polygon in coords:
                    for ring in polygon:
                        add_ring(ring)
        return tuple(np.array(v) for v in (ax, ay, bx, by))

    sea = 0
    if boundary:
        features = boundary['features'] if boundary.get('type') == 'FeatureCollection' else [boundary]
        coast = segments_near_bbox(features)
        if len(coast[0]):
            for n in ends:
                if segment_distances(node_x[n], node_y[n], *coast).min() <= SEA_OUTFALL_M:
                    kind[n] = 1
                    sea += 1

    canal = 0
    if rivers:
        waterways = segments_near_bbox(rivers['features'])
        if len(waterways[0]):
            for n in ends:
                if kind[n] == 0 and segment_distances(node_x[n], node_y[n], *waterways).min() <= CANAL_OUTFALL_M:
                    kind[n] = 2
                    canal += 1

    # Pumps: the nearest junction to each station becomes a pumped node.
    pump_node, pump_name, pump_rate = [], [], []
    pump_lat, pump_lng, pump_approx = [], [], []
    unmatched_pumps = []
    stations = list(pumps) + [
        {'geometry': {'coordinates': [p['lng'], p['lat']]}, 'properties': {'name': p['name'], 'approx': True}}
        for p in EXTRA_PUMPS
    ]
    for pump in stations:
        lng, lat = pump['geometry']['coordinates']
        x, y = frame.to_xy(lng, lat)
        name = pump['properties'].get('name') or 'pump station'
        approx = bool(pump['properties'].get('approx', False))
        # A station placed from a description is allowed a wider reach to the
        # drain it serves than a surveyed point is.
        k, dist = nearest_junction_by_conduit(x, y, PUMP_TO_PIPE_M * (4 if approx else 1))
        if approx and (k < 0 or k in pump_node):
            # Its nearest drain end may already be another station's (Khao
            # Noi shares the railway-road trunk with Sump 3): take the
            # nearest junction that is still free.
            d_all = np.hypot(np.asarray(node_x, dtype=float) - x, np.asarray(node_y, dtype=float) - y)
            for cand in np.argsort(d_all):
                if d_all[cand] > PUMP_TO_PIPE_M * 4:
                    break
                if int(cand) not in pump_node:
                    k, dist = int(cand), float(d_all[cand])
                    break
        if k < 0 or k in pump_node:
            unmatched_pumps.append(name)
            continue
        if approx:
            print(f'  {name}: placed from the plan, {dist:.0f} m from the nearest drain')
        is_pump[k] = 1
        pump_node.append(k)
        pump_name.append(name)
        pump_rate.append(rated_flow(name))
        pump_lat.append(round(float(lat), 6))
        pump_lng.append(round(float(lng), 6))
        pump_approx.append(approx)
    rated = [(n, r) for n, r in zip(pump_name, pump_rate) if r is not None]
    print(f'{len(rated)} pump stations carry a rated flow from the city plan: '
          + ', '.join(f'{n} {r:.2f} m3/s' for n, r in rated))

    # A pump's sump is a tank, not a manhole shaft: its footprint is what the
    # water it is holding back stands over.
    sump_features = (load_json(SUMPS_PATH, required=False) or {'features': []})['features']
    sized = 0
    for sump in sump_features:
        area = sump['properties'].get('area_m2')
        if not isinstance(area, (int, float)) or not (1 <= area <= 20000):
            continue
        lng, lat = sump['geometry']['coordinates']
        x, y = frame.to_xy(lng, lat)
        k, _ = pipe_index.nearest(x, y, SUMP_TO_PUMP_M)
        if k >= 0 and area > shaft[k]:
            shaft[k] = area
            sized += 1
    if sump_features:
        print(f'{sized} of {len(sump_features)} surveyed sump footprints sized a junction')

    # Networks with no way out get their lowest dead end declared an outfall.
    parent = list(range(node_count))

    def root(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    for a, b in zip(con_from, con_to):
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[ra] = rb

    members = {}
    for n in range(node_count):
        members.setdefault(root(n), []).append(n)
    forced = 0
    for group in members.values():
        if any(kind[n] != 0 or is_pump[n] for n in group):
            continue
        candidates = [n for n in group if degree[n] == 1] or group
        lowest = min(candidates, key=lambda n: invert[n])
        kind[lowest] = 2
        assumed[lowest] = 1
        forced += 1
    print(f'{len(members):,} separate networks; outfalls: {sea} sea, {canal} canal, {forced} assumed (lowest dead end); '
          f'{len(pump_node)} pump stations matched' + (f', {len(unmatched_pumps)} not near a pipe' if unmatched_pumps else ''))

    # --- 5b. give every run a fall towards its outfall -----------------------
    #
    # Walking out from the outfalls, each junction upstream is lifted to sit at
    # least MIN_GRADE above the one below it - but never so high that the pipe
    # would break the surface. The depths measure how deep the drain is at a
    # point; this is the grade it was laid to, which no survey field carries.
    adjacency = [[] for _ in range(node_count)]
    for c in range(conduit_count):
        adjacency[con_from[c]].append((con_to[c], con_len[c], con_h[c]))
        adjacency[con_to[c]].append((con_from[c], con_len[c], con_h[c]))

    import heapq

    graded = invert.copy()
    visited = np.zeros(node_count, dtype=bool)
    queue = [(0.0, n) for n in range(node_count) if kind[n] != 0]
    heapq.heapify(queue)
    for _, n in queue:
        visited[n] = True
    lifted = 0
    while queue:
        distance, n = heapq.heappop(queue)
        for m, length, pipe_h in adjacency[n]:
            if visited[m]:
                continue
            visited[m] = True
            # At least this far above its downstream neighbour, and still
            # under the road.
            wanted = graded[n] + MIN_GRADE * length
            ceiling = ground[m] - pipe_h - MIN_COVER_M
            target = min(max(graded[m], wanted), max(ceiling, graded[m]))
            if target > graded[m] + 1e-6:
                lifted += 1
            graded[m] = target
            heapq.heappush(queue, (distance + length, m))

    invert = graded
    slopes = np.array([abs(invert[a] - invert[b]) / L for a, b, L in zip(con_from, con_to, con_len)])
    print(
        f'graded towards the outfalls: {lifted:,} junctions lifted, slopes now median '
        f'{np.median(slopes) * 100:.2f}%, {np.mean(slopes < 0.001) * 100:.0f}% flatter than 0.1% '
        f'({int(visited.sum()):,} of {node_count:,} junctions reachable from an outfall)'
    )

    # --- 6. write --------------------------------------------------------------
    node_lat = [round(frame.lat0 + y / frame.ky, 6) for y in node_y]
    node_lng = [round(frame.lng0 + x / frame.kx, 6) for x in node_x]
    full_area = [
        (w * h if s == SHAPE_BOX else math.pi * w * w / 4) for s, w, h in zip(con_shape, con_w, con_h)
    ]
    volume = sum(a * length for a, length in zip(full_area, con_len))

    model = {
        'source': 'Pattaya drainage survey (Data_Pattaya.gdb) via scripts/build-drainage-model.py',
        'coverDepthM': COVER_DEPTH_M,
        'snapM': SNAP_M,
        'featureCount': len(pipes),
        'nodes': {
            'count': node_count,
            'lat': node_lat,
            'lng': node_lng,
            'ground': [round(float(v), 3) for v in ground],
            'invert': [round(float(v), 3) for v in invert],
            'shaftM2': [round(float(v), 2) for v in shaft],
            'kind': [int(v) for v in kind],
            'pump': [int(v) for v in is_pump],
            'invertSource': [int(v) for v in invert_source],
            'assumedOutfall': [int(v) for v in assumed],
            'street': [int(v) for v in street],
        },
        'conduits': {
            'count': conduit_count,
            'from': con_from,
            'to': con_to,
            'lengthM': [round(v, 1) for v in con_len],
            'shape': con_shape,
            'widthM': [round(v, 2) for v in con_w],
            'heightM': [round(v, 2) for v in con_h],
            'manningN': con_n,
            'feature': con_feature,
        },
        'inlets': {
            'count': len(inlet_node),
            'node': inlet_node,
            'street': inlet_street,
            'perimeterM': [round(v, 2) for v in inlet_perimeter],
            'openAreaM2': [round(v, 3) for v in inlet_area],
        },
        'pumps': {
            'count': len(pump_node),
            'node': pump_node,
            'name': pump_name,
            # m3/s from the city plan, or null for the run-time default.
            'ratedM3s': [None if r is None else round(r, 3) for r in pump_rate],
            # Where the station itself is (the node is the junction it pumps
            # from), and whether that position is the plan's description
            # rather than a survey point.
            'lat': pump_lat,
            'lng': pump_lng,
            'approx': pump_approx,
        },
        'stats': {
            'vertexJoins': vertex_joins,
            'sideJoins': side_joins,
            'networks': len(members),
            'seaOutfalls': sea,
            'canalOutfalls': canal,
            'assumedOutfalls': forced,
            'gratedCovers': grated,
            'pipeVolumeM3': round(volume),
        },
    }

    text = json.dumps(model, separators=(',', ':'))
    OUT_PATH.write_text(text, encoding='utf-8')
    print(f'pipe volume {volume:,.0f} m3, median conduit {np.median(con_len):.0f} m; '
          f'saved {OUT_PATH.name} ({len(text) / 1e6:.2f} MB)')


if __name__ == '__main__':
    main()
