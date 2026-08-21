import L from 'leaflet';
import { config } from './config.js';


// Gridded rainfall forecast, from whichever provider is available.
//
//   TMD nwpapi  -> official, ~3 km hourly (domain 2) or ~9 km 3-hourly
//                  (domain 1). Needs an OAuth token, and its CORS policy
//                  names only its own site, so it goes through the vite proxy.
//   Open-Meteo  -> keyless fallback, ~8 km hourly. Not Thai government data.
//
// Both are reduced to the same shape, so the renderer and the time slider
// never learn which one answered:
//
//   { source, resolutionText, cellLat, cellLng, times[], points[] }
//   points[] = { lat, lng, rain[] }   one rain figure per entry in times[]

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// Forecast rain needs its own colour scale. The simulator's runs 0.5 to
// 100 mm/h because a placed storm is a cloudburst; a real forecast for
// Chon Buri sits between a trace and about 20 mm/h, so on that scale almost
// every cell landed in the first band and the map looked empty. These stops
// spread the range a forecast actually occupies, in the blue-green-yellow-red
// order weather maps use.
const FORECAST_STOPS = [
  { mmPerHour: 0.1, color: [191, 219, 254] },
  { mmPerHour: 0.5, color: [96, 165, 250] },
  { mmPerHour: 1, color: [37, 99, 235] },
  { mmPerHour: 2, color: [22, 163, 74] },
  { mmPerHour: 4, color: [163, 230, 53] },
  { mmPerHour: 8, color: [234, 179, 8] },
  { mmPerHour: 15, color: [249, 115, 22] },
  { mmPerHour: 25, color: [220, 38, 38] }
];

export const FORECAST_LEGEND = FORECAST_STOPS.map((stop) => ({
  mmPerHour: stop.mmPerHour,
  color: `rgb(${stop.color.join(',')})`
}));

/** Continuous colour for a forecast rain rate. */
function forecastColor(value) {
  for (let index = 1; index < FORECAST_STOPS.length; index += 1) {
    const previous = FORECAST_STOPS[index - 1];
    const current = FORECAST_STOPS[index];

    if (value <= current.mmPerHour) {
      const span = current.mmPerHour - previous.mmPerHour;
      const ratio = span > 0 ? (value - previous.mmPerHour) / span : 0;
      return [
        previous.color[0] + (current.color[0] - previous.color[0]) * ratio,
        previous.color[1] + (current.color[1] - previous.color[1]) * ratio,
        previous.color[2] + (current.color[2] - previous.color[2]) * ratio
      ];
    }
  }

  return FORECAST_STOPS[FORECAST_STOPS.length - 1].color;
}

/** A regular lat/lng grid over the study area, as request coordinates. */
function sampleGrid(bounds, steps) {
  const lats = [];
  const lngs = [];

  for (let row = 0; row < steps; row += 1) {
    for (let column = 0; column < steps; column += 1) {
      const t = steps === 1 ? 0.5 : row / (steps - 1);
      const u = steps === 1 ? 0.5 : column / (steps - 1);
      lats.push(Number((bounds.south + (bounds.north - bounds.south) * t).toFixed(4)));
      lngs.push(Number((bounds.west + (bounds.east - bounds.west) * u).toFixed(4)));
    }
  }

  return { lats, lngs };
}

/**
 * TMD's own grid forecast. domain 2 is hourly at ~3 km out to 72 hours;
 * domain 1 is 3-hourly at ~9 km out to ten days.
 */
