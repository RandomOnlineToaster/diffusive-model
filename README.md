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
- **Drainage physics** — the surveyed drain network runs as a pipe graph
  under the streets: grated inlets take water down at a weir/orifice rate,
  pipes carry it by Manning's law from their surveyed diameters, outfalls
  discharge against the **tide** (and let the sea back in at high water),
  pump stations lift it out, and a manhole filled to its lid spills back
  onto the street. The ground soaks water on Horton's curve, new storm cells
  drift with the forecast **wind**, and an **ensemble** of jittered replays
  gives a flood chance per street. See *Drainage physics* below.
- **Flow paths / accumulation / direction** — D8 routing on the DEM analysis
  grid, for the catchment-scale picture. Flow Direction, Flow Paths and
  Street Flow are all drawn as moving particle trails, the way wind maps
  draw wind - coloured green to red by how much water they carry. Every
  chain in view carries flow, spaced a runner per 40 px of itself; the
  **Flow detail** slider trades that back for speed, keeping the longest
  share of the chains and dropping the rest, in the smooth style and in the
  classic Shift + tick dashes alike.
- **Weather** — live satellite cloud cover from
  [JAXA GSMaP](https://sharaku.eorc.jaxa.jp/GSMaP/), a gridded rainfall
  forecast with an hourly slider (Shift + drag rains it onto the simulator,
  hour by hour), and measured rainfall from the
  [Thai Meteorological Department](https://data.tmd.go.th/)'s own rain
  gauges — 127 stations nationwide, 14 of them inside the study area.
- **Drainage Network** — the city's surveyed drainage, from its GIS
  geodatabase: **Drainage Pipes** (gravity drains and box culverts, coloured
  by type and weighted by bore), **Drainage Covers** (manholes and grated
  inlets) and **Pump Stations** (the purple pump icons - the 64 the survey
  places plus Khao Noi from the city plan). Click any pipe or cover for its
  survey detail — size, material, manhole depth; click a pump for its rated
  flow, whether it is pumping and how much it has lifted. The covers are ~80k
  points, so that layer loads on first use and only draws once zoomed in to
  street level. A pump station lights up while it runs.

Every clickable thing on the map behaves the same way: hovering it shows a
small name tip and the pointer cursor, clicking it opens the same detail
card - a title, a label/value table, and where the data came from. That
goes for pump stations, tunnel and pole sensors, water gates, TMD rain
gauges, and the drainage pipes and covers alike.
- **Infrastructure layers** — rivers, water bodies, water gates, a demo pipe
  network (seeding the pipe simulation) and sensor stations.

## Drainage physics

Everything below is a **calculation function with stated assumptions**, so
better data - surveyed invert levels, real pump capacities, 2 m contours -
can replace an assumption without touching the maths. The formulas live in
`src/hydraulics.js` (pure, checked by `npm test`); the models in
`src/pipeNetwork.js` (pipes), `src/roadFlow.js` (streets), `src/tide.js`,
`src/wind.js` and `src/ensemble.js`.

| Piece | What it does | Assumption until better data arrives |
| --- | --- | --- |
| Pipe graph | `scripts/build-drainage-model.py` snaps the 4.5k surveyed drain runs into ~6.9k junctions and ~9.4k conduits, each with its surveyed size (round or box), material roughness and length | Ground = nearest street junction's height (now the city's own contours). **58 % of inverts are measured**: a manhole depth (`DEEP_MH`) within 15 m, else the depth to the back of the drain within 30 m; the rest still assume 0.6 m of cover (`PIPE_COVER_DEPTH_M`) |
| Pipe flow | Manning's equation on the **hydraulic grade line** between junctions, for the depth of flow in the pipe, in whichever direction the HGL slopes; a manhole is a tank (shaft + half of each pipe) that surcharges above the crown and spills onto its street at the lid | Shaft plan area from the cover survey where recorded, all 21 surveyed pump sumps from their footprints, else 1 m² |
| Inlets | Each grated cover feeds the nearest conduit at min(weir, orifice) capacity for the standing depth, half blocked by litter (`VITE_INLET_CLOGGING`), and only while the manhole has room | Grate 0.4 x 0.6 m where the survey has no size |
| Outfalls | A run end within 250 m of the coast is a **sea outfall** whose receiving level is the live sea level; one within 40 m of an OSM waterway is a canal outfall (free); a network with neither gets its lowest dead end as an outfall | Open outfalls: the tide flows back in (`VITE_OUTFALL_FLAP_VALVE`) |
| Pumps | 62 of the 64 surveyed stations sit on the graph; each pumps its sump out above a start depth until a stop depth | Every station 1 m³/s (`VITE_PUMP_RATED_M3S`) - the survey records names only |
| Sea level | Open-Meteo Marine hourly sea level (tide + surge), read a little offshore at the moment on the scenario's clock; a synthetic harmonic tide when offline; a **surge slider** adds metres on top | COP30 heights ~ metres above MSL |
| Streets | A street dead end **on the shore** (within 250 m of the zero-metre contour) and at or below 1.5 m meets the sea and drains against it - or takes it in when drowned; other dead ends discharge freely. Inside the surveyed area the inlets are the only way down; outside it the generic `VITE_STREET_DRAIN_MM_H` term stands in | 850 of them; the shoreline comes from the contours, the threshold is still a setting |
| Infiltration | The pervious share of wet ground (5 % of a street patch, 35 % of the flood strip past the kerb) soaks on Horton's curve, 60 -> 12 mm/h | Sandy loam everywhere |
| Wind | Open-Meteo hourly wind; a new storm cell drifts at 0.75 x the 850 hPa wind (or 1.5 x the 10 m wind when no wind aloft is served); surface wind, gusts and pressure show in the panel | |
| Ensemble | **Run ensemble** replays the placed storms N times from dry ground with jittered track, speed, bearing, size and intensity (seeded, so repeatable), records each street's peak depth, and paints the share of runs deeper than 5 cm | 8 members x 3 h at 5-minute steps, about 30 s |

The panel's *Sea level*, *Wind*, *In the drains* and *Absorbed* tiles show the
live state (hover for the water balance), the sample-point popup names the
nearest manhole and how full it is, and the **Drainage Pipes** layer
recolours each run by how full it runs while it rains.

Heights now come from the city's own 2 m contours on its benchmark datum
(MAE 0.69 m against the benchmarks, against COP30's 4.03 m), and the pipe
model reads its ground from the same array, so both improved together. What
remains is vertical detail: a 2 m contour interval settles where water goes
but not the 10-30 cm dips that set how deep it stands.

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

## Using the map

The page is a map with three layer boxes (Geography, Water Simulation,
Weather) and a side panel. Hover almost anything for its detail: layer names
carry hints, the panel tiles carry the full water balance, storm sliders
show their values, and pipes and covers open a survey card when clicked.

### 1. Place a storm and play it

1. Tick **Rainfall Simulator** in the Water Simulation box (it paints the rain
   and lets the water layers draw).
2. Click **Add storm**, then click the map where the cell should sit. The new
   cell drifts with the forecast steering wind (see the *Wind* tile); its
   card in the panel has sliders for peak intensity, size (σ), rain and cloud
   radius, speed and bearing, and a *Remove storm* button. Several storms can
   be placed; overlapping rain adds up. Drag a storm's centre on the map to
   move it.
3. Press **Play**. **Speed** is simulated seconds per real second (10x by
   default: a minute of storm every six seconds). **Reset** clears the storms
   and every drop of water.
4. Or skip the waiting: the **Outcome at** bar under *Flow detail* picks an
   hour of the storm's next 24. Drag it (or focus it and use the arrow keys -
   half an hour a press, an hour with Shift; Home and End for either end);
   the capsule reads the time, `+6:30`, the cells mark every third hour, and
   the storm tracks on the map stretch to that hour, ghosting where the
   cells will have got to. Letting go only *picks* the hour - the caption
   reads `6 h · press Play`, and nothing has run yet.

   **Play** goes there: it runs the scenario as far as that hour and no
   further (about two seconds for five, in 5-minute steps, with the bar
   tinting to show how much has been run), shows the storms, rain field,
   streets, pools and drains as they stand then, and **stops**. The ghosts
   come off - the water they predicted is now on the map - and the bar stays
   parked on that hour rather than chasing the clock; the sim time in the
   header is what counts on. Press Play again to run on from there. Asking
   for a later hour continues from where it got to rather than starting
   again, and an hour already run is instant. Any change to a storm, or
   Reset, throws the run away. While a forecast span is playing the bar is
   greyed out - the span drives the same clock.

A moving storm draws its **track**: a solid line back to where it was
placed and a dashed one ahead with an arrow, so where it came from and where
it is heading are always on the map - and when a fast cell has drifted clean
off it, the track is what says where it went. **Drag the ring on the end of
the track to aim the storm**: where you drop it is where the cell will be at
the horizon, which sets its speed and bearing together (the sliders read the
result back).

While an hour is being picked on the Outcome bar the track also **ghosts**
the cell at three times along the way, each labelled `+1:20` and drawn as
rings at one and two sigma inside the rain edge, so the ghost carries the
shape of the rain and not just its extent - which is the only way to see it
at all once the cell is beyond the rain grid, where the field cannot be
painted. The ghosts come off once that hour is on the map.

A parked storm has no track. Tracks are clipped to the study area, so a cell
that has drifted a thousand kilometres away during a forecast span costs
nothing to draw.

The rain field is painted on a canvas the size of the rain grid, so a cell
dragged out past the study area would otherwise read as a flat disc. Out
there it draws the same sigma rings instead, and the panel says plainly that
nothing it drops is being modelled - the grid *is* the model, and a storm
outside it rains 0 mm/h however hard its sliders are set.

The readouts show the peak rain rate now, the wettest cell's depth this
step, the total rain that has fallen and the water standing on the streets
right now. The line under the legend is a live probe of the cell under the
cursor. Click anywhere on the map for a **sample point** popup: elevation,
rain here, water on the ground, the deepest flooded street within 60 m and
the nearest drain with how full it is - it keeps updating while the storm
runs.

### 2. Watch where the water goes

| Layer | Shows | Notes |
| --- | --- | --- |
| **Street Flow** | While it rains: every wet street coloured by standing depth (green 0.5 cm → red 50 cm), with particle trails running the way the water is actually moving. Without rain: the terrain's steepest-descent routes | Hover a street for its depth and flow. **Flow detail** trades chains for speed |
| **Ponding** | The standing water itself: a blue band along each wet street, as wide as the ground the water has spread to (the street below the kerb, the 60 m catchment strip above it), darker the deeper - so a flooded block reads as a flooded block | Sits under the other layers. Needs real depth - a light shower drains before it ponds; the default 100 mm/h cell over central Pattaya floods within a few minutes |
| **Flow Direction / Flow Paths** | The 200 m grid's D8 field and channel tree; under rain the tree is lit where rain has recently fallen | Catchment scale, not street scale |
| **Catchment** | Upstream area (flow accumulation) draining through each grid cell - where flow converges | Not where water stands: that is Ponding |
| **Drainage Pipes** | The surveyed drain runs, coloured by type and weighted by bore; while it rains, recoloured by how full each run is (blue → red) | Click a run for size, material, length |
| **Drainage Covers** | Manholes (slate) and grated inlets (blue) | Draws from zoom 15 in. Click one for cover size, manhole depth, source |
| **Pump Stations** | The 65 stations as purple pump icons, lit while pumping | Click one for its rated flow (city plan or default), sump depth, and the volume it has lifted this run. Khao Noi is placed from the plan's description and says so |

Shift + click a flow layer's checkbox for its classic rendering (dashes, or
arrows for Flow Direction) instead of the particle trails.

