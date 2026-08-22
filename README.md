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
- **Weather** — live satellite cloud cover from
  [JAXA GSMaP](https://sharaku.eorc.jaxa.jp/GSMaP/), a gridded rainfall
  forecast with an hourly slider, and measured rainfall from the
  [Thai Meteorological Department](https://data.tmd.go.th/)'s own rain
  gauges — 127 stations nationwide, 14 of them inside the study area.
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

- **GSMaP** (cloud cover) serves ordinary XYZ tiles, so they drop straight
  into Leaflet. The product is hourly and lands a few hours behind real time,
  and JAXA's "latest frame" marker is not readable from a browser (no CORS
  header), so `VITE_GSMAP_LATENCY_H` controls how far back to look. Grids are
  0.1° (~11 km) — the tiles upscale past that, they do not sharpen. The layer
  is clipped to the DEM bounds: the tiles are global, and unbounded Leaflet
  fetches and composites them across the whole visible world.
- **TMD** allows only its own site in CORS, so its JSON is proxied by the dev
  server (`/tmd` → `data.tmd.go.th`, see `vite.config.js`). A static
  production deploy has no proxy, so the forecast layer reports itself
  unavailable instead of failing silently. The credentials default to TMD's
  published demo pair; register for your own at
  <https://data.tmd.go.th/>.

### Rain gauges

`Rain Gauges (TMD)` plots the TMD stations inside the study area with their
observed rainfall in millimetres, sized and coloured by amount, with
temperature, humidity, wind and pressure in the popup. Keyless, and the only
**measured** ground truth available without registering — useful for checking
both the forecast and the flood model against what actually fell.

Five of TMD's 127 national stations fall in Chon Buri: Chon Buri, Ko Sichang,
Laem Chabang, Pattaya and Sattahip. Pattaya's sits almost exactly on the
simulation centre. The filter accepts stations *inside or just offshore* of
the province, because coastal gauges sit on piers and reclaimed land outside
the land polygon — Laem Chabang's deep-sea port is a couple of kilometres out
and would otherwise be dropped.

Note the difference between the three TMD products: the free forecast gives a
*chance of rain* per province, the free observations give *millimetres* at
points, and only the token-gated `nwpapi` gives *millimetres on a grid*.

### Forecast resolution

The rain forecast layer draws a **grid** of cells with an hour-by-hour slider,
from whichever provider is available:

| Provider | Resolution | Horizon | Needs |
| --- | --- | --- | --- |
| TMD `nwpapi` domain 2 | ~3 km, hourly | 72 h | OAuth token |
| TMD `nwpapi` domain 1 | ~9 km, 3-hourly | 10 days | OAuth token |
| Open-Meteo (fallback) | ~8 km, hourly | 7 days (16 max) | nothing |

The forecast is fetched over a wider box than the study area — `VITE_FORECAST_AREA_SCALE=3` means a 3x3 block with the study area in the middle — so weather approaching from the Gulf or from Rayong is visible before it arrives. A 20x20 sample over that box is 400 points and about 1.7 MB; the request is a GET, and past roughly 600 points the URL grows too long to send.

Set `VITE_TMD_TOKEN` and the layer switches to TMD automatically; the label
and slider name the live source. If TMD errors, it falls back rather than
losing the layer. Without any grid, it drops to TMD's keyless province
outlook — one chance-of-rain figure per province per day, tinting the whole
boundary, which is all that endpoint publishes.

Cells are drawn as a smoothed heatmap rather than hard squares: values are
painted one pixel per grid cell, upscaled with bilinear filtering and a light
blur, so the coarse lattice reads as the continuous wash a rain forecast is
normally shown as. The colour scale is log-spaced over 0.1-25 mm/h, the range
a real forecast occupies - the simulator's 0.5-100 mm/h storm scale left
almost every cell in its first band.

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
- Cloud cover: JAXA Global Satellite Mapping of Precipitation (GSMaP)
- Rainfall forecast: Thai Meteorological Department, with Open-Meteo as a keyless fallback
- Roads, waterways, water bodies: OpenStreetMap contributors (ODbL)
- Drainage pipes and sensor stations: SMART GIS database export