async function loadTmdGrid(bounds) {
  if (!config.tmdToken) {
    return null;
  }

  const domain = config.tmdForecastDomain;
  const url =
    `${config.tmdProxyPath}/nwpapi/v1/forecast/area/box` +
    `?domain=${domain}` +
    `&bottom-left=${bounds.south.toFixed(2)},${bounds.west.toFixed(2)}` +
    `&top-right=${bounds.north.toFixed(2)},${bounds.east.toFixed(2)}` +
    '&fields=rain';

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.tmdToken}`, accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`TMD grid responded ${response.status}`);
  }

  const payload = await response.json();
  // The payload nests the locations one or two levels down depending on the
  // query type, so accept either shape rather than guessing one.
  const locations = payload?.WeatherForecasts || payload?.forecasts || payload?.data || [];
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('TMD grid returned no locations');
  }

  const times = [];
  const points = locations
    .map((entry) => {
      const location = entry.location || entry;
      const series = entry.forecasts || entry.forecast || [];
      const rain = [];

      for (let index = 0; index < series.length; index += 1) {
        const slot = series[index];
        const stamp = slot.time || slot.datetime;
        if (times.length <= index && stamp) {
          times.push(stamp);
        }
        rain.push(Number(slot.data?.rain ?? slot.rain ?? 0));
      }

      return { lat: Number(location.lat), lng: Number(location.lon ?? location.lng), rain };
    })
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  // TMD's own docs warn that a wide box pulls a lot of data: the province at
  // 3 km is on the order of ten thousand points, which is more rectangles
  // than the map should carry. Thin evenly rather than truncating, so the
  // cells still cover the whole area.
  const capped = thinTo(points, config.forecastMaxCells);
  const spacing = gridSpacing(capped);
  return {
    source: 'TMD',
    sourceLabel: 'Thai Meteorological Department',
    resolutionText: domain === 2 ? '~3 km, hourly' : '~9 km, 3-hourly',
    stepHours: domain === 2 ? 1 : 3,
    times,
    points: capped,
    ...spacing
  };
}

/** Keyless fallback. One request carries every grid point. */
async function loadOpenMeteoGrid(bounds) {
  const steps = config.forecastGridSteps;
  const { lats, lngs } = sampleGrid(bounds, steps);

  const url =
    `${OPEN_METEO_URL}?latitude=${lats.join(',')}&longitude=${lngs.join(',')}` +
    `&hourly=precipitation&forecast_days=${config.forecastDays}&timezone=Asia%2FBangkok`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo responded ${response.status}`);
  }

  const payload = await response.json();
  const locations = Array.isArray(payload) ? payload : [payload];
  const times = locations[0]?.hourly?.time || [];

  // Drawn at the coordinates asked for, not the ones the model snapped to:
  // the request grid is regular, so the cells tile without overlapping.
  const points = locations.map((entry, index) => ({
    lat: lats[index],
    lng: lngs[index],
    rain: entry?.hourly?.precipitation || []
  }));

  return {
    source: 'Open-Meteo',
    sourceLabel: 'Open-Meteo (not TMD)',
    resolutionText: '~8 km, hourly',
    stepHours: 1,
    times,
    points,
    cellLat: (bounds.north - bounds.south) / (steps - 1),
    cellLng: (bounds.east - bounds.west) / (steps - 1)
  };
}

/** Keep an evenly spread subset, so coverage survives the cap. */
function thinTo(points, limit) {
  if (points.length <= limit) {
    return points;
  }

  const stride = Math.ceil(points.length / limit);
  return points.filter((_, index) => index % stride === 0);
}

/** Smallest positive gap between distinct coordinates, for cell sizing. */
function gridSpacing(points) {
  const gapOf = (values) => {
    const sorted = [...new Set(values.map((v) => Number(v.toFixed(4))))].sort((a, b) => a - b);
    let gap = Infinity;
    for (let index = 1; index < sorted.length; index += 1) {
      const delta = sorted[index] - sorted[index - 1];
      if (delta > 1e-6 && delta < gap) {
        gap = delta;
      }
    }
    return Number.isFinite(gap) ? gap : 0.05;
  };

  return {
    cellLat: gapOf(points.map((p) => p.lat)),
    cellLng: gapOf(points.map((p) => p.lng))
  };
}

/**
 * Load the best grid available: TMD when a token is configured, otherwise the
 * keyless fallback. A TMD failure falls through rather than losing the layer.
 */
export async function loadForecastGrid(bounds) {
  if (config.tmdToken) {
    try {
      const grid = await loadTmdGrid(bounds);
      if (grid) {
        return grid;
      }
    } catch (error) {
      console.warn('TMD grid forecast unavailable, falling back:', error.message);
    }
  }

  return loadOpenMeteoGrid(bounds);
}

/**
 * Arrange scattered forecast points into the regular lattice they came from.
 *
 * Both providers sample a grid, but they hand it back as a flat list. Sorting
 * the distinct coordinates recovers the rows and columns, which is what makes
 * smooth interpolation possible.
 */
function toLattice(points) {
  const key = (value) => Number(value.toFixed(4));
  const lats = [...new Set(points.map((p) => key(p.lat)))].sort((a, b) => a - b);
  const lngs = [...new Set(points.map((p) => key(p.lng)))].sort((a, b) => a - b);

  const latIndex = new Map(lats.map((v, i) => [v, i]));
  const lngIndex = new Map(lngs.map((v, i) => [v, i]));
  const cells = new Array(lats.length * lngs.length).fill(null);

  for (const point of points) {
    const row = latIndex.get(key(point.lat));
    const column = lngIndex.get(key(point.lng));
    if (row !== undefined && column !== undefined) {
      cells[row * lngs.length + column] = point;
    }
  }

  return { rows: lats.length, columns: lngs.length, lats, lngs, cells };
}