### 3. The drainage tiles, surge and ensemble

Under the storm readouts:

- **Sea level** - the tide at the outfalls at this moment of the scenario
  (live Open-Meteo Marine forecast, synthetic tide when offline), plus the
  surge slider. Hover for the source.
- **Wind** - surface wind now; hover for gusts, pressure and the steering
  wind a new storm inherits.
- **In the drains** - water inside the surveyed pipes; hover for manholes
  surcharged, pumps running, discharged, back in from the sea, spilled.
- **Absorbed** - water the ground has soaked up plus the generic drains
  outside the surveyed area; hover for inlets, outfalls and sea backflow.
- **Storm surge** - metres added to the sea level, applied at once: push it
  up to see the beach outfalls drown and the sea come up the drains.
- **Run ensemble** - with at least one storm placed, replays the scenario
  eight times with jittered tracks, speeds, sizes and intensities (about
  30 s; the button becomes *Cancel*) and paints Street Flow as the chance
  each street floods deeper than 5 cm. Hover a street for "6 of 8 runs".
  Play or Reset clears it.

### 4. Rain a forecast instead

Tick **Rain Forecast (Open-Meteo)** (or **(TMD)** with a token in
`.env.local`) in the Weather box. The timeline in the panel shows the next
days hour by hour; click or drag along it to look at any hour, and the map
paints that hour's rain as a heatmap with the peak and day total beside it.
The orange marker is now.

