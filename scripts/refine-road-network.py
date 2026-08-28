"""Refine the street graph with the city's own survey.

The street graph is built from OSM geometry with heights sampled from COP30
(scripts/build-road-network.py). COP30 is a 30 m SURFACE model: it includes
buildings, and measured against Pattaya's own benchmarks it sits 3-4 m high
with a metre or two of noise. On a coastal flat where the whole question is
which way water runs, that is mostly noise.

The city geodatabase has better: 2 m contours over Pattaya and Ko Lan, 366
levelled benchmarks, and carriageway widths on its road centrelines. This
script replaces the heights with a surface interpolated from those, and adds
a width per junction, writing both back into the street graph the app loads.

  contour2m + contour  ->  surface  ->  shifted to the benchmark datum  ->  elev[]
  roadcl_arc RC_WIDTH  ->  nearest centreline                           ->  width[]

Where the contours do not reach (the graph runs further north and south than
they do) the COP30 height is kept, less a plane fitted to its bias where the
two overlap, so the two surfaces join without a step.

THE TWO SURVEY PRODUCTS ARE ON DIFFERENT VERTICAL DATUMS. Measured here, the
contour surface reads about 4.5 m ABOVE the 366 levelled benchmarks, near
enough uniformly across the whole height range (+4.9 m at 0-5 m, +4.1 m at
20-40 m), and a benchmark can sit a metre from a contour line and read three
metres below it. COP30 agrees with the contours to within a metre, so it is
the benchmarks that stand apart - and they are the ones to believe: they are
levelled marks, and only they put Pattaya Beach Road at the 1-2 m it plainly
is rather than at 6-10 m.

So the SHAPE comes from the contours, which are dense and consistent, and
the DATUM from the benchmarks: the surface is shifted down by the median
difference. That matters because the tide is quoted in metres above mean sea
level and is compared against these heights directly - on the contour datum
every outfall in the city would sit safely above any tide. The shift is
reported when this runs and can be overridden with CONTOUR_DATUM_SHIFT_M
(set it to 0 to keep the contour datum) once the city says which is which.

Run: npm run refine:network      (after build:roads, before build:drainage)

Needs pyogrio and numpy. SciPy is NOT needed: the surface is interpolated by
a coarse-to-fine Laplace fill, which is the usual way to turn contours into
a raster and needs nothing but array arithmetic.
"""
import json
import math
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings('ignore')

import numpy as np
import pyogrio.raw as raw
from pyproj import Transformer
from shapely import from_wkb, get_coordinates, get_parts, get_type_id

DEFAULT_GDB = r'D:\Code\_SCS\data\1.GIS_Geodatabase\Data_Pattaya.gdb'
GDB = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GDB
ROOT = Path(__file__).resolve().parent.parent
NETWORK = ROOT / 'public' / 'data' / 'chonburi-road-network.json'

TO_UTM = Transformer.from_crs('EPSG:4326', 'EPSG:32647', always_xy=True)

# Contour vertices are thinned to this spacing before use: a 2 m contour is
# drawn with far more detail than a height surface needs, and every vertex
# costs memory in the burn.
VERTEX_SPACING_M = 8.0
# The surface is solved at this resolution, reached by halving from COARSE_M.
FINE_M = 20.0
COARSE_M = 320.0
# Relaxation sweeps per resolution. The coarse solution seeds the next one,
# so each level only has to settle locally.
SWEEPS = 160
# A junction further than this from any contour vertex is treated as outside
# the surveyed area and keeps its (bias-corrected) COP30 height.
COVERAGE_M = 400.0
# Carriageway width: how far a junction may be from a surveyed centreline,
# and the width assumed where none is near.
WIDTH_SEARCH_M = 25.0
DEFAULT_WIDTH_M = 6.0
# A junction this close to the zero-metre contour - the shoreline - counts as
# coastal, and a dead end there is where a street drains into the sea. Height
# alone will not do it: once the heights are right, plenty of streets a
# kilometre inland sit under a metre and a half, and the tide has no business
# reaching them.
COASTAL_M = 250.0


def read(layer):
    meta, _fids, geom, arrays = raw.read(GDB, layer=layer)
    return from_wkb(geom), {name: array for name, array in zip(meta['fields'], arrays)}


