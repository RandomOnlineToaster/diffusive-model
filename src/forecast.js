import L from 'leaflet';
import { config } from './config.js';
import { RAINFALL_LEGEND } from './rainfallGrid.js';

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

/** Colour a rain rate on the same scale the storm simulator uses. */
function rainColor(mmPerHour) {
  let picked = null;
  for (const stop of RAINFALL_LEGEND) {
    if (mmPerHour >= stop.mmPerHour) {
      picked = stop;
    }
  }
  return picked ? picked.color : null;
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
 * One rectangle per grid point, recoloured as the time step changes.
 *
 * Canvas rather than SVG: a few hundred cells redrawn on every slider move is
 * exactly the workload that made the street layer stutter as DOM nodes.
 */
export function createForecastGridLayer(grid) {
  const group = L.layerGroup();
  const renderer = L.canvas({ padding: 0.2 });
  const halfLat = grid.cellLat / 2;
  const halfLng = grid.cellLng / 2;

  const cells = grid.points.map((point) => {
    const rectangle = L.rectangle(
      [
        [point.lat - halfLat, point.lng - halfLng],
        [point.lat + halfLat, point.lng + halfLng]
      ],
      { renderer, stroke: false, fillOpacity: 0, interactive: true }
    );

    group.addLayer(rectangle);
    return { point, rectangle };
  });

  function showStep(index) {
    const stamp = grid.times[index];
    const local = stamp ? stamp.replace('T', ' ') : `step ${index}`;
    let peak = 0;

    for (const { point, rectangle } of cells) {
      const value = Number(point.rain[index] ?? 0);
      if (value > peak) {
        peak = value;
      }

      const color = rainColor(value);
      if (!color) {
        rectangle.setStyle({ fillOpacity: 0 });
        rectangle.unbindTooltip();
        continue;
      }

      rectangle.setStyle({ fillColor: color, fillOpacity: config.forecastGridOpacity });
      rectangle.bindTooltip(
        `<strong>${value.toFixed(1)} mm/h</strong><br>${local}<br>` +
          `<small>${grid.sourceLabel}, ${grid.resolutionText}</small>`,
        { sticky: true }
      );
    }

    return { time: local, peak };
  }

  return { group, cells, showStep, stepCount: grid.times.length };
}