To **play** it onto the simulator, tick Rainfall Simulator too, then
**Shift + drag** along the timeline: the span between the two red lines
plays from its start, at the speed slider's pace, re-weighting Flow Paths,
Catchment and Street Flow by the water as it goes. Play pauses and resumes,
Reset rewinds to the span's first hour, click inside the span to jump to a
moment, Shift + drag again to move its end, and a plain click outside it
clears it. Storms placed during a span rain into the same water. (Under a
forecast span the streets are routed at steady state - ponding, inlets,
tide and pumps only act on placed storms for now; see *Status*.)

**Cloud Cover** adds JAXA's satellite cloud tops for the latest available
hour; **Rain Gauges (TMD)** plots the provincial gauges with their 24 h
rainfall to 07:00 - the only measured ground truth on the map.

### 5. Things worth knowing

- Everything is tunable in `.env.local` (copy `.env.example`): storm
  defaults, street physics, inlet clogging, pump rates, tide mode, wind
  steering, ensemble size. Restart `npm run dev` after changing it.
- The street network covers Pattaya to Sattahip; rain outside it falls on
  nothing, and the panel says so.
- In the dev server, `window.__waterMap` in the browser console exposes the
  simulator and models for scripting, e.g. `__waterMap.rainfall.advance(600)`
  steps ten minutes and `__waterMap.roadFlow.dynamic.totals()` prints the
  water balance.

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
| `npm run extract:drainage` | Export the surveyed drains, covers and pump stations from the city geodatabase |
| `npm run refine:network` | Replace the street graph's COP30 heights with the city's 2 m contours on the benchmark datum, and add carriageway widths |
| `npm run build:drainage` | Build the pipe graph the simulation runs (`drainage-model.json`) from those exports and the street graph |
| `npm test` | Check the hydraulic formulas and the pipe model against known values |

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

### Raining the forecast onto the map

With the **Rainfall Simulator** layer and a rain-forecast layer both on,
**Shift + drag** on the forecast bar marks a span of the forecast between two
red lines; release, and the span plays onto the map - a day in about six
seconds at the default speed - with the tinted part of the bar showing how far
it has got. Each
forecast hour is taken as a steady rate over that hour (the data comes as
"so many mm between T and T + 1 h"); the grid's surface water integrates it
exactly, and Flow Paths, Flow Accumulation and Street Flow are re-weighted by
that water as it goes (Street Flow routes the runoff along the streets rather
than ponding it, so light rain still shows where it runs). Click or drag
inside the span to look at any moment of it, and Shift + drag to move its end,
forwards or back. The simulation controls above the divider drive the span as
well: **Play** pauses, resumes or replays it, **Reset** takes it back to its
first hour on dry ground, and the **speed** slider scales how fast it plays.

Storms rain into the same water: place one while a span is up and it joins the
scenario, raining from the moment it was placed and drifting on the span's
clock, so "a cell parks over Pattaya during this front" is one map rather than
two. Edit or move a storm and the span is re-rained with it; move it or turn
it part-way through and the track it has already laid stands, so a cell can sit
over a district for six hours and then drift off. Reset rewinds that whole
scenario rather than clearing it - a storm goes by its own Remove button, and
Reset only clears storms when there is no span to rewind. The simulator
paints only the storms while a span is up, since the forecast's own heatmap is
already on the map. A plain click outside the span clears it.

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

## How the simulation works - the maths

Water moves through the app in this order, and each stage below names the
file it lives in, the formula it uses and the constants it assumes. Units are
SI throughout (m, m², s, m³/s) except rain, which is quoted in mm/h.

### 1. Preparing the ground

**DEM grids** (`scripts/build-dem-cache.py`, `src/terrain.js`). The 30 m COP30
raster is resampled to a 512 × 512 analysis grid (~200 m cells) and a 256 ×
256 contour grid. Before routing, depressions are filled by *priority-flood*
(Barnes et al. 2014): every cell is raised to the lowest level from which it
can reach the grid edge or the coast, plus an epsilon of 1e-5 m per step so a
filled bowl still has a downhill direction across it. Slope is the central
difference `√((dz/dx)² + (dz/dy)²)`; flow direction is **D8** (steepest drop
to one of the eight neighbours); flow accumulation is a topological pass that
adds each cell's weight (1, or its rain depth in rain mode) to its downstream
cell, so a cell's value is the number of cells - or the mm of water - draining
through it. Contours are marching squares at 5/10/20/50 m intervals.

**Street graph** (`scripts/build-road-network.py`, `scripts/refine-road-network.py`,
`src/roadFlow.js`). OSM streets become a graph of 266k junctions and 273k
links; extra points are inserted every 20 m so height can vary along a
street. Heights start as **bilinear** COP30 samples and are then replaced,
for the 82 % of junctions the city survey reaches, by a surface interpolated
from its 2 m contours - see *Heights* below. Widths come from the survey's
road centrelines, and each junction is flagged coastal if it lies within
250 m of the zero-metre contour.
Shoreline points that sample water are clamped to 0 m. At load the heights are
cleaned: six passes clamp any junction more than 0.25 m from the mean of its
neighbours (building bleed), dead-end tips are held within 0.1 m below their
only neighbour, and depressions shallower than 0.35 m or spanning fewer than 3
junctions are filled (sampling noise). Sinks are then filled on the graph the
same priority-flood way (epsilon 1e-4 m), with outlets at every junction
within 1 m of the lowest height and every junction on the 1 % margin of the
downloaded box, and each junction's `downstream` is its lowest neighbour.

