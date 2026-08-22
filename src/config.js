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
  // Street drains and soakage remove at most this equivalent rainfall rate,
  // mm/h, per street patch. A capacity, not a proportion: heavier input than
  // this floods, and a pond clears at a steady centimetre per ~4 minutes.
  // Streets collect their catchment (roughly x7 rain), so this sits well
  // above raw rainfall rates: working inlets take puddles away in minutes.
  streetDrainMmPerHour: readNumber(env.VITE_STREET_DRAIN_MM_H, 150, { min: 0, max: 3000 }),
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

  // --- underground pipe model ---
  // Couple the streets to the underground pipes. Off until real pipe
  // cross-sections and invert levels arrive; without them the pipe half of
  // the coupling is guesswork.
  enablePipeDrainage: readFlag(env.VITE_ENABLE_PIPE_DRAIN, false),
  // Flow speed inside the pipes. Without invert levels a Manning velocity
  // cannot be computed per segment, so one typical storm-drain speed stands in.
  pipeFlowVelocityMs: readNumber(env.VITE_PIPE_FLOW_VELOCITY_MS, 1.2, { min: 0.1, max: 6 }),
  // Cross-section area is not recorded in the database, so it is estimated as
  // shapeFactor x heightRef^2: 1.0 treats the bore as a square box culvert,
  // 0.785 as a circular pipe.
  pipeShapeFactor: readNumber(env.VITE_PIPE_SHAPE_FACTOR, 1.0, { min: 0.2, max: 2 }),
  // Street junctions within this range of a pipe drain into it instead of the
  // generic drain term.
  pipeInletRadiusM: readNumber(env.VITE_PIPE_INLET_RADIUS_M, 45, { min: 5, max: 300 }),
  // How quickly an inlet swallows street water (time constant, sim seconds).
  pipeInletTauSeconds: readNumber(env.VITE_PIPE_INLET_TAU_S, 300, { min: 30, max: 7200 }),
  // Ground area one street junction represents, for mm <-> m3 conversion.
  streetPatchAreaM2: readNumber(env.VITE_STREET_PATCH_M2, 120, { min: 10, max: 2000 }),

  // Rain-driven flow thresholds are ABSOLUTE amounts of water, not fractions:
  // a share of the total would divide out as everything drains uniformly, and
  // the network would never visibly dry. Grid channels need this many cubic
  // metres of surface water passing through to be drawn...
  flowRainMinM3: readNumber(env.VITE_FLOW_RAIN_MIN_M3, 5000, { min: 1, max: 1e7 }),
  // ...and street chains this much surface water, in mm summed over junctions.
  roadFlowRainMin: readNumber(env.VITE_ROAD_FLOW_RAIN_MIN, 300, { min: 1, max: 1e6 }),

  // --- live weather layers ---
  // GSMaP is hourly and lands a few hours behind real time; asking for "now"
  // returns empty tiles. JAXA's own latest-frame marker is not readable from
  // the browser (no CORS header), so the lag is a setting.
  gsmapLatencyHours: readNumber(env.VITE_GSMAP_LATENCY_H, 5, { min: 1, max: 48 }),
  cloudLayerOpacity: readNumber(env.VITE_CLOUD_OPACITY, 0.65, { min: 0.05, max: 1 }),
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
  // Marching dashes show flow direction, at the cost of SVG rendering.
  flowPathAnimate: readFlag(env.VITE_FLOW_PATH_ANIMATE, true),
  // Below this zoom the marching dashes are drawn solid. Zoomed out, a whole
  // chain can be shorter than one dash period, so the animation reads as a
  // blinking dot rather than as flow direction. 12 is the 3 km scale bar;
  // the blinking sets in at 5 km (zoom 11) and wider.
  flowDashMinZoom: readNumber(env.VITE_FLOW_DASH_MIN_ZOOM, 12, { min: 0, max: 22 }),

  // Flow arrows are markers, so the analysis grid gets thinned down to roughly
  // this many before drawing.
  flowArrowCount: readNumber(env.VITE_FLOW_ARROW_COUNT, 350, { min: 0, max: 5000 }),

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
