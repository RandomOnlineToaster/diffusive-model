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
- **Weather** — live satellite cloud cover and observed rain from
  [JAXA GSMaP](https://sharaku.eorc.jaxa.jp/GSMaP/), plus the province
  rainfall forecast from the
  [Thai Meteorological Department](https://data.tmd.go.th/).
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

## Weather data

Both sources work without registration, but they have quirks worth knowing:

- **GSMaP** (cloud + observed rain) serves ordinary XYZ tiles, so they drop
  straight into Leaflet. The product is hourly and lands a few hours behind
  real time, and JAXA's "latest frame" marker is not readable from a browser
  (no CORS header), so `VITE_GSMAP_LATENCY_H` controls how far back to look.
  Grids are 0.1° (~11 km) — the tiles upscale past that, they do not sharpen.
- **TMD** allows only its own site in CORS, so its JSON is proxied by the dev
  server (`/tmd` → `data.tmd.go.th`, see `vite.config.js`). A static
  production deploy has no proxy, so the forecast layer reports itself
  unavailable instead of failing silently. The credentials default to TMD's
  published demo pair; register for your own at
  <https://data.tmd.go.th/>.

### Forecast resolution

The rain forecast layer draws a **grid** of cells with an hour-by-hour slider,
from whichever provider is available:

| Provider | Resolution | Horizon | Needs |
| --- | --- | --- | --- |
| TMD `nwpapi` domain 2 | ~3 km, hourly | 72 h | OAuth token |
| TMD `nwpapi` domain 1 | ~9 km, 3-hourly | 10 days | OAuth token |
| Open-Meteo (fallback) | ~8 km, hourly | 3 days | nothing |

Set `VITE_TMD_TOKEN` and the layer switches to TMD automatically; the label
and slider name the live source. If TMD errors, it falls back rather than
losing the layer. Without any grid, it drops to TMD's keyless province
outlook — one chance-of-rain figure per province per day, tinting the whole
boundary, which is all that endpoint publishes.

TMD's docs warn that a wide box pulls a lot of data — the province at 3 km is
roughly ten thousand points — so cells are thinned evenly to
`VITE_FORECAST_MAX_CELLS`.

## Configuration

Every tunable lives in `.env.local`, documented in place — grid sizes, flow
thresholds, storm defaults, and the street-water physics (catchment width,
Manning roughness, drain capacity, kerb height, flood colour stops). Only
`VITE_*` variables reach the browser, which is why the API key never ships in
the bundle.

## Data sources

- Elevation: Copernicus GLO-30 (COP30) via OpenTopography
- Cloud and observed rain: JAXA Global Satellite Mapping of Precipitation (GSMaP)
- Rainfall forecast: Thai Meteorological Department, with Open-Meteo as a keyless fallback
- Roads, waterways, water bodies: OpenStreetMap contributors (ODbL)
- Drainage pipes and sensor stations: SMART GIS database export