**Heights** (`scripts/refine-road-network.py`). The 391k vertices of
`contour2m` and `contour` are thinned to 8 m spacing and burned into a grid,
whose gaps are filled by Laplace relaxation run coarse to fine (320 m down to
20 m, each level seeding the next). That is the usual way to turn contours
into a raster and needs no SciPy. The result is then **shifted onto the
benchmark datum**: the contour surface reads +4.67 m at the city's 366
levelled benchmarks, near enough uniformly at every height, and COP30 agrees
with the contours to within a metre - so it is the benchmarks that stand
apart, and they are the ones to believe, being levelled marks and the only
ones that put Pattaya Beach Road at the 1-2 m it plainly is. After the shift
the surface sits within **0.54 m (median) of a benchmark, MAE 0.69 m, p90
1.41 m**, against COP30's MAE of 4.03 m. Outside the contours the COP30
height is kept less a plane fitted to its bias inside, so the two join
without a step. `CONTOUR_DATUM_SHIFT_M` overrides the shift.

**Drain graph** (`scripts/build-drainage-model.py`). Run ends within 3 m are
snapped into junctions; a run ending against the side of another run splits it
(T-junction). Size strings become a round diameter or a box `W × H` (values
over 20 are millimetres); Manning n is 0.011 for HDPE/PVC and 0.013 for
concrete. Each junction's ground is the nearest street junction's height.
Its invert is measured where the survey says how deep the drain runs - a
manhole depth (`DEEP_MH`) within 15 m for 3,337 junctions, the depth to the
back of the drain within 30 m for 656 more - and assumes 0.6 m of cover for
the remaining 42 %. Outfalls: a dead end within
250 m of the coast meets the sea, one within 40 m of an OSM waterway is free,
and a network with neither gets its lowest dead end as an outfall. Grated
covers become inlets on the nearest conduit with perimeter `2(w + l)` (or
`π·d`) and open area `w·l·0.5`.

### 2. Rain

**Storm cells** (`src/storm.js`, `src/rainfallGrid.js`) are Gaussians on a
400 × 400 grid over the DEM bounds (~260 m cells):

    I(d) = Imax · exp(−d² / 2σ²)     for d < rain radius, else 0

summed over overlapping cells (defaults Imax 100 mm/h, σ 1000 m, rain radius
3000 m, cloud radius 5000 m). A smooth value-noise field on an 8-cell lattice,
drifting with time, scales it by ±15 % so the disc is not perfectly round. A
cell moves at its velocity vector (m/s); a newly placed cell takes that vector
from the steering wind (see 5).

Each step adds `I · dt / 3600` mm to the cell's accumulation. The grid's own
*surface water* field decays as `ds/dt = I/3600 − s/τ` with τ = 900 s; at a
steady rate that has the closed form `s(t + dt) = s·e^(−dt/τ) + I·(τ/3600)·(1 −
e^(−dt/τ))`, which is why a whole forecast hour can be integrated in one call.
This field only weights the grid flow layers (Flow Paths / Accumulation) and
forecast Street Flow; the street ponding model takes the rain rate directly.

**Forecast rain** (`src/forecastRain.js`). Each forecast cell's "mm between T
and T + 1 h" becomes a steady rate `mm / hours` over that hour, laid onto the
rain grid by **bilinear interpolation** between the four forecast cells around
each rain-grid cell (a forecast cell is one figure for 10-35 km of country;
reading the nearest cell drew a cliff along every cell edge). Cells the
lattice lacks drop out and the remaining weights are renormalised. A moving storm laid over it is advanced in slices
no longer than half its rain radius at its speed (at most 600 slices per span),
placed at the middle of each slice so its track is even. Scrubbing backwards
re-rains the span from its start, so what is on screen is a pure function of
(span start, moment shown, storms).

### 3. Water on the streets (`src/roadFlow.js`)

State is a **volume** per junction. The ground a junction stands for is its
surveyed carriageway width times half of every street running into it -
`patch = width · halfLength`, 2 to 19 m of width where the city's centrelines
reach (23k junctions), the configured 120 m² elsewhere. It collects rain from
a strip 60 m wide along those same half-streets, of which 90 % runs off:

    runoffFactor = max(1, 0.9 · halfLength · 60 / patch)
    rain added   = I · dt/3.6e6 · patch · runoffFactor         [m³]

Depth comes from a two-stage stage-storage curve: up to the 0.15 m kerb the
water stands on the patch (`depth = V / patch`); above it the flood spreads
over the whole catchment strip (`depth = 0.15 + (V − kerbVolume) / stripArea`).

Every link moves water by **Manning's law on the water-surface slope**, never
the ground slope, which is what makes a full downstream street back water up:

    head = (z_a + d_a) − (z_b + d_b)
    v    = (1/n) · d^(2/3) · √(head / L)        n = 0.015, v ≤ 3 m/s
    ΔV   = min( d · v·dt/L , 0.25 · head ) · 120  [m³]   (never past a quarter of levelling)

A step is split into `min(8, ⌈3·dt/15⌉)` substeps. Each substep is two-phase:
all transfers are proposed from the frozen state, scaled so no junction sends
more than it holds, then landed together - order-independent and
mass-conserving. Films under 0.5 mm do not flow; volumes under 0.012 m³ snap
to dry (counted, so the balance still closes).

Water leaves a junction four ways, in this order each step:

* **Inlets** - each grated cover takes `min(1.66·P·d^1.5, 0.67·A·√(2·g·d)) ·
  (1 − clogging) · dt` (weir, then orifice; clogging 0.5), and only as much as
  the manhole below has room for.