/**
 * The forecast as a weather-map heatmap.
 *
 * Values are painted one pixel per grid cell into a small offscreen canvas,
 * then drawn up to the display canvas with smoothing on: the browser's own
 * bilinear filter turns the coarse lattice into the continuous wash a rain
 * forecast is normally shown as, instead of a chequerboard of hard squares.
 */
export function createForecastGridLayer(grid) {
  const lattice = toLattice(grid.points);
  const bounds = L.latLngBounds(
    [lattice.lats[0] - grid.cellLat / 2, lattice.lngs[0] - grid.cellLng / 2],
    [
      lattice.lats[lattice.rows - 1] + grid.cellLat / 2,
      lattice.lngs[lattice.columns - 1] + grid.cellLng / 2
    ]
  );

  const source = document.createElement('canvas');
  source.width = lattice.columns;
  source.height = lattice.rows;
  const sourceCtx = source.getContext('2d');

  // Upscaled target: enough pixels that the smoothing has room to work, but
  // not so many that redrawing on every slider step costs anything.
  const scale = Math.max(4, Math.ceil(320 / Math.max(lattice.rows, lattice.columns)));
  const display = document.createElement('canvas');
  display.width = lattice.columns * scale;
  display.height = lattice.rows * scale;
  const displayCtx = display.getContext('2d');
  displayCtx.imageSmoothingEnabled = true;
  displayCtx.imageSmoothingQuality = 'high';

  const overlay = L.imageOverlay('', bounds, {
    opacity: config.forecastGridOpacity,
    interactive: false,
    className: 'wx-heat'
  });
  const group = L.layerGroup([overlay]);

  // Values for the step on screen, so a hover can be answered without
  // re-reading the whole series.
  let currentValues = new Float32Array(lattice.rows * lattice.columns);

  function showStep(index) {
    const image = sourceCtx.createImageData(lattice.columns, lattice.rows);
    const pixels = image.data;
    let peak = 0;

    for (let row = 0; row < lattice.rows; row += 1) {
      for (let column = 0; column < lattice.columns; column += 1) {
        const cell = lattice.cells[row * lattice.columns + column];
        const value = cell ? Number(cell.rain[index] ?? 0) : 0;
        currentValues[row * lattice.columns + column] = value;
        if (value > peak) {
          peak = value;
        }

        // Canvas rows run north to south; the lattice runs south to north.
        const offset = ((lattice.rows - 1 - row) * lattice.columns + column) * 4;
        if (value < FORECAST_STOPS[0].mmPerHour) {
          pixels[offset + 3] = 0;
          continue;
        }

        const [r, g, b] = forecastColor(value);
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        // Fade in over the lightest band so drizzle edges out softly rather
        // than ending on a hard line.
        pixels[offset + 3] = Math.min(255, 150 + value * 40);
      }
    }

    sourceCtx.putImageData(image, 0, 0);
    displayCtx.clearRect(0, 0, display.width, display.height);
    displayCtx.drawImage(source, 0, 0, display.width, display.height);
    overlay.setUrl(display.toDataURL());

    const stamp = grid.times[index];
    return { time: stamp ? stamp.replace('T', ' ') : `step ${index}`, peak };
  }

  /** Rain at a point, for the hover readout. */
  function valueAt(lat, lng) {
    const row = Math.round((lat - lattice.lats[0]) / grid.cellLat);
    const column = Math.round((lng - lattice.lngs[0]) / grid.cellLng);
    if (row < 0 || column < 0 || row >= lattice.rows || column >= lattice.columns) {
      return null;
    }

    return currentValues[row * lattice.columns + column];
  }

  return { group, showStep, valueAt, stepCount: grid.times.length };
}

/**
 * The colour scale as a strip for the slider control.
 *
 * Positioned on a log scale, matching how the stops are spaced: on a linear
 * strip everything below 5 mm/h would be squeezed into the first few pixels.
 */
export function legendGradient() {
  const first = Math.log(FORECAST_STOPS[0].mmPerHour);
  const last = Math.log(FORECAST_STOPS[FORECAST_STOPS.length - 1].mmPerHour);
  const stops = FORECAST_LEGEND.map((stop) => {
    const position = ((Math.log(stop.mmPerHour) - first) / (last - first)) * 100;
    return `${stop.color} ${position.toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
