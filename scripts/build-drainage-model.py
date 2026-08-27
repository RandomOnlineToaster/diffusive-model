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
  * ground level at a junction is the nearest street junction's DEM height,
    and the pipe invert is that minus PIPE_COVER_DEPTH_M minus the pipe height
    (no invert levels are surveyed yet);
  * a run end within DRAIN_SEA_OUTFALL_M of the coast is a sea outfall (its
    water level is the tide), one within DRAIN_CANAL_OUTFALL_M of an OSM
    waterway is a canal outfall (free discharge), and a network with neither
    gets its lowest dead end declared a free outfall so it can drain at all;
  * a grated cover is an inlet into the nearest pipe junction, fed by the
    nearest street junction, with a weir/orifice capacity from its grate size.

Run: npm run build:drainage   (after build:roads, whose node numbering it uses)
"""
import json
import math
import os
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
PIPES_PATH = DATA / 'drainage-pipes.geojson'
COVERS_PATH = DATA / 'drainage-covers.geojson'
PUMPS_PATH = DATA / 'drainage-pumps.geojson'
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
NODE_TO_STREET_M = 60.0
PUMP_TO_PIPE_M = 80.0
MANHOLE_TO_PIPE_M = 5.0
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

def main():
    pipes = load_json(PIPES_PATH)['features']
    covers = load_json(COVERS_PATH)['features']
    pumps = (load_json(PUMPS_PATH, required=False) or {'features': []})['features']
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
    invert = ground - COVER_DEPTH_M - height_at

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
    inlet_node, inlet_street, inlet_perimeter, inlet_area = [], [], [], []
    grated = 0
    unmatched_pipe = 0
    unmatched_street = 0
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
        k, _ = nearest_junction_by_conduit(x, y, INLET_TO_PIPE_M)
        if k < 0:
            unmatched_pipe += 1
            continue
        s, _ = road_index.nearest(x, y, INLET_TO_STREET_M)
        if s < 0:
            unmatched_street += 1
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
        inlet_node.append(k)
        inlet_street.append(s)
        inlet_perimeter.append(perimeter)
        inlet_area.append(area)
    print(f'{len(inlet_node):,} inlets from {grated:,} grated covers '
          f'({unmatched_pipe} with no pipe within {INLET_TO_PIPE_M:.0f} m, {unmatched_street} with no street within {INLET_TO_STREET_M:.0f} m)')

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
    pump_node, pump_name = [], []
    unmatched_pumps = []
    for pump in pumps:
        lng, lat = pump['geometry']['coordinates']
        x, y = frame.to_xy(lng, lat)
        k, _ = nearest_junction_by_conduit(x, y, PUMP_TO_PIPE_M)
        name = pump['properties'].get('name') or 'pump station'
        if k < 0 or k in pump_node:
            unmatched_pumps.append(name)
            continue
        is_pump[k] = 1
        pump_node.append(k)
        pump_name.append(name)

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
