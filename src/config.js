// Browser-side settings. Vite exposes only VITE_* variables from .env / .env.local,
// so the OpenTopography API key in the same file never reaches the bundle.
// Grid sizes are NOT here: they are baked into the DEM cache at build time by
// scripts/build-dem-cache.py, and read back from the cache file itself.

function readFlag(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

// Comma-separated list of numbers; falls back wholesale when any entry is
// bad or the values do not strictly increase (colour stops must be ordered).
function readNumberList(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = String(value)
    .split(',')
    .map((part) => Number(part.trim()));

  const valid =
    parsed.length === fallback.length &&
    parsed.every(
      (entry, index) => Number.isFinite(entry) && entry > 0 && (index === 0 || entry > parsed[index - 1])
    );

  return valid ? parsed : fallback;
}

// One of a fixed set of words, or the fallback.
function readChoice(value, choices, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  return choices.includes(text) ? text : fallback;
}

function readNumber(value, fallback, { min, max } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (min !== undefined && parsed < min) {
    return min;
  }

  if (max !== undefined && parsed > max) {
    return max;
  }

  return parsed;
}

const env = import.meta.env ?? {};

export const config = {
  // Fill depressions before deriving flow. Without this every pit swallows its
  // inflow and the drainage network breaks into disconnected fragments.
  fillSinks: readFlag(env.VITE_FILL_SINKS, true),

  // How many analysis cells beyond the province border the flow layers may
  // draw. Routing still uses the whole DEM; this only limits what is rendered.
  flowBoundaryBuffer: readNumber(env.VITE_FLOW_BOUNDARY_BUFFER, 2, { min: 0, max: 64 }),

  // Fill depressions in the street graph before routing. Off leaves ~43% of
  // junctions with nowhere to drain, and almost nothing accumulates.
  roadFlowFillSinks: readFlag(env.VITE_ROAD_FLOW_FILL_SINKS, true),

  // --- street water physics (dynamic rain model) ---
  // Streets are the neighbourhood's gutters: each junction collects the rain
  // falling on a strip of land either side, not just on the wet asphalt.
  // Total strip width in metres (both sides together)...
  streetCatchmentWidthM: readNumber(env.VITE_STREET_CATCHMENT_WIDTH_M, 60, { min: 0, max: 500 }),
  // ...and the share of that rain that actually runs off (urban ~0.9).
  streetRunoffCoeff: readNumber(env.VITE_STREET_RUNOFF_COEFF, 0.9, { min: 0, max: 1 }),
  // Water speed follows Manning's law, v = (1/n) * depth^(2/3) * sqrt(slope):
  // shallow sheets crawl and pond, deep trunk flow races and flushes out.
  // Manning roughness of the street surface (asphalt gutters ~0.015)...
  streetManningN: readNumber(env.VITE_STREET_MANNING_N, 0.015, { min: 0.008, max: 0.2 }),
  // ...and an upper clamp on the resulting velocity, m/s.
  streetFlowMaxMs: readNumber(env.VITE_STREET_MAX_FLOW_MS, 3, { min: 0.2, max: 10 }),
  // Generic street drainage OUTSIDE the surveyed drain network: streets there
  // lose at most this equivalent rainfall rate, mm/h, per street patch. A
  // capacity, not a proportion: heavier input than this floods, and a pond
  // clears at a steady centimetre per ~4 minutes. Inside the surveyed area
  // the inlets and pipes below replace it.
  streetDrainMmPerHour: readNumber(env.VITE_STREET_DRAIN_MM_H, 150, { min: 0, max: 3000 }),

  // --- absorption: what takes water off the streets besides the drains ---
  // Infiltration follows Horton's curve (see hydraulics.js): dry ground soaks
  // at f0, saturated ground at fc, decaying between them at k per hour.
  // 60 -> 12 mm/h at k = 2 is a sandy loam, about what Pattaya's coastal
  // plain is; clay would be 25 -> 3.
  infiltrationF0MmPerHour: readNumber(env.VITE_INFILTRATION_F0_MM_H, 60, { min: 0, max: 1000 }),
  infiltrationFcMmPerHour: readNumber(env.VITE_INFILTRATION_FC_MM_H, 12, { min: 0, max: 1000 }),
  infiltrationDecayPerHour: readNumber(env.VITE_INFILTRATION_K_PER_H, 2, { min: 0, max: 100 }),
  // Only the pervious share of a surface infiltrates: cracks and verges on
  // the street patch itself, gardens and yards on the catchment strip that a
  // flood spreads onto past the kerb.
  perviousStreetFraction: readNumber(env.VITE_PERVIOUS_STREET, 0.05, { min: 0, max: 1 }),
  perviousStripFraction: readNumber(env.VITE_PERVIOUS_STRIP, 0.35, { min: 0, max: 1 }),
  // Share of every grated inlet blocked by litter and silt. 0.5 halves what
  // a clean grate would take (hydraulics.js inletCapture).
  inletClogging: readNumber(env.VITE_INLET_CLOGGING, 0.5, { min: 0, max: 0.99 }),
  // Street junctions within this distance of a surveyed drain junction are
  // "inside" the drain network: their only way down is an inlet. Beyond it
  // the generic drain term above still applies, because nothing is surveyed.
  drainCoverageRadiusM: readNumber(env.VITE_DRAIN_COVERAGE_RADIUS_M, 150, { min: 10, max: 2000 }),
  // A street outfall (a dead end of the street graph) at or below this
  // height is taken to meet the sea, and drains against the tide; higher
  // ones discharge freely off the edge of the map.
  seaOutfallMaxElevM: readNumber(env.VITE_SEA_OUTFALL_MAX_ELEV_M, 1.5, { min: 0, max: 20 }),
  // A junction this close to the shoreline meets the sea whatever else its
  // street connects to: water standing at the water's edge runs off the edge,
  // it does not follow the road along the coast looking for a dead end. The
  // surveyed shoreline is sampled about every 13 m, so 60 m reaches the
  // beachfront carriageway without reaching the block behind it (180
  // junctions at 60 m, 1,263 at 100 m).
  seaOutfallShoreM: readNumber(env.VITE_SEA_OUTFALL_SHORE_M, 60, { min: 0, max: 250 }),
  // A junction this close to OPEN WATER - a khlong, a river, a lake, a
  // reservoir - sheds into it. That is the third way water leaves a street,
  // after the grates and the ground, and the one the city's flood plan
  // routes its water masses down; without it, runoff that had already run
  // downhill to a bank still had to wait for a grate. The same 40 m the
  // drainage model uses for its own canal outfalls (7,479 junctions; 12,766
  // at 60 m). 0 turns street open-water outfalls off.
  canalOutfallM: readNumber(env.VITE_CANAL_OUTFALL_M, 40, { min: 0, max: 250 }),
  // Depressions in the street DEM shallower than this are filled before the
  // water model runs. COP30 resolves height to metres, so a shallower bowl is
  // sampling noise - and a pit traps water that can only leave by the drain,
  // showing as a lone deep puddle that outlasts the storm. Deeper basins are
  // kept, because ponding there is real.
  streetMaxNoisePitM: readNumber(env.VITE_STREET_MAX_NOISE_PIT_M, 0.35, { min: 0, max: 5 }),
  // A depression spanning no more than this many junctions is filled whatever
  // its depth: real basins cover a stretch of streets, while a one- or
  // two-junction hollow is a sampling artefact.
  streetMinBasinNodes: readNumber(env.VITE_STREET_MIN_BASIN_NODES, 3, { min: 0, max: 50 }),
  // Height of the kerb, metres. Below it water stands on the street patch
  // alone; above it the flood spreads over the junction's catchment strip,
  // so depth (and severity) grows much more slowly past this point.
  streetCurbDepthM: readNumber(env.VITE_STREET_CURB_M, 0.15, { min: 0.02, max: 1 }),
  // Flood severity colour stops in metres of standing water, green to red.
  // The first value is also the draw threshold: streets show green as soon
  // as half a centimetre stands on them, then darken with depth.
  streetFloodDepthsM: readNumberList(
    env.VITE_STREET_FLOOD_DEPTHS_M,
    [0.005, 0.05, 0.15, 0.3, 0.5]
  ),

  // --- underground drainage model (src/pipeNetwork.js) ---
  // Run the surveyed drain network under the streets: inlets take street
  // water down, pipes carry it by Manning's law, outfalls meet the tide and
  // pump stations lift it out. Needs public/data/drainage-model.json from
  // `npm run build:drainage`; without the file the streets fall back to the
  // generic drain term everywhere.
  enableDrainageModel: readFlag(env.VITE_ENABLE_DRAINAGE_MODEL, true),
  // Which engine routes the water under the streets (src/hydro/drainage.js).
  // `diffusive` is this repo's model - Manning on the hydraulic grade line,
  // documented in full in docs/formulas.md. `swmm` hands the pipes to EPA
  // SWMM 5.2 compiled to WebAssembly, leaving the street model untouched, so
  // the two can be compared with everything else held identical. Vite reads
  // this at server start: changing it needs a RESTART, not a reload.
  drainageEngine: readChoice(env.VITE_DRAINAGE_ENGINE, ['diffusive', 'swmm'], 'diffusive'),
  // Upper clamp on the water speed inside a pipe, m/s.
  pipeFlowMaxMs: readNumber(env.VITE_PIPE_MAX_FLOW_MS, 4, { min: 0.5, max: 10 }),
  // Flap valves on the sea outfalls stop the tide flowing back up the
  // pipes. Pattaya's outfalls are open, so the default lets the sea in.
  outfallFlapValve: readFlag(env.VITE_OUTFALL_FLAP_VALVE, false),
  // Pump stations: the survey names them but records no capacity, so every
  // station runs at this rate (m3/s) once its sump is this deep, until it
  // has pumped down to the stop depth.
  pumpRatedM3s: readNumber(env.VITE_PUMP_RATED_M3S, 1.0, { min: 0, max: 50 }),
  pumpStartDepthM: readNumber(env.VITE_PUMP_START_DEPTH_M, 0.5, { min: 0.05, max: 5 }),
  pumpStopDepthM: readNumber(env.VITE_PUMP_STOP_DEPTH_M, 0.1, { min: 0, max: 5 }),
  // Ground area one street junction represents, for mm <-> m3 conversion.
  streetPatchAreaM2: readNumber(env.VITE_STREET_PATCH_M2, 120, { min: 10, max: 2000 }),

  // --- sea level (src/tide.js) ---
  // auto: the Open-Meteo Marine sea-level forecast, falling back to a
  // synthetic harmonic tide when it cannot be fetched. harmonic: always the
  // synthetic tide. manual: a fixed level, VITE_TIDE_MANUAL_M metres MSL.
  tideMode: readChoice(env.VITE_TIDE_MODE, ['auto', 'harmonic', 'manual'], 'auto'),
  tideManualM: readNumber(env.VITE_TIDE_MANUAL_M, 0, { min: -3, max: 5 }),
  // Starting position of the panel's surge slider: metres added on top of
  // whichever source is active, for what-if storm surges.
  tideSurgeM: readNumber(env.VITE_TIDE_SURGE_M, 0, { min: -2, max: 3 }),

  // --- wind (src/wind.js) ---
  // A newly placed storm cell drifts with the forecast steering wind instead
  // of standing still. Its sliders still override it afterwards.
  stormFollowsWind: readFlag(env.VITE_STORM_FOLLOWS_WIND, true),
  // A cell moves at about this share of the 850 hPa wind...
  stormSteeringFactor: readNumber(env.VITE_STORM_STEERING_FACTOR, 0.75, { min: 0, max: 2 }),
  // ...and when no wind aloft is available, the 10 m wind is scaled up by
  // this much to stand in for it.
  stormSteeringSurfaceFactor: readNumber(env.VITE_STORM_STEERING_SURFACE_FACTOR, 1.5, {
    min: 0.5,
    max: 4
  }),

  // --- ensemble (src/ensemble.js) ---
  // "Run ensemble" replays the placed storms this many times with their
  // tracks, speeds, sizes and intensities jittered, and paints how often each
  // street floods deeper than the threshold. Member 1 is the unjittered run.
  ensembleMembers: readNumber(env.VITE_ENSEMBLE_MEMBERS, 8, { min: 2, max: 64 }),
  ensembleDurationHours: readNumber(env.VITE_ENSEMBLE_HOURS, 3, { min: 0.25, max: 48 }),
  ensembleStepSeconds: readNumber(env.VITE_ENSEMBLE_STEP_S, 300, { min: 10, max: 3600 }),
  ensembleThresholdM: readNumber(env.VITE_ENSEMBLE_THRESHOLD_M, 0.05, { min: 0.005, max: 2 }),
  // One-sigma jitters: metres of track offset, fractions of speed, size and
  // intensity, and degrees of bearing.
  ensembleTrackSigmaM: readNumber(env.VITE_ENSEMBLE_TRACK_SIGMA_M, 1500, { min: 0, max: 50000 }),
  ensembleSpeedSigma: readNumber(env.VITE_ENSEMBLE_SPEED_SIGMA, 0.3, { min: 0, max: 2 }),
  ensembleBearingSigmaDeg: readNumber(env.VITE_ENSEMBLE_BEARING_SIGMA_DEG, 25, { min: 0, max: 180 }),
  ensembleIntensitySigma: readNumber(env.VITE_ENSEMBLE_INTENSITY_SIGMA, 0.3, { min: 0, max: 2 }),
  ensembleSizeSigma: readNumber(env.VITE_ENSEMBLE_SIZE_SIGMA, 0.2, { min: 0, max: 2 }),

  // Under a placed storm the grid flow layers draw channels carrying at least
  // this many cubic metres of surface water - an ABSOLUTE amount, not a
  // fraction: a share of the total would divide out as everything drains
  // uniformly, and the network would never visibly dry. Forecast rain is
  // light and falls everywhere, so it keeps the uniform view's density
  // (flowNetworkPercentile) instead.
  flowRainMinM3: readNumber(env.VITE_FLOW_RAIN_MIN_M3, 5000, { min: 1, max: 1e7 }),

  // --- live weather layers ---
  // GSMaP is hourly and lands a few hours behind real time; asking for "now"
  // returns empty tiles. JAXA's own latest-frame marker is not readable from
  // the browser (no CORS header), so the lag is a setting.
  gsmapLatencyHours: readNumber(env.VITE_GSMAP_LATENCY_H, 5, { min: 1, max: 48 }),
  cloudLayerOpacity: readNumber(env.VITE_CLOUD_OPACITY, 0.65, { min: 0.05, max: 1 }),
  // CARTO basemap key for the grey "Light" base. CARTO watermarks keyless
  // raster tiles ("API KEY REQUIRED"); with a key the sharp Positron style is
  // used, without one the map falls back to Esri's keyless Light Gray Canvas.
  // A basemap key is a client-side credential (restricted by allowed domain at
  // carto.com), so it is exposed in the bundle by design - but kept in
  // .env.local, never committed.
  cartoBasemapKey: env.VITE_CARTO_KEY || '',
  // TMD only allows its own origin in CORS, so its JSON goes through the dev
  // server proxy declared in vite.config.js.
  tmdProxyPath: env.VITE_TMD_PROXY_PATH || '/tmd',
  // OAuth token for TMD's nwpapi grid forecast. With it the forecast layer
  // draws TMD's own ~3 km grid; without it, the keyless fallback provider.
  tmdToken: env.VITE_TMD_TOKEN || '',
  // 2 = hourly, 72 h, ~3 km. 1 = 3-hourly, 10 days, ~9 km.
  tmdForecastDomain: readNumber(env.VITE_TMD_DOMAIN, 2, { min: 1, max: 2 }),
  // Fallback grid: points per side over the study bounds, and how many days.
  forecastGridSteps: readNumber(env.VITE_FORECAST_GRID, 20, { min: 2, max: 24 }),
  // The forecast covers this many times the study area in each direction,
  // centred on it, so weather approaching from outside is visible before it
  // arrives. 3 means a 3x3 block with the study area as the middle tile.
  forecastAreaScale: readNumber(env.VITE_FORECAST_AREA_SCALE, 3, { min: 1, max: 5 }),
  // TMD's grid is far denser, and its docs warn about wide boxes, so its
  // area grows more modestly than the keyless fallback's.
  tmdAreaScale: readNumber(env.VITE_TMD_AREA_SCALE, 1.5, { min: 1, max: 5 }),
  // Hours of TMD grid to request. Its area endpoint takes about a minute to
  // answer whatever the span, and 24 h of the study area is already ~2 MB.
  tmdForecastHours: readNumber(env.VITE_TMD_FORECAST_HOURS, 24, { min: 1, max: 72 }),
  // Below this zoom the chance-of-rain chip is hidden: it keeps its pixel
  // size while the province shrinks under it, and ends up captioning half
  // of Thailand.
  forecastChipMinZoom: readNumber(env.VITE_FORECAST_CHIP_MIN_ZOOM, 9, { min: 0, max: 22 }),
  forecastDays: readNumber(env.VITE_FORECAST_DAYS, 7, { min: 1, max: 16 }),
  forecastGridOpacity: readNumber(env.VITE_FORECAST_OPACITY, 0.5, { min: 0.05, max: 1 }),
  // Ceiling on drawn forecast cells; TMD at 3 km over the province exceeds it.
  forecastMaxCells: readNumber(env.VITE_FORECAST_MAX_CELLS, 1500, { min: 50, max: 20000 }),
  // TMD's published demo credentials. Register at data.tmd.go.th for your own.
  tmdUid: env.VITE_TMD_UID || 'api',
  tmdUkey: env.VITE_TMD_UKEY || 'api12345',

  // --- rainfall simulator ---
  // Grid the storm model runs on, across the DEM bounds. 400 gives ~260 m cells
  // over Chon Buri, fine enough to resolve a 3 km storm.
  rainGridSize: readNumber(env.VITE_RAIN_GRID_SIZE, 400, { min: 32, max: 1200 }),
  // Spatial variation applied after the Gaussian, so the Gaussian stays
  // dominant. 0.15 is +/-15%; 0 disables it.
  rainNoiseAmplitude: readNumber(env.VITE_RAIN_NOISE, 0.15, { min: 0, max: 0.5 }),
  // How far back the water is run for a moment picked on the forecast bar:
  // from dry ground this many hours before it. A rain event is over in a few
  // hours and the streets clear in minutes, so earlier rain does not change
  // the picture, and the cost of any pick is bounded by this.
  //
  // 0 turns the water off for a forecast span altogether: the rain is drawn
  // and routed along the streets as it was before the models were wired to
  // it, which costs nothing. The ceiling is a week, the length of the
  // forecast itself - honest, but a whole week of water is tens of minutes
  // of computing for one pick.
  forecastWaterWindowHours: readNumber(env.VITE_FORECAST_WATER_WINDOW_H, 3, { min: 0, max: 168 }),
  // How fast surface water drains away, as an exponential time constant in
  // simulated seconds. 900 s means roughly 10 minutes to half-drain.
  rainDrainTauSeconds: readNumber(env.VITE_RAIN_DRAIN_TAU_S, 900, { min: 60, max: 86400 }),
  // Defaults for a newly placed storm cell.
  stormMaxIntensity: readNumber(env.VITE_STORM_MAX_INTENSITY, 100, { min: 1, max: 500 }),
  stormSigma: readNumber(env.VITE_STORM_SIGMA, 1000, { min: 100, max: 20000 }),
  stormRainRadius: readNumber(env.VITE_STORM_RAIN_RADIUS, 3000, { min: 200, max: 50000 }),
  stormCloudRadius: readNumber(env.VITE_STORM_CLOUD_RADIUS, 5000, { min: 200, max: 80000 }),

  // Minimum upstream junctions before a street counts as a runoff route.
  roadFlowMinUpstream: readNumber(env.VITE_ROAD_FLOW_MIN_UPSTREAM, 25, { min: 1, max: 100000 }),

  // Draw flow as traced downstream paths instead of per-cell arrows.
  // Minimum upstream cells before a cell counts as a channel worth drawing.
  // Raising it thins the network to the major stems.
  flowPathMinUpstream: readNumber(env.VITE_FLOW_PATH_MIN_UPSTREAM, 150, { min: 1, max: 100000 }),
  flowPathSteps: readNumber(env.VITE_FLOW_PATH_STEPS, 150, { min: 2, max: 2000 }),
  // Draw Flow Paths and Street Flow as moving colour-classed trails riding
  // the traced lines, the way Flow Direction is drawn. Off, or with reduced
  // motion requested, solid colour-classed lines are drawn instead.
  flowPathAnimate: readFlag(env.VITE_FLOW_PATH_ANIMATE, true),
  // Classic (Shift + tick) rendering: below this zoom the marching dashes are
  // drawn solid. Zoomed out, a whole chain can be shorter than one dash
  // period, so the animation reads as a blinking dot rather than as flow
  // direction. 12 is the 3 km scale bar; the blinking sets in at 5 km.
  flowDashMinZoom: readNumber(env.VITE_FLOW_DASH_MIN_ZOOM, 12, { min: 0, max: 22 }),

  // Shift + drag on the forecast timeline marks a span of the forecast that
  // plays onto the map when released, at this many forecast hours per real
  // second with the simulator's speed slider at its default 10x - a day in
  // six seconds. The slider scales it from there, and more steeply than one
  // for one, so its slow end is slow enough to watch a band cross the map.
  forecastPlayHoursPerSecond: readNumber(env.VITE_FORECAST_PLAY_HOURS_PER_S, 4, {
    min: 0.25,
    max: 48
  }),

  // Flow arrows are markers, so the analysis grid gets thinned down to roughly
  // this many before drawing.
  flowArrowCount: readNumber(env.VITE_FLOW_ARROW_COUNT, 350, { min: 0, max: 5000 }),

  // Draw Flow Direction as drifting particles with fading trails, the way
  // wind maps draw wind. Off, or with reduced motion requested, the static
  // arrows are drawn instead.
  flowParticles: readFlag(env.VITE_FLOW_PARTICLES, true),
  // Particles on screen at once on a large viewport; small ones get fewer.
  flowParticleCount: readNumber(env.VITE_FLOW_PARTICLE_COUNT, 2500, { min: 100, max: 20000 }),

  // Clip the map layers to the Chon Buri polygon. The analysis grid always
  // stays full-extent: catchments cross provincial borders, so masking it
  // would truncate anything draining in from a neighbouring province.
  clipToBoundary: readFlag(env.VITE_CLIP_TO_BOUNDARY, true),

  // Trim OSM river lines to the province. Separate from clipToBoundary because
  // the DEM rectangle is often worth seeing in full while stray waterways in
  // neighbouring provinces are just noise.
  clipRivers: readFlag(env.VITE_CLIP_RIVERS, true),

  // Cells above this percentile of flow accumulation are drawn as the drainage
  // network. 0.985 keeps the top 1.5% of cells, which reads as stream lines.
  flowNetworkPercentile: readNumber(env.VITE_FLOW_NETWORK_PERCENTILE, 0.985, {
    min: 0,
    max: 0.9999
  })
};