def numeric(values):
    out = np.empty(len(values), dtype=float)
    for index, value in enumerate(values):
        try:
            out[index] = float(value)
        except (TypeError, ValueError):
            out[index] = np.nan
    return out


def contour_points(layer, field):
    """Contour vertices as (x, y, z), thinned along each line."""
    geoms, fields = read(layer)
    levels = numeric(fields[field])
    xs, ys, zs = [], [], []

    for geom, level in zip(geoms, levels):
        if geom is None or geom.is_empty or not np.isfinite(level):
            continue
        parts = get_parts(geom) if get_type_id(geom) in (5, 6, 7) else [geom]
        for part in parts:
            coords = get_coordinates(part)
            if len(coords) == 0:
                continue
            # Keep the first vertex, then one every VERTEX_SPACING_M along.
            step = np.hypot(np.diff(coords[:, 0]), np.diff(coords[:, 1]))
            along = np.concatenate([[0.0], np.cumsum(step)])
            keep = [0]
            last = 0.0
            for index in range(1, len(along)):
                if along[index] - last >= VERTEX_SPACING_M:
                    keep.append(index)
                    last = along[index]
            if keep[-1] != len(along) - 1:
                keep.append(len(along) - 1)
            picked = coords[keep]
            xs.append(picked[:, 0])
            ys.append(picked[:, 1])
            zs.append(np.full(len(picked), level))

    if not xs:
        return np.empty(0), np.empty(0), np.empty(0)
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(zs)


def benchmark_points():
    """Levelled spot heights: the datum everything else is checked against."""
    xs, ys, zs = [], [], []
    for layer, field in (('หมุดเมือง_Point', 'Elevation'), ('coordinate_reference', 'ELEVATION')):
        try:
            geoms, fields = read(layer)
        except Exception as error:  # noqa: BLE001 - a missing layer is not fatal
            print(f'  ({layer} unavailable: {error})')
            continue
        levels = numeric(fields[field])
        coords = get_coordinates(geoms)
        good = np.isfinite(levels) & (levels > -10) & (levels < 400)
        xs.append(coords[good, 0])
        ys.append(coords[good, 1])
        zs.append(levels[good])
    if not xs:
        return np.empty(0), np.empty(0), np.empty(0)
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(zs)


def burn(x, y, z, x0, y0, res, nx, ny):
    """Average the samples falling in each cell; returns (values, known)."""
    ix = np.clip(((x - x0) / res).astype(np.int64), 0, nx - 1)
    iy = np.clip(((y - y0) / res).astype(np.int64), 0, ny - 1)
    flat = iy * nx + ix
    total = np.bincount(flat, weights=z, minlength=nx * ny)
    count = np.bincount(flat, minlength=nx * ny)
    known = count > 0
    values = np.zeros(nx * ny)
    values[known] = total[known] / count[known]
    return values.reshape(ny, nx), known.reshape(ny, nx)


def relax(grid, values, known, sweeps):
    """Laplace smoothing with the sampled cells pinned: the gaps between the
    contours fill with the smooth surface that runs between them."""
    grid = grid.copy()
    grid[known] = values[known]
    for _ in range(sweeps):
        # Neumann edges: the surface leaves the box flat rather than falling
        # off it, which is what we want outside the surveyed area.
        up = np.empty_like(grid)
        down = np.empty_like(grid)
        left = np.empty_like(grid)
        right = np.empty_like(grid)
        up[1:, :] = grid[:-1, :]
        up[0, :] = grid[0, :]
        down[:-1, :] = grid[1:, :]
        down[-1, :] = grid[-1, :]
        left[:, 1:] = grid[:, :-1]
        left[:, 0] = grid[:, 0]
        right[:, :-1] = grid[:, 1:]
        right[:, -1] = grid[:, -1]
        grid = 0.25 * (up + down + left + right)
        grid[known] = values[known]
    return grid


