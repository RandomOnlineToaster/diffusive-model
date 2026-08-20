import json
import contextlib
import io
import itertools
import os
import zipfile
from pathlib import Path

import numpy as np
import tifffile


HEADER_KEYS = {
    "ncols",
    "nrows",
    "xllcorner",
    "yllcorner",
    "xllcenter",
    "yllcenter",
    "cellsize",
    "nodata_value",
}

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PROJECT_ROOT / "public" / "data" / "chonburi-dem.json"
OUTPUT_PATH = PROJECT_ROOT / "public" / "data" / "chonburi-dem-cache.json"


def read_env(name, fallback):
    """Read a setting from the environment, then .env.local, then .env."""
    if os.environ.get(name):
        return os.environ[name]

    for file_name in (".env.local", ".env"):
        env_path = PROJECT_ROOT / file_name
        if not env_path.exists():
            continue

        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue

            key, _, value = stripped.partition("=")
            if key.strip() == name:
                return value.strip().strip('"')

    return fallback


def read_grid_size(name, fallback):
    """Grid sizes are square: DEM_ANALYSIS_GRID=512 means 512 x 512."""
    raw = read_env(name, fallback)
    try:
        size = int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be a whole number, got {raw}")

    if size < 2:
        raise SystemExit(f"{name} must be at least 2, got {size}")

    return size


# Display grid: one interactive Leaflet polygon per cell, so keep it small.
PREVIEW_SIZE = read_grid_size("DEM_PREVIEW_GRID", 24)
# Analysis grid: drives slope, flow direction and flow accumulation.
ANALYSIS_SIZE = read_grid_size("DEM_ANALYSIS_GRID", 512)
CONTOUR_SIZE = read_grid_size("DEM_CONTOUR_GRID", 256)
SAMPLE_SIZE = read_grid_size("DEM_SAMPLE_GRID", 512)


def main():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    data_path = PROJECT_ROOT / "public" / manifest.get("dataPath", manifest.get("tifPath")).lstrip("/")

    print(
        f"Grid sizes: preview {PREVIEW_SIZE}, analysis {ANALYSIS_SIZE}, "
        f"contour {CONTOUR_SIZE}, sample {SAMPLE_SIZE}",
        flush=True,
    )

    if manifest.get("outputFormat") == "AAIGrid" or data_path.suffix.lower() in {".asc", ".zip"}:
        raster, bounds, no_data = read_ascii_grid(data_path)
    else:
        with tifffile.TiffFile(data_path) as tif:
            page = tif.pages[0]
            with contextlib.redirect_stderr(io.StringIO()):
                raster = page.asarray().astype(np.float32)
            bounds = read_tiff_bounds(page, manifest)
        no_data = None

    raster = clean_elevation(raster, no_data)
    print(f"Resampling {raster.shape[1]} x {raster.shape[0]} source grid...", flush=True)

    # Averaging keeps each cell honest about the block it covers. Point sampling
    # is kept for the hover readout, which asks about one location, not an area.
    preview = resample_mean(raster, PREVIEW_SIZE, PREVIEW_SIZE)
    analysis = resample_mean(raster, ANALYSIS_SIZE, ANALYSIS_SIZE)
    contour = resample_nearest(raster, CONTOUR_SIZE, CONTOUR_SIZE)
    sample = resample_nearest(raster, SAMPLE_SIZE, SAMPLE_SIZE)
    valid = contour[np.isfinite(contour)]

    cache = {
        "source": manifest.get("source", "OpenTopography"),
        "dataset": manifest.get("dataset", "DEM"),
        "resolutionMeters": manifest.get("resolutionMeters"),
        "dataPath": manifest.get("dataPath", manifest.get("tifPath")),
        "bounds": bounds,
        "minElevationMeters": round(float(np.min(valid)), 1) if valid.size else 0,
        "maxElevationMeters": round(float(np.max(valid)), 1) if valid.size else 0,
        "previewGrid": grid_payload(preview),
        "analysisGrid": grid_payload(analysis),
        "contourGrid": grid_payload(contour),
        "sampleGrid": grid_payload(sample),
        "notes": [
            "Browser-friendly DEM cache derived from the local DEM download.",
            "Negative sea values are treated as empty cells for terrain preview layers.",
            "previewGrid draws the map squares; analysisGrid drives slope and flow.",
            "Grid sizes come from the DEM_*_GRID settings in .env.local.",
        ],
    }

    OUTPUT_PATH.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    size_mb = OUTPUT_PATH.stat().st_size / (1024 * 1024)
    print(f"Saved DEM browser cache to {OUTPUT_PATH} ({size_mb:.1f} MB)")