* **Infiltration** - the pervious share of the wet area (5 % of a street
  patch, 35 % of the flood strip) soaks at Horton's rate `f = fc + (f0 − fc)·
  e^(−k·t)` with f0 60 mm/h, fc 12 mm/h, k 2/h, t = time since the junction got
  wet.
* **Generic drain** - only outside the surveyed network (no junction within
  150 m of a drain junction): at most 150 mm/h over the wet area.
* **Outfalls** - dead ends of the graph. Those at or below 1.5 m meet the
  sea: they discharge over a 20 m nominal edge to `max(tide, z − 0.5)`, and when
  the tide stands above the street water the same edge carries the sea IN, at
  Manning's rate for the depth it covers the street to. Other dead ends
  discharge over a nominal edge of slope `0.0005 + d/20`.

Severity colours are fixed depth stops: 0.5 cm (drawn), 5, 15, 30, 50 cm.

### 4. Water in the drains (`src/pipeNetwork.js`, `src/hydraulics.js`)

State is a volume per manhole; from it comes the water level - the
**hydraulic grade line** (HGL). A manhole is a tank: below the crown of its
pipes its plan area is `shaft + Σ(½ · pipe area · pipe length / pipe height)`
(filling it fills the near half of each pipe); above the crown only the shaft
fills (**surcharge**); at the street lid the excess **spills** onto the street
junction above it.

Each conduit moves water from its higher end at Manning's rate for the depth
of flow at that end, `y = min(HGL − invert, pipe height)`:

    circular: θ = 2·acos(1 − 2y/D),  A = D²/8·(θ − sin θ),  P = D·θ/2
    box:      A = W·y,  P = W + 2y      (full: P = 2(W + H))
    Q = (1/n) · A · (A/P)^(2/3) · √(ΔHGL / L),   Q ≤ 4 m/s · A
    ΔV = min( Q·dt , 0.25 · ΔHGL · A_a·A_b/(A_a + A_b) )

so a Ø0.60 concrete drain at 0.3 % carries about 0.34 m³/s full - roughly
200 m of street at 100 mm/h. Substeps are `min(30, ⌈4·dt / shortest conduit⌉)`
with the same two-phase scheme as the streets.

Outfalls discharge through a 20 m nominal conduit the size of the largest one
arriving. A **sea outfall**'s receiving level is the live sea level (or
`invert − 0.3` when the tide is lower); when the sea stands above the
manhole's HGL it flows *in* through the same pipe (backflow), unless flap
valves are switched on. A **free outfall** always drains to `invert − 0.3`.
**Pumps** start at 0.5 m sump depth and stop at 0.1 m, lifting 1 m³/s out of
the system.

### 5. Sea level and wind (`src/tide.js`, `src/wind.js`)

Sea level at the outfalls is Open-Meteo Marine's hourly `sea_level_height_msl`
(tide + surge), interpolated at the moment on the scenario's clock (the storm
clock counts from "now"; a forecast span uses its own time), plus the surge
slider's offset. Offline, the level is a harmonic tide

    η(t) = Σ a_i · cos(2π·t/T_i − φ_i)     K1 0.55 m, O1 0.35 m, M2 0.25 m, S2 0.10 m

which has Pattaya's mixed, mainly diurnal shape (~2 m range) but arbitrary
phase. COP30 heights (EGM2008) are taken as metres above mean sea level.

Wind is Open-Meteo's hourly 10 m wind, gusts and MSL pressure, plus the 850 hPa
wind where the model serves it. A new storm cell moves *towards* `direction +
180°` at `0.75 × the 850 hPa speed` (or `0.75 × 1.5 × the 10 m speed`);
directions are interpolated as vectors so 350° → 10° passes through north.

### 6. Ensemble (`src/ensemble.js`)

`Run ensemble` replays the placed storms N times from dry ground (default 8
members × 3 h in 5-minute steps). Member 1 is the storms as placed; the others
draw seeded Gaussian jitters - track ±1500 m, speed ±30 %, bearing ±25°,
intensity ±30 %, size ±20 % - so a run repeats exactly. Each member records
every junction's peak depth; the painted value is

    P(flood) = members with peak depth ≥ 5 cm / members

on fixed stops of 5, 20, 40, 60 and 80 %.

### 7. What it costs to run

The street model is 266k junctions and 273k links, but only the wet part of
it is ever stepped: each step collects the junctions holding water, their
links and their immediate neighbours, and every pass works on that set alone
(newly wet junctions join it as the water spreads). The drain network does
the same. The rain a junction receives is read straight out of the rain
grid's intensity array through a cell index built once, rather than
projected per junction per step. Nothing in the inner loops allocates: the
conduit section, the infiltration curve, the inlet capacity and the pump
rule are all written into reusable records or inlined.

Measured on a storm covering ~13k wet junctions, in a 5-minute step: streets
49 ms, drains 13 ms, rain grid 0.6 ms, a Street Flow rebuild 34 ms, a
Ponding repaint 3 ms. An outcome is run only as far as the hour asked for and
extended from its last snapshot afterwards: five hours takes about two
seconds, three more about 0.7 s, and restoring an hour already run (one
snapshot, plus replaying the rain grid to it) 40-140 ms.

### 8. Where the maps come from

*Flow Direction* and *Flow Paths* draw the D8 tree of the analysis grid (cells
above the 98.5th percentile of accumulation, or above 5,000 m³ of storm water
in rain mode); *Catchment* is that tree's upstream area (flow accumulation) -
where flow converges, not where water stands. *Street Flow* draws the street
chains carrying at least 25 upstream junctions - or, while it rains, the
standing depth from stage 3, chained along the LIVE flow: each wet junction
links to the neighbour it actually sent the most water to over the last
step, so a backed-up street shows its water heading upstream and standing
water ends a chain. *Ponding* paints each wet junction's depth over the area
it has spread to (the street patch below the kerb, the catchment strip above
it), so pools read as pools. The *Drainage Pipes* layer recolours each
surveyed run by `max(depth at either end) / pipe height` from stage 4; the
*Drainage Covers* layer draws the 80k covers from a grid index onto one
canvas, inlets in blue; the *Pump Stations* layer is one marker per
station, its class toggled by the model's pump state every half second.
Colour classes on the flow layers are
logarithmic in accumulation; on the streets and pipes they are the fixed
stops above, so a colour always means the same amount of water.

## Status - what it can do, what is left, what has to change

### What it can do now

- Place storm cells (Gaussian, moving, editable) or rain a real forecast
  span onto the map, and watch the water run along 266k street junctions
  with backwater, ponding and kerb overtopping.
- Pick any hour of a placed storm on the Outcome bar and press Play: the
  scenario runs to that hour (about two seconds for five) and stops there,
  extends rather than restarts when a later hour is asked for, and is kept
  as half-hourly snapshots, so going back to an hour already run is instant.
  Play again runs on from there. Storm tracks show where each cell has been
  and where it is going, ghost it along the way while an hour is being
  picked, and their end handle aims it.
- Drain that water the way the city does: 3,493 surveyed grated inlets into
  9,399 surveyed pipe runs, Manning flow by pipe size, trunks that fill and
  back up, manholes that surcharge and spill back onto the street, 141 beach
  outfalls that stop at high tide and let the sea in, 62 pump stations that
  lift water out, ground that soaks on Horton's curve.
- Read the live sea level (tide + surge) and wind, drift new storms with the
  steering wind, try a what-if surge with a slider, and run an ensemble of
  jittered storms to get a flood *chance* per street instead of one answer.
- Show all of it: flood depth per street on fixed colour stops with chains
  along the live flow, pools of standing water (Ponding), pipe fill per run, live water balances on the panel tiles, a sample-point popup with
  the nearest manhole, GSMaP cloud, two forecast providers and the TMD gauges.
- Run on the city's own survey where it has one: street heights from its 2 m
  contours on its benchmark datum, 58 % of pipe inverts from measured depths,
  real pump sump footprints, surveyed carriageway widths, and a shoreline test
  for which streets drain to the sea.
- Be checked against the city's own level sensors: the streets now shed water
  at the rate the road sensors show, and the pipes stay full for hours as the
  tunnel sensors show (see *Checked against the sensors*).
- Prove it conserves water: `npm test` plus a headless run close both balances
  to under 1e-5 m³.

### What is left to build

- **Forecast rain through the drains.** A forecast span still routes its
  runoff at steady state (`roadFlow.refresh`); it does not step the ponding
  and pipe models hour by hour, so tide, inlets and pumps only act on placed
  storms. The models are ready for it; the span's replay-on-scrub design is
  what has to change.
- **Forecast ensemble.** The ensemble jitters placed storms only. Open-Meteo
  serves ensemble members (`ensemble-api.open-meteo.com`) that could drive the
  same runner from real forecast spread.
- **Canals as channels.** Khlongs are drawn (OSM) but are not part of the
  routing: streets and pipes that reach one simply lose the water. A channel
  model with its own level would close the loop, and it is where the
  tide-versus-runoff conflict really plays out.
- **Water outside streets.** Runoff is only tracked on the street graph.
  Yards, car parks and open ground are the catchment strip's abstraction; a
  2-D overland grid would replace it.
- **Validation.** The city's 17 flood-risk polygons and the TMD gauges are on
  the map but nothing scores the model against them yet.
- Smaller: per-station pump rates once known; flap-valve list per outfall;
  TMD's 3-hourly gauge product (`Weather3Hours`) instead of the once-a-day
  24 h total; evaporation (negligible during a storm, not after it).

### What has to change - the data pass

The city geodatabase has now been mined for everything it already held:
heights, the vertical datum, the shoreline, pipe inverts, pump sumps and
carriageway widths are all measured rather than assumed. What is left needs a
new survey - levelled inverts, pump ratings, grate sizes, clogging. The full
inventory, applied and outstanding, is the next section.

## Numbers to replace

What the model runs on that is *assumed* rather than *measured*, and what
would replace it. Everything here is a config key or a build-script constant,
so replacing one is a data change, not a code change.

### Applied - taken from the city survey, no longer assumed

These were assumptions until the geodatabase was mined for what it already
held. `npm run refine:network` and `npm run build:drainage` produce them.

| Number | Was | Is now |
| --- | --- | --- |
| **Street heights** | COP30 30 m surface model: +3.9 m against the benchmarks, MAE 4.03 m, buildings and all | A surface interpolated from the city's 2 m contours (391k vertices), shifted onto the benchmark datum: **MAE 0.69 m, p90 1.41 m**, over the 82 % of junctions the contours reach. Outside them, COP30 less a fitted bias plane |
| **Vertical datum** | Unstated - COP30 heights compared straight against a tide quoted above MSL | Measured and reconciled: the contours read +4.67 m at the 366 benchmarks and COP30 agrees with the contours, so the benchmarks are the odd product out and the whole surface is shifted onto them (`CONTOUR_DATUM_SHIFT_M`) |
| **Which streets meet the sea** | Any dead end at or below 1.5 m - 23 of them, because COP30 stood every street metres too high | Dead ends within 250 m of the zero-metre contour AND at or below 1.5 m: 850 of them. Without the shoreline test the corrected heights would have let the tide into 1,553 streets, most of them inland |
| **Pipe inverts** | `ground - 0.6 m - pipe height` everywhere | **58 % measured**: a manhole depth (`DEEP_MH`) within 15 m for 3,337 junctions, the depth to the back of the drain within 30 m for 656 more; the rest still assume 0.6 m of cover |
| **Pump sump area** | 1 m² shaft, like any other manhole | All **21 surveyed sump footprints** (`ผังบ่อสูบน้ำ_polygon`), matched to their station |
| **Street patch area** | A flat 120 m² for all 266k junctions | The surveyed carriageway width times half of every street into the junction - 2 to 19 m of width across 23k junctions (`roadcl_arc`), 120 m² elsewhere |
| **Inlet density** | One inlet per 17 street junctions - only the 3,800 covers the survey classes as gratings | **One per street junction** over the drain (44,651), sized by the surveyed gratings beside it where there are any and by a default kerb opening where there are not. Calibrated against the city's road sensors - see *Checked against the sensors* |
| **Pump capacity** | 1 m³/s at every station | The city plan's rated flows at the 9 stations it names (0.99-10 m³/s), Khao Noi added at its described position; the rest keep the default |
| **Drain gradient** | Inverts followed the ground, so on the flat 22 % of runs had less than 1 in 1000 of fall and nowhere to send their water | Graded back from each outfall at a minimum 1 in 667 wherever the pipe can still be buried (`DRAIN_MIN_GRADE`): 3,689 junctions lifted, now 15 % under 1 in 1000 |

### Checked against the sensors

The city runs 58 level sensors on its drains and streets, archived at
6-minute resolution (`D:\Code\_SCS\data\sensor`, one CSV per station).
Reading every event where a level rose and fell back gives the behaviour the
model has to reproduce, and the two kinds of sensor say different things:

| Sensor | Typical event | Back to baseline | Fall rate |
| --- | --- | --- | --- |
| **ROAD** (11 stations, water on the street) | rises 1.31 m | **14 min** | **8.3 m/h** |
| **TUNNEL** (in the pipe) | rises 0.9 m | 2-5 h | 0.3 m/h |

So the street empties into the drain in minutes while the drain itself stays
full for hours. That two-timescale shape is the test, and the model failed
the first half of it: it took over twenty hours to shed a metre.

The figures above come from the 79-day per-station archive; the three-month
archive (`D:\Code\_SCS\data\alltime`, one 683 MB CSV, 6.6 million rows,
May-August 2026) gives the same numbers on twice the events - 3,288 road
events across 11 stations, 1,697 pipe events across 39 - so they are not a
quirk of one wet fortnight. The 16 stations with a flow meter are not usable
for calibrating conveyance: most read zero throughout and one reads 10³⁶.
The city's own plan agrees with the sensors: it puts the longest standing
water at **about two hours**, which is what the pipe sensors show and the
model reproduces at its deepest spots.

The cause was inlet density, not inlet size. One surveyed grating passes
about 5 m/h off its own patch at a metre's depth - the right order - but the
survey classes only 3,800 of its 79,929 covers as gratings, which left one
inlet per seventeen junctions, so each had to drain seventeen junctions'
worth. To match the sensors a junction needs roughly 0.3 m² of opening of
its own, which is a kerb inlet every 20 m: what a covered trench along a
kerb actually is. With one inlet per junction the streets now shed 636,000 m³
of a 1,032,000 m³ design storm through the inlets and the count of wet
junctions halves in about 40 minutes.

What is left is honest and worth stating: after the rain stops, the deepest
spots still get *worse* for half an hour or so, because surcharged manholes
push water back up (235,000 m³ of it in that storm). Water coming up out of
the drains is a real Pattaya phenomenon, but the model probably overdoes it.
Sweeping the plausible range of pump capacity (1 to 6 m³/s a station) and
grate clogging (20 % to 80 %) moves the result barely at all, so neither is
the binding constraint: it is **conveyance in the laterals**. Six inlets
feeding one junction can deliver about 2 m³/s, and a Ø0.6 m pipe at 1 in 200
carries 0.4 m³/s. Whether that is the city's real bottleneck or an artefact
of inverts derived from depths rather than levelled, only surveyed invert
levels will settle - which is why they head the list below.

### From the city's flood plan

The Sanitary Engineering Office's plan (`004.การรับมือปัญหาน้ำท่วมเมืองพัทยา`,
81 slides) is the other source the survey lacked. What it gives, and what
the model does with it:

| In the plan | Figure | Used how |
| --- | --- | --- |
| **Pump station capacities** | Sump 1 1.65, Sump 2 0.99, Sump 3 0.99, Sump 4 1.98, Sump 5 3.3, Sump 6 3.3 m³/s (Sukhumvit and the railway road, to the retention pond); PS7 at Walking Street 2 × 18,000 m³/h = 10 m³/s; PSK at Khlong Pluk Plub 3 × 9,000 m³/h = 7.5 m³/s; Khao Noi 6 × 3,600 m³/h = 6 m³/s | **Applied** to the 8 stations whose survey name matches (`PUMP_RATES_M3S` in `scripts/build-drainage-model.py`, read per pump at run time). Khao Noi has no counterpart in the survey's pump layer, so it is added from the plan's description (`EXTRA_PUMPS`: on the railway road just south of Sump 3, 44 m from the trunk it serves) and its marker says the position is approximate - move it when it is surveyed. The other 54 stations - mostly sewage lift stations - keep `VITE_PUMP_RATED_M3S` |
| Retention pond (แก้มลิง) | 100,000 m³, fed by Sumps 1-6 | Not modelled: the sumps pump "out of the system". Over one storm the pond is far from full; over a wet week it would not be |
| **Drainage capacity by area** | For the 2-year storm (68.9 mm/day): area 1 47.5 mm/day, area 2 24.8, area 3 51.0, area 4 60.6; for the 5-year (101.7 mm/day): 47.8, 24.4, 50.9, 61.0 | The next validation target: a day of steady rain at those rates over each area should just clear |
| Longest standing water | about 2 hours; ~30 % of the city floods (North 10.8 km², Central 11.0, South 17.7) | Matches the pipe sensors and the model's deepest spots |
| The five "water masses" | Routes the floods actually take - e.g. Soi Sukhumvit 45 → box under Sukhumvit → Soi Phaniat Chang → Mum Aroi junction → Pattaya 2nd Road → Soi 6/1 → Beach Road; Khao Noi station overflow → Sukhumvit-South Pattaya junction; Soi Nong Krabok → Soi Chularat and Thepprasit 7/9 | Qualitative validation for Flow Paths and Street Flow: the model's chains should trace these |
| Strategy | Railway road and Sukhumvit as barriers; Pattaya 3rd Road and 2nd Road / Jomtien 2nd Road as north-south collectors; the beach roads discharge to sea through PS7 and PS12 | Explains why the surveyed network is shaped as it is |

### How accurate is it likely to be

An estimate, not a measurement - the model has been checked against the
sensors' timescales and the plan's figures, never against a mapped flood.
By what you would ask of it:

| Question | Likely accuracy today | What limits it |
| --- | --- | --- |
| *Which streets flood first in a big storm?* | Fair - perhaps two thirds to three quarters of the city's known trouble spots should light up in the right order | Heights: 2 m contours on the benchmark datum, 0.69 m error against the benchmarks. A sag less than a metre deep is invisible to them, and the interpolation invents dips of its own |
| *How deep, at an address?* | Poor - a factor of two either way | The ponded area per junction (surveyed width × half a street, else 120 m²) and the 60 m catchment strip are assumptions; depth is volume over that area |
| *How long it stands* | Fair on the streets (model halves its wet count in 40 min, the road sensors clear in 14), about right in the pipes (hours) | Lateral conveyance: assumed inverts, one kerb inlet per junction |
| *How full each drain runs* | Poor per run, fair as a whole | 58 % of inverts are a default 0.6 m cover, then graded; the survey has no pipe levels |
| *City-wide volumes - ponded, drained to sea, pumped* | Fair - within about a third | Rain input, outfall and pump totals are the constrained parts; both water balances close to numerical precision |
| *Anything more than ~6 hours ahead from a forecast* | Governed by the rain forecast, not the hydraulics | A convective cell's forecast position is off by tens of kilometres and its intensity by a factor of two; the drainage model cannot recover that |

In short: a qualitative-to-semi-quantitative tool. Trust it for *where* and
*roughly how long*, and for comparing scenarios (a pump off, a storm from
another bearing, a higher tide); do not trust a depth to the centimetre.
What moves each row is in the tiers below - levelled inverts first, then
half-metre heights, then the inlets.

### Tier 1 - what still matters most

| Number | Now | Where | Replace with |
| --- | --- | --- | --- |
| **Levelled inverts** | 58 % from depth measurements, then graded back from the outfalls at a minimum fall; no true invert levels exist in the survey | `nodes.invert[]`, `DRAIN_MIN_GRADE` | Levelled inverts with slopes. **The biggest single unknown**: the sensor check above pins the remaining error on how much the laterals can carry, which is what inverts decide |
| **Pump capacity, the other 54** | 1 m³/s each, start 0.5 m / stop 0.1 m sump depth; the 8 the plan names are now rated | `VITE_PUMP_RATED_M3S`, `VITE_PUMP_START_DEPTH_M`, `VITE_PUMP_STOP_DEPTH_M` | Ratings and float-switch levels for the rest, and a surveyed position for the Khao Noi station (placed from the plan's description). Rating the big eight moved a design storm little - the water cannot reach the pumps fast enough - so this matters *after* the inverts are known |
| **Inlet clogging** | 50 % of every grate blocked | `VITE_INLET_CLOGGING` | Inspection data; realistically seasonal |
| **Grate size** | 0.4 x 0.6 m where the survey has none; 50 % open area | `DEFAULT_GRATE_M`, `GRATE_OPEN_FRACTION` | Survey the unsized grates; 307 grates are also unattached (no pipe within 40 m or street within 25 m) |
| **Infiltration** | Horton 60 -> 12 mm/h, k = 2/h (sandy loam); pervious 5 % of a street patch, 35 % of the strip | `VITE_INFILTRATION_*`, `VITE_PERVIOUS_*` | Soil map or infiltrometer tests; pervious share from land cover |
| **Sub-metre relief** | 2 m contour interval: right for where water goes, too coarse for how deep it stands | the contour surface | Levelling or LiDAR. The 0.69 m MAE is the floor on ponding depth accuracy until then |

### Tier 2 - shape the answer noticeably

| Number | Now | Where | Replace with |
| --- | --- | --- | --- |
| Catchment strip width | 60 m either side of a street, 90 % runoff | `VITE_STREET_CATCHMENT_WIDTH_M`, `VITE_STREET_RUNOFF_COEFF` | Block/parcel geometry; runoff coefficient by land cover |
| Generic drain outside the survey | 150 mm/h per patch (a capacity) | `VITE_STREET_DRAIN_MM_H` | Extend the drain survey, or nothing - it is a stand-in |
| Sea / canal / free outfalls | coast within 250 m = sea; OSM waterway within 40 m = canal; 49 networks got their lowest dead end declared an outfall | `DRAIN_SEA_OUTFALL_M`, `DRAIN_CANAL_OUTFALL_M`, `nodes.kind[]`, `nodes.assumedOutfall[]` | Confirm each outfall and which have flap valves (`VITE_OUTFALL_FLAP_VALVE` is one global switch) |
| Pipe roughness | n = 0.013 concrete, 0.011 HDPE/PVC | `MANNING_N` in `build-drainage-model.py` | Fine for new pipe; aged or silted concrete runs 0.015-0.02 |
| Street roughness, speed, kerb | n = 0.015, v <= 3 m/s, kerb 0.15 m | `VITE_STREET_MANNING_N`, `VITE_STREET_MAX_FLOW_MS`, `VITE_STREET_CURB_M` | Standard values; kerb height varies by road |
| Pipe size where unparseable | Ø0.60 m | `DEFAULT_SIZE_M` | Survey; the four "pressure main" runs are also treated as gravity pipes |

### Tier 3 - numerical or scenario choices

| Number | Now | Where |
| --- | --- | --- |
| Nominal outfall edges | street: 20 m, slope 0.0005, 0.5 m drop; pipe: 20 m conduit, 0.3 m drop, v <= 4 m/s | `src/roadFlow.js`, `src/pipeNetwork.js` - stability constants, not physics |
| Snap distances | pipe ends 3 m; junction ground from a street within 60 m; pump within 80 m | `scripts/build-drainage-model.py` |
| Rain-grid surface decay | tau = 900 s | `VITE_RAIN_DRAIN_TAU_S` - only weights the catchment layers, not the streets |
| Storm noise | +/- 15 % | `VITE_RAIN_NOISE` - cosmetic |
| Harmonic tide fallback | K1 0.55, O1 0.35, M2 0.25, S2 0.10 m, arbitrary phases | `src/hydraulics.js` - synthetic; the Ko Sichang or Laem Chabang gauge's constants would make offline mode honest |
| Wind steering | 0.75 x the 850 hPa wind; 1.5 x the surface wind when no upper wind is served | `VITE_STORM_STEERING_FACTOR`, `VITE_STORM_STEERING_SURFACE_FACTOR` |
| Ensemble jitter | track +/- 1500 m, speed +/- 30 %, bearing +/- 25°, intensity +/- 30 %, size +/- 20 %; threshold 5 cm | `VITE_ENSEMBLE_*` - guesses; a nowcast verification study would calibrate them |
| Forecast sampling | Open-Meteo's 8-11 km model sampled at `VITE_FORECAST_GRID` points per side over 3x the area (10 -> 35 km cells) | set 20, or `VITE_FORECAST_AREA_SCALE=2` for the model's own resolution |
| Rain observations | TMD once-a-day 24 h totals at 5 provincial gauges | `src/weather.js` - TMD's 3-hourly `Weather3Hours`, or the city's own sensors |

**Already textbook, no data needed:** the weir and orifice coefficients
(1.66 / 0.67), Manning's equation, the section geometry, gravity - `npm test`
pins them.

**Validate against, once the data is in:** the city's 17 flood-risk polygons
(`พื้นที่เสี่ยงต่อการเกิดน้ำท่วม`) and the TMD gauges - the model should
reproduce the first from real rain at the second.

## Data sources

- Elevation: Copernicus GLO-30 (COP30) via OpenTopography
- Cloud cover: JAXA Global Satellite Mapping of Precipitation (GSMaP)
- Rainfall forecast: Thai Meteorological Department, with Open-Meteo as a keyless fallback
- Roads, waterways, water bodies: OpenStreetMap contributors (ODbL)
- Drainage network (pipes and covers): Pattaya City GIS geodatabase
  (`Data_Pattaya.gdb`, feature datasets `drain` / `water_pipe`), extracted to
  WGS84 GeoJSON by `scripts/extract-drainage.py`
- Sensor stations and their level archives: SMART GIS database export
  (58 stations, 6-minute levels, May-August 2026; used to calibrate the street drainage)
- Pump capacities, drainage capacity per area and flood routes: Pattaya City
  Sanitary Engineering Office flood-response plan (`004.การรับมือปัญหาน้ำท่วมเมืองพัทยา`)