def upsample(grid, ny, nx):
    """Nearest-neighbour blow-up of the coarser solution, as the next seed."""
    rows = np.clip((np.arange(ny) * grid.shape[0]) // ny, 0, grid.shape[0] - 1)
    columns = np.clip((np.arange(nx) * grid.shape[1]) // nx, 0, grid.shape[1] - 1)
    return grid[rows[:, None], columns[None, :]]


def build_surface(x, y, z, bounds):
    """Coarse-to-fine Laplace fill over the contour samples."""
    west, south, east, north = bounds
    grid = None
    res = COARSE_M
    while True:
        nx = max(2, int(math.ceil((east - west) / res)) + 1)
        ny = max(2, int(math.ceil((north - south) / res)) + 1)
        values, known = burn(x, y, z, west, south, res, nx, ny)
        seed = np.full((ny, nx), float(np.mean(z))) if grid is None else upsample(grid, ny, nx)
        grid = relax(seed, values, known, SWEEPS)
        print(f'  {res:>5.0f} m grid {nx} x {ny}, {int(known.sum()):,} cells sampled')
        if res <= FINE_M:
            return grid, known, west, south, res, nx, ny
        res /= 2


def sample(grid, x0, y0, res, x, y):
    """Bilinear read of the surface at scattered points."""
    ny, nx = grid.shape
    fx = np.clip((x - x0) / res, 0, nx - 1.001)
    fy = np.clip((y - y0) / res, 0, ny - 1.001)
    ix = fx.astype(np.int64)
    iy = fy.astype(np.int64)
    tx = fx - ix
    ty = fy - iy
    return (
        grid[iy, ix] * (1 - tx) * (1 - ty)
        + grid[iy, ix + 1] * tx * (1 - ty)
        + grid[iy + 1, ix] * (1 - tx) * ty
        + grid[iy + 1, ix + 1] * tx * ty
    )


def dilate(mask, cells):
    """Grow a boolean mask by `cells` in each direction."""
    out = mask.copy()
    for _ in range(cells):
        grown = out.copy()
        grown[1:, :] |= out[:-1, :]
        grown[:-1, :] |= out[1:, :]
        grown[:, 1:] |= out[:, :-1]
        grown[:, :-1] |= out[:, 1:]
        out = grown
    return out


def nearest_width(node_x, node_y):
    """Carriageway width from the nearest surveyed centreline, or NaN."""
    geoms, fields = read('roadcl_arc')
    widths = numeric(fields['RC_WIDTH'])
    # RC_RWIDTH (right-of-way) stands in where the carriageway is unrecorded.
    fallback = numeric(fields['RC_RWIDTH'])

    ax, ay, bx, by, wide = [], [], [], [], []
    for geom, width, alt in zip(geoms, widths, fallback):
        value = width if np.isfinite(width) and 1.5 <= width <= 60 else alt
        if not (np.isfinite(value) and 1.5 <= value <= 60):
            continue
        parts = get_parts(geom) if get_type_id(geom) in (5, 6, 7) else [geom]
        for part in parts:
            coords = get_coordinates(part)
            if len(coords) < 2:
                continue
            ax.append(coords[:-1, 0])
            ay.append(coords[:-1, 1])
            bx.append(coords[1:, 0])
            by.append(coords[1:, 1])
            wide.append(np.full(len(coords) - 1, value))

    if not ax:
        return np.full(len(node_x), np.nan), 0

    ax = np.concatenate(ax)
    ay = np.concatenate(ay)
    bx = np.concatenate(bx)
    by = np.concatenate(by)
    wide = np.concatenate(wide)
    print(f'  {len(ax):,} centreline segments carry a width')

    # Segments bucketed on a grid, so each junction only tests what is near.
    cell = WIDTH_SEARCH_M * 2
    buckets = {}
    for index in range(len(ax)):
        x0, x1 = sorted((ax[index], bx[index]))
        y0, y1 = sorted((ay[index], by[index]))
        for cx in range(int(x0 // cell), int(x1 // cell) + 1):
            for cy in range(int(y0 // cell), int(y1 // cell) + 1):
                buckets.setdefault((cx, cy), []).append(index)

    out = np.full(len(node_x), np.nan)
    for n in range(len(node_x)):
        px = node_x[n]
        py = node_y[n]
        cx = int(px // cell)
        cy = int(py // cell)
        candidates = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                candidates.extend(buckets.get((cx + dx, cy + dy), ()))
        if not candidates:
            continue
        pick = np.fromiter(candidates, dtype=np.int64)
        sx = ax[pick]
        sy = ay[pick]
        vx = bx[pick] - sx
        vy = by[pick] - sy
        length2 = vx * vx + vy * vy
        t = np.clip(((px - sx) * vx + (py - sy) * vy) / np.where(length2 > 0, length2, 1), 0, 1)
        distance = np.hypot(px - (sx + t * vx), py - (sy + t * vy))
        best = int(np.argmin(distance))
        if distance[best] <= WIDTH_SEARCH_M:
            out[n] = wide[pick[best]]
    return out, int(np.isfinite(out).sum())


def main():
    if not Path(GDB).exists():
        sys.exit(f'geodatabase not found: {GDB}\nPass its path as the first argument.')
    if not NETWORK.exists():
        sys.exit(f'{NETWORK} not found - run `npm run build:roads` first.')

    network = json.loads(NETWORK.read_text(encoding='utf-8'))
    lat = np.asarray(network['lat'], dtype=float)
    lng = np.asarray(network['lng'], dtype=float)
    cop30 = np.asarray(network['elev'], dtype=float)
    node_x, node_y = TO_UTM.transform(lng, lat)
    node_x = np.asarray(node_x)
    node_y = np.asarray(node_y)
    print(f'{len(lat):,} street junctions')

    print('Reading contours...')
    cx, cy, cz = contour_points('contour2m', 'Contour')
    fx, fy, fz = contour_points('contour', 'ELEVATION')
    bx, by, bz = benchmark_points()
    print(f'  contour2m {len(cz):,} vertices, contour {len(fz):,}, benchmarks {len(bz)}')

    sx = np.concatenate([cx, fx])
    sy = np.concatenate([cy, fy])
    sz = np.concatenate([cz, fz])

    pad = 500.0
    bounds = (sx.min() - pad, sy.min() - pad, sx.max() + pad, sy.max() + pad)

    # The surface, from the contours alone: they are dense and consistent,
    # and they are what gives the shape.
    print('Building the surface from the contours...')
    grid, known, x0, y0, res, nx, ny = build_surface(sx, sy, sz, bounds)

    # The datum, from the benchmarks. They are levelled marks and they do NOT
    # agree with the contours - see the note at the top of this file - so the
    # difference is measured and the whole surface is moved onto their datum.
    shift = 0.0
    if len(bz) > 0:
        residual = sample(grid, x0, y0, res, bx, by) - bz
        print(
            f'  contour surface at the {len(bz)} benchmarks: median {np.median(residual):+.2f} m, '
            f'MAE {np.mean(np.abs(residual)):.2f} m'
        )
        override = os.environ.get('CONTOUR_DATUM_SHIFT_M')
        shift = float(override) if override is not None else float(np.median(residual))
        after = residual - shift
        print(
            f'  datum shift {-shift:+.2f} m applied'
            + (' (from CONTOUR_DATUM_SHIFT_M)' if override is not None else ' (median of the above)')
        )
        print(
            f'  after the shift, the surface sits within median {np.median(np.abs(after)):.2f} m of a '
            f'benchmark, MAE {np.mean(np.abs(after)):.2f} m, p90 {np.percentile(np.abs(after), 90):.2f} m'
        )
        # What COP30 did at the same marks, for the before/after line.
        near = np.full(len(bz), np.nan)
        for index in range(len(bz)):
            distance = np.hypot(node_x - bx[index], node_y - by[index])
            best = int(np.argmin(distance))
            if distance[best] <= 25:
                near[index] = cop30[best] - bz[index]
        cop_at_marks = near[np.isfinite(near)]
        if len(cop_at_marks):
            print(
                f'  (COP30 at the {len(cop_at_marks)} of them within 25 m of a junction: '
                f'median {np.median(cop_at_marks):+.2f} m, MAE {np.mean(np.abs(cop_at_marks)):.2f} m)'
            )

    grid = grid - shift
    surveyed = sample(grid, x0, y0, res, node_x, node_y)

    # Which junctions the survey actually reaches.
    covered_mask = dilate(known, max(1, int(round(COVERAGE_M / res))))
    ix = np.clip(((node_x - x0) / res).astype(np.int64), 0, nx - 1)
    iy = np.clip(((node_y - y0) / res).astype(np.int64), 0, ny - 1)
    covered = covered_mask[iy, ix]

    # Outside it, keep COP30 less the plane fitted to its bias inside, so the
    # two surfaces meet without a step at the edge of the survey.
    bias = cop30 - surveyed
    fit = covered & np.isfinite(bias)
    if fit.sum() >= 100:
        design = np.column_stack([np.ones(fit.sum()), node_x[fit] - x0, node_y[fit] - y0])
        coefficients, *_ = np.linalg.lstsq(design, bias[fit], rcond=None)
        plane = coefficients[0] + coefficients[1] * (node_x - x0) + coefficients[2] * (node_y - y0)
        print(
            f'  COP30 bias inside the survey: median {np.median(bias[fit]):+.2f} m; '
            f'plane {coefficients[0]:+.2f} m at the SW corner'
        )
    else:
        plane = np.full(len(node_x), float(np.median(bias[fit])) if fit.any() else 0.0)

    elev = np.where(covered, surveyed, cop30 - plane)
    # Shoreline points sample water and come back slightly negative; the
    # water model wants road surfaces at or above sea level.
    elev = np.where(elev < 0, 0.0, elev)

    print(
        f'  {int(covered.sum()):,} of {len(elev):,} junctions ({100 * covered.mean():.1f}%) '
        f'take the surveyed surface; the rest keep de-biased COP30'
    )
    moved = elev - cop30
    print(
        f'  heights moved by median {np.median(moved):+.2f} m, '
        f'MAE {np.mean(np.abs(moved)):.2f} m, max {np.max(np.abs(moved)):.1f} m'
    )
    print(f'  range {elev.min():.1f} - {elev.max():.1f} m (was {cop30.min():.1f} - {cop30.max():.1f})')

    # Where the land meets the sea: the zero-metre contour.
    shore = np.abs(np.concatenate([cz, fz])) < 1e-6
    shore_x = np.concatenate([cx, fx])[shore]
    shore_y = np.concatenate([cy, fy])[shore]
    coastal = np.zeros(len(node_x), dtype=bool)
    if len(shore_x):
        cell = COASTAL_M
        buckets = {}
        for index in range(len(shore_x)):
            buckets.setdefault((int(shore_x[index] // cell), int(shore_y[index] // cell)), []).append(index)
        for n in range(len(node_x)):
            bx0 = int(node_x[n] // cell)
            by0 = int(node_y[n] // cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    picks = buckets.get((bx0 + dx, by0 + dy))
                    if not picks:
                        continue
                    index = np.fromiter(picks, dtype=np.int64)
                    if np.min(np.hypot(shore_x[index] - node_x[n], shore_y[index] - node_y[n])) <= COASTAL_M:
                        coastal[n] = True
                        break
                if coastal[n]:
                    break
    print(
        f'  {len(shore_x):,} shoreline vertices; {int(coastal.sum()):,} junctions within '
        f'{COASTAL_M:.0f} m of the shore'
    )

    print('Reading road widths...')
    width, matched = nearest_width(node_x, node_y)
    print(
        f'  {matched:,} of {len(width):,} junctions ({100 * matched / len(width):.1f}%) '
        f'sit within {WIDTH_SEARCH_M:.0f} m of a surveyed centreline'
    )
    if matched:
        good = np.isfinite(width)
        print(f'  width: min {width[good].min():.1f} m, median {np.median(width[good]):.1f} m, max {width[good].max():.1f} m')

    network['elev'] = [round(float(v), 3) for v in elev]
    network['width'] = [round(float(v), 1) if np.isfinite(v) else 0 for v in width]
    network['elevSource'] = [int(v) for v in covered]  # 1 = surveyed surface, 0 = de-biased COP30
    network['coastal'] = [int(v) for v in coastal]
    network['source'] = (
        'OpenStreetMap streets (ODbL); heights from Pattaya City contour2m, shifted to the '
        'benchmark datum (COP30 de-biased outside the survey); carriageway widths from roadcl_arc'
    )
    network['refined'] = {
        'surfaceResolutionM': res,
        'datumShiftM': round(float(shift), 3),
        'coveredJunctions': int(covered.sum()),
        'widthJunctions': matched,
        'defaultWidthM': DEFAULT_WIDTH_M
    }

    text = json.dumps(network, separators=(',', ':'))
    NETWORK.write_text(text, encoding='utf-8')
    print(f'Saved {NETWORK.name} ({len(text) / 1e6:.1f} MB)')
    print('Now re-run `npm run build:drainage` so the pipe model picks up the new ground levels.')


if __name__ == '__main__':
    main()
