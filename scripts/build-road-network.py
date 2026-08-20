"""Turns the street download into an elevation-tagged routing graph.

Water on a street runs downhill along the street, so the flow model needs a
height for every junction. Those heights are sampled here, at build time, from
the full 30 m DEM rather than from the 200 m analysis grid the browser holds --
the whole point of the road layer is detail the coarse grid cannot resolve.

Run: npm run build:roads
"""

import json
import math
import os
from pathlib import Path

import numpy as np

# Junctions closer together than one DEM cell otherwise read the same height,
# which is what left 43% of them with nowhere to drain. Two things fix that:
# extra points along every street so height can vary between junctions, and
# bilinear sampling so neighbouring points differ even inside one cell.
MAX_SPACING_M = float(os.environ.get("ROAD_POINT_SPACING_M", 20))

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ROADS_PATH = PROJECT_ROOT / "public" / "data" / "chonburi-roads.geojson"
MANIFEST_PATH = PROJECT_ROOT / "public" / "data" / "chonburi-dem.json"
OUTPUT_PATH = PROJECT_ROOT / "public" / "data" / "chonburi-road-network.json"

HEADER_KEYS = {
    "ncols", "nrows", "xllcorner", "yllcorner",
    "xllcenter", "yllcenter", "cellsize", "nodata_value",
}


def read_ascii_grid(path):
    """Minimal AAIGrid reader. Kept separate from build-dem-cache.py so that
    working script stays untouched; both handle the 5-line COP30 header."""
    header = {}
    first_data_line = None

    with path.open("r", encoding="utf-8") as stream:
        while True:
            line = stream.readline()
            if not line:
                break

            stripped = line.strip()
            if not stripped:
                continue

            parts = stripped.split(maxsplit=1)
            if parts[0].lower() not in HEADER_KEYS:
                first_data_line = line
                break

            header[parts[0].lower()] = float(parts[1])

        rows = int(header["nrows"])
        columns = int(header["ncols"])
        print(f"Reading {columns} x {rows} DEM...", flush=True)

        import itertools
        lines = itertools.chain([first_data_line], stream) if first_data_line else stream
        raster = np.loadtxt(lines, dtype=np.float32, max_rows=rows)

    raster = raster.reshape((rows, columns))
    cell = header["cellsize"]
    west = header.get("xllcorner", header.get("xllcenter"))
    south = header.get("yllcorner", header.get("yllcenter"))
    return raster, west, south, cell


