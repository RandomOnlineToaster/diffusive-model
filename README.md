# Water Map — Chon Buri rainfall & street-flood prototype

An interactive map of Chon Buri Province (focused on Pattaya) that simulates
storms and routes the resulting water across terrain and streets.

- **Rainfall simulator** — place Gaussian storm cells on the map, give them a
  size, intensity, speed and bearing, and play time forward. Rain intensity
  follows `I(d) = Imax · e^(−d² / 2σ²)`, cut to zero past the rain radius.
- **Street flow** — a shallow-water model on the OSM street graph (266k
  junctions, heights sampled from the 30 m COP30 DEM). Water moves by
  **water-surface** slope using Manning's law, so a flooded downstream street
  backs water up onto its neighbours instead of swallowing it forever.
- **Flow paths / accumulation / direction** — D8 routing on the DEM analysis
  grid, for the catchment-scale picture.
- **Infrastructure layers** — rivers, water bodies, water gates, drainage
  pipes and sensor stations.

## Requirements

- Node 18+
- Python 3 with `numpy` and `tifffile` (only for the DEM/road build steps)
- A free [OpenTopography](https://opentopography.org/) API key (only to
  re-download the DEM)

## Setup

```bash
npm install
cp .env.example .env.local     # then set OPENTOPOGRAPHY_API_KEY
npm run dev
```

The derived data the app reads at runtime is committed, so it runs straight
after a clone — no API key needed unless you want to rebuild the DEM.

## Data pipeline

Raw DEM downloads are **not** committed: `chonburi-dem.asc` is ~210 MB, past
GitHub's file limit, and everything is reproducible.

| Command | What it does |
| --- | --- |
| `npm run fetch:dem` | Download the COP30 DEM, then build the browser cache |
| `npm run build:dem-cache` | Rebuild `chonburi-dem-cache.json` from a local DEM |
| `npm run fetch:roads` | Download OSM roads for the study bbox |
| `npm run build:roads` | Build the street graph with DEM-sampled heights |
| `npm run fetch:rivers` / `fetch:water` | Download OSM waterways and water bodies |
| `npm run build:pattaya` | Build pipe and sensor layers from the GIS exports in `data/pattaya` |

## Configuration

Every tunable lives in `.env.local`, documented in place — grid sizes, flow
thresholds, storm defaults, and the street-water physics (catchment width,
Manning roughness, drain capacity, kerb height, flood colour stops). Only
`VITE_*` variables reach the browser, which is why the API key never ships in
the bundle.

## Data sources

- Elevation: Copernicus GLO-30 (COP30) via OpenTopography
- Roads, waterways, water bodies: OpenStreetMap contributors (ODbL)
- Drainage pipes and sensor stations: SMART GIS database export