def read_tiff_bounds(page, manifest):
    model_pixel_scale = page.tags.get("ModelPixelScaleTag")
    model_tiepoint = page.tags.get("ModelTiepointTag")

    if model_pixel_scale and model_tiepoint:
        scale_x, scale_y, _ = model_pixel_scale.value
        _, _, _, origin_x, origin_y, _ = model_tiepoint.value
        height, width = page.shape
        return {
            "west": origin_x,
            "east": origin_x + width * scale_x,
            "south": origin_y - height * scale_y,
            "north": origin_y,
        }

    return manifest["bounds"]


def read_ascii_grid(path):
    text_stream = open_ascii_grid(path)
    with text_stream:
        header = {}
        first_data_line = None

        # COP30 grids omit NODATA_value, so the header is 5 lines instead of 6.
        # Read until a line no longer looks like a header entry.
        while True:
            line = text_stream.readline()
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

        missing = {"ncols", "nrows", "cellsize"} - header.keys()
        if missing:
            raise SystemExit(f"{path.name}: missing header fields {sorted(missing)}")

        rows = int(header["nrows"])
        columns = int(header["ncols"])
        no_data = header.get("nodata_value")

        print(f"Reading {columns} x {rows} grid from {path.name}...", flush=True)
        data_lines = (
            itertools.chain([first_data_line], text_stream)
            if first_data_line is not None
            else text_stream
        )
        raster = np.loadtxt(data_lines, dtype=np.float32, max_rows=rows)

    if raster.ndim == 1:
        raster = raster.reshape(1, -1)

    if raster.shape != (rows, columns):
        if raster.size != rows * columns:
            actual_rows = raster.size / columns
            raise SystemExit(
                f"{path.name}: truncated grid. Header declares {rows} rows x {columns} columns "
                f"({rows * columns} cells) but only {raster.size} cells were read "
                f"(~{actual_rows:.0f} rows, {100 * actual_rows / rows:.1f}% of the area from the "
                f"north edge). Re-run npm run fetch:dem to download the DEM again."
            )
        raster = raster.reshape((rows, columns))

    cell_size = header["cellsize"]
    west = header.get("xllcorner", header.get("xllcenter"))
    south = header.get("yllcorner", header.get("yllcenter"))

    if "xllcenter" in header:
        west -= cell_size / 2

    if "yllcenter" in header:
        south -= cell_size / 2

    bounds = {
        "west": west,
        "east": west + columns * cell_size,
        "south": south,
        "north": south + rows * cell_size,
    }
    return raster, bounds, no_data


def open_ascii_grid(path):
    if path.suffix.lower() != ".zip":
        return path.open("r", encoding="utf-8")

    archive = zipfile.ZipFile(path)
    asc_name = next(
        name for name in archive.namelist()
        if name.lower().endswith((".asc", ".txt"))
    )
    return io.TextIOWrapper(archive.open(asc_name), encoding="utf-8")


def clean_elevation(raster, no_data):
    cleaned = raster.copy()
    cleaned[~np.isfinite(cleaned)] = np.nan
    if no_data is not None:
      cleaned[cleaned == no_data] = np.nan
    cleaned[cleaned < 0] = np.nan
    cleaned[cleaned > 9000] = np.nan
    return cleaned


def resample_nearest(raster, columns, rows):
    source_rows, source_columns = raster.shape
    row_indices = np.clip(
        ((np.arange(rows) + 0.5) * source_rows / rows).astype(int),
        0,
        source_rows - 1,
    )
    column_indices = np.clip(
        ((np.arange(columns) + 0.5) * source_columns / columns).astype(int),
        0,
        source_columns - 1,
    )
    return raster[row_indices[:, None], column_indices[None, :]]


def resample_mean(raster, columns, rows):
    """Average every source pixel inside a target cell, ignoring empty ones."""
    source_rows, source_columns = raster.shape

    # reduceat needs strictly increasing edges, which only holds when downsampling.
    if rows >= source_rows or columns >= source_columns:
        return resample_nearest(raster, columns, rows)

    row_edges = (np.arange(rows) * source_rows // rows).astype(int)
    column_edges = (np.arange(columns) * source_columns // columns).astype(int)

    valid = np.isfinite(raster)
    filled = np.where(valid, raster, 0.0).astype(np.float64)

    sums = np.add.reduceat(np.add.reduceat(filled, row_edges, axis=0), column_edges, axis=1)
    counts = np.add.reduceat(
        np.add.reduceat(valid.astype(np.float64), row_edges, axis=0), column_edges, axis=1
    )

    with np.errstate(invalid="ignore", divide="ignore"):
        averaged = sums / counts

    averaged[counts == 0] = np.nan
    return averaged.astype(np.float32)


def grid_payload(values):
    rows, columns = values.shape
    rounded = np.round(values.astype(float), 1)
    payload_values = [
        None if not np.isfinite(value) else float(value)
        for value in rounded.reshape(-1)
    ]
    return {
        "columns": columns,
        "rows": rows,
        "values": payload_values,
    }


if __name__ == "__main__":
    main()