def sample_bilinear(raster, lat, lng, west, north, cell):
    """Blend the four surrounding cells. Nearest-neighbour hands an identical
    height to every point inside one 30 m cell, manufacturing flats that the
    routing then cannot escape."""
    rows, columns = raster.shape
    fx = (lng - west) / cell - 0.5
    fy = (north - lat) / cell - 0.5

    x0 = np.clip(np.floor(fx).astype(int), 0, columns - 1)
    y0 = np.clip(np.floor(fy).astype(int), 0, rows - 1)
    x1 = np.clip(x0 + 1, 0, columns - 1)
    y1 = np.clip(y0 + 1, 0, rows - 1)
    tx = np.clip(fx - x0, 0.0, 1.0)
    ty = np.clip(fy - y0, 0.0, 1.0)

    grid = raster.astype(np.float64)
    corners = np.stack([grid[y0, x0], grid[y0, x1], grid[y1, x0], grid[y1, x1]])
    weights = np.stack([(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty])

    # Drop no-data corners and renormalise, so a point beside the sea still
    # takes its height from the land cells around it.
    valid = np.isfinite(corners) & (corners > -100)
    weights = np.where(valid, weights, 0.0)
    total = weights.sum(axis=0)
    return np.where(
        total > 0,
        (np.where(valid, corners, 0.0) * weights).sum(axis=0) / np.maximum(total, 1e-9),
        np.nan,
    )


def main():
    roads = json.loads(ROADS_PATH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    dem_path = PROJECT_ROOT / "public" / manifest["dataPath"].lstrip("/")

    raster, west, south, cell = read_ascii_grid(dem_path)
    rows, columns = raster.shape
    north = south + rows * cell

    # Deduplicate vertices into graph nodes. Overpass emits the identical
    # lat/lon for a node shared by two ways, so string keys match exactly and
    # junctions connect without any distance tolerance.
    node_index = {}
    lats, lngs = [], []
    edges = []
    inserted = 0

    def node_for(lat, lng, shared):
        """Shared OSM vertices are deduplicated so junctions connect. Points
        inserted mid-segment stay private to that segment, so they never create
        a junction that does not exist on the ground."""
        nonlocal inserted
        if shared:
            key = (lat, lng)
            index = node_index.get(key)
            if index is not None:
                return index
            index = len(lats)
            node_index[key] = index
        else:
            index = len(lats)
            inserted += 1

        lats.append(lat)
        lngs.append(lng)
        return index

    for feature in roads["features"]:
        previous = None
        previous_point = None

        for lng, lat in feature["geometry"]["coordinates"]:
            index = node_for(lat, lng, True)

            if previous is not None:
                prev_lng, prev_lat = previous_point
                mid_lat = math.radians((lat + prev_lat) / 2)
                dy = (lat - prev_lat) * 110574.0
                dx = (lng - prev_lng) * 111320.0 * math.cos(mid_lat)
                steps = int(math.hypot(dx, dy) // MAX_SPACING_M)

                link = previous
                for step in range(1, steps + 1):
                    ratio = step / (steps + 1)
                    mid = node_for(
                        prev_lat + (lat - prev_lat) * ratio,
                        prev_lng + (lng - prev_lng) * ratio,
                        False,
                    )
                    edges.append((link, mid))
                    link = mid

                if link != index:
                    edges.append((link, index))

            previous = index
            previous_point = (lng, lat)

    lat_array = np.asarray(lats, dtype=np.float64)
    lng_array = np.asarray(lngs, dtype=np.float64)

    elevations = sample_bilinear(raster, lat_array, lng_array, west, north, cell)
    elevations[~np.isfinite(elevations)] = -9999
    elevations[elevations < -100] = -9999
    # A handful of shoreline points sample water and come back slightly negative.
    # Left alone they become the lowest points on the map and pull the whole
    # network towards them, so clamp road surfaces to sea level.
    below = (elevations > -9999) & (elevations < 0)
    elevations[below] = 0.0

    valid = elevations > -9999
    payload = {
        "source": "OpenStreetMap streets (ODbL), elevations from OpenTopography COP30",
        "nodeCount": len(lats),
        "lat": [round(v, 6) for v in lats],
        "lng": [round(v, 6) for v in lngs],
        # Millimetre precision. This is far finer than COP30 is accurate to, but
        # rounding to centimetres collapsed the interpolated heights back into
        # ties, which is exactly what the interpolation is there to avoid.
        "elev": [round(float(v), 3) for v in elevations],
        "edges": [int(v) for pair in edges for v in pair],
    }

    OUTPUT_PATH.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    size_mb = OUTPUT_PATH.stat().st_size / (1024 * 1024)

    source_vertices = sum(len(f["geometry"]["coordinates"]) for f in roads["features"])
    print("")
    print(f"Nodes: {len(lats):,} ({source_vertices:,} OSM vertices + {inserted:,} inserted at <={MAX_SPACING_M:.0f} m spacing)")
    print(f"Edges: {len(edges):,}")
    print(f"Nodes with an elevation: {int(valid.sum()):,} ({100 * valid.mean():.1f}%)")
    print(f"Clamped to sea level: {int(below.sum())}")
    print(f"Distinct heights: {len(np.unique(np.round(elevations, 3))):,}")
    if valid.any():
        print(f"Elevation range: {elevations[valid].min():.1f} - {elevations[valid].max():.1f} m")
    print(f"Saved {OUTPUT_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
