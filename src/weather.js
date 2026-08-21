import L from 'leaflet';
import { config } from './config.js';

// Live weather layers, from two public sources.
//
//   JAXA GSMaP  -> satellite tiles: infrared cloud tops, and observed rain
//   Thai TMD    -> per-province rainfall forecast
//
// GSMaP serves ordinary XYZ tiles with a TMS-style Y, which Leaflet fills in
// through the {-y} placeholder, so the URL templates below are the same ones
// the JAXA viewer uses. TMD only allows its own origin in CORS, so its JSON is
// fetched through the dev-server proxy declared in vite.config.js.

const GSMAP_TILES = 'https://sharaku.eorc.jaxa.jp/cgi-bin/trmm/GSMaP/tilemap';

// GSMaP grids are 0.1 degrees, roughly 11 km. The server will happily upscale
// far past that; capping the native zoom keeps requests honest and lets
// Leaflet do the stretching once the tiles stop carrying new detail.
const GSMAP_MAX_NATIVE_ZOOM = 8;

const ATTRIBUTION_GSMAP =
  '<a href="https://sharaku.eorc.jaxa.jp/GSMaP/">JAXA GSMaP</a>';
const ATTRIBUTION_TMD = '<a href="https://data.tmd.go.th/">Thai Meteorological Department</a>';

/**
 * The most recent GSMaP frame that is likely to exist.
 *
 * The product is hourly and lands a few hours behind real time, so asking for
 * "now" only ever returns empty tiles. The lag is a setting because JAXA's
 * own latest-frame marker is not readable from the browser (no CORS header).
 */
export function latestGsmapFrame(now = new Date()) {
  const stamp = new Date(now.getTime() - config.gsmapLatencyHours * 3600 * 1000);
  return {
    year: stamp.getUTCFullYear(),
    month: String(stamp.getUTCMonth() + 1).padStart(2, '0'),
    day: String(stamp.getUTCDate()).padStart(2, '0'),
    hour: String(stamp.getUTCHours()).padStart(2, '0'),
    minute: '00',
    date: stamp
  };
}

function gsmapUrl(script, product, frame) {
  return (
    `${GSMAP_TILES}/${script}?prod=${product}` +
    `&year=${frame.year}&month=${frame.month}&day=${frame.day}` +
    `&hour=${frame.hour}&min=${frame.minute}` +
    '&z={z}&x={x}&y={-y}'
  );
}

function frameLabel(frame) {
  return `${frame.year}-${frame.month}-${frame.day} ${frame.hour}:00 UTC`;
}

/** Infrared cloud-top imagery: where the cloud is, rain or not. */
export function createCloudLayer() {
  const frame = latestGsmapFrame();

  // The tiles are white clouds over alpha; on a light basemap that is
  // invisible. The wx-cloud class inverts them, so cloud reads as grey
  // shading whose darkness is the cloud thickness.
  const layer = L.tileLayer(gsmapUrl('gsmap_tile_ir.py', 'ir', frame), {
    className: 'wx-cloud',
    opacity: config.cloudLayerOpacity,
    maxNativeZoom: GSMAP_MAX_NATIVE_ZOOM,
    attribution: ATTRIBUTION_GSMAP,
    // Blank ocean/edge tiles are normal here; a missing tile must not leave a
    // broken-image box on the map.
    errorTileUrl:
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  });

  return { layer, label: 'Cloud Cover', frame };
}

/** Observed rain rate at the same frame, so cloud and rain line up. */
export function createSatelliteRainLayer() {
  const frame = latestGsmapFrame();

  // The server rasterises the 0.1-degree grid into hard opaque squares, so
  // the blockiness is baked into the tile. A blur on the layer container
  // (never per tile - that shows seams) melts the squares into a gradient;
  // the radius tracks how many pixels one grid cell spans at this zoom.
  const layer = L.tileLayer(gsmapUrl('tile_rain.py', 'rain', frame), {
    className: 'wx-rain',
    opacity: config.rainLayerOpacity,
    maxNativeZoom: GSMAP_MAX_NATIVE_ZOOM,
    attribution: ATTRIBUTION_GSMAP,
    errorTileUrl:
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  });

  return {
    layer,
    label: 'Rain Now (satellite)',
    frame,

    /** Match the smoothing to the on-screen size of one 0.1-degree cell. */
    updateBlur(zoom) {
      const cellPx = (Math.pow(2, zoom) * 256) / 3600;
      const blur = Math.min(14, Math.max(1.5, cellPx / 3));
      document.documentElement.style.setProperty('--wx-rain-blur', blur.toFixed(1) + 'px');
    }
  };
}

// Forecast rain chance, coloured the way the flood layers are: green is dry,
// red is a soaking. Percentages are the only rain figure TMD publishes on this
// endpoint, so the scale is chance-of-rain, not depth.
const FORECAST_COLORS = [
  { upTo: 20, color: '#16a34a', text: 'unlikely' },
  { upTo: 40, color: '#84cc16', text: 'possible' },
  { upTo: 60, color: '#eab308', text: 'likely' },
  { upTo: 80, color: '#f97316', text: 'very likely' },
  { upTo: 101, color: '#dc2626', text: 'near certain' }
];

function forecastStyleFor(percent) {
  return FORECAST_COLORS.find((stop) => percent < stop.upTo) || FORECAST_COLORS[FORECAST_COLORS.length - 1];
}

// TMD dates arrive as dd/mm/yyyy and are not sorted; today is not always first.
function parseThaiDate(text) {
  const [day, month, year] = String(text).split('/').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Province rainfall forecast from TMD, drawn over the study boundary.
 *
 * The endpoint reports one entry per province per day, so this is a coarse
 * outlook - the province tinted by today's chance of rain, with the week in a
 * popup - not a rainfall field. The high-resolution grid forecast TMD also
 * publishes needs an OAuth token; see .env.local.
 */
export async function createRainForecastLayer({ boundary, provinceName = 'Chonburi' } = {}) {
  const group = L.layerGroup();

  let forecast = null;
  try {
    forecast = await loadProvinceForecast(provinceName);
  } catch (error) {
    console.warn('TMD forecast unavailable:', error.message);
  }

  if (!forecast || !boundary) {
    return {
      layer: group,
      label: 'Rain Forecast (no TMD data)',
      available: false,
      forecast: null
    };
  }

  const today = forecast.days[0];
  const style = forecastStyleFor(today.rainChance);

  // The province boundary layer is already on screen in orange, so a faint
  // same-coloured outline disappeared entirely. A solid tint plus an
  // always-visible chip makes the forecast unmissable at any zoom.
  const shape = L.geoJSON(boundary, {
    style: {
      color: style.color,
      weight: 2.5,
      fillColor: style.color,
      fillOpacity: 0.3,
      dashArray: '8 6'
    }
  });

  shape.bindTooltip(
    `Rain forecast today: <strong>${today.rainChance}%</strong> (${style.text})`,
    { sticky: true }
  );

  const popup = forecastPopup(forecast);
  shape.bindPopup(popup, { maxWidth: 320 });
  group.addLayer(shape);

  const chip = L.marker(shape.getBounds().getCenter(), {
    interactive: true,
    keyboard: false,
    icon: L.divIcon({
      className: 'wx-chip-anchor',
      html:
        `<span class="wx-chip" style="border-color:${style.color}">` +
        `Rain today: <strong>${today.rainChance}%</strong></span>`,
      iconSize: null
    })
  });
  chip.bindPopup(popup, { maxWidth: 320 });
  group.addLayer(chip);

  return {
    layer: group,
    label: 'Rain Forecast (TMD)',
    available: true,
    forecast
  };
}

function forecastPopup(forecast) {
  const rows = forecast.days
    .map((day) => {
      const style = forecastStyleFor(day.rainChance);
      const date = day.date.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC'
      });

      return (
        `<tr><td>${date}</td>` +
        `<td><span class="wx-dot" style="background:${style.color}"></span>${day.rainChance}%</td>` +
        `<td>${day.minTemp}-${day.maxTemp}°C</td>` +
        `<td>${day.description}</td></tr>`
      );
    })
    .join('');

  return (
    `<strong>${forecast.province} rainfall outlook</strong>` +
    '<table class="wx-forecast">' +
    '<thead><tr><th>Day</th><th>Rain</th><th>Temp</th><th>Outlook</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>` +
    `<small>Thai Meteorological Department, issued ${forecast.issued}</small>`
  );
}

async function loadProvinceForecast(provinceName) {
  const url =
    `${config.tmdProxyPath}/api/WeatherForecast7Days/V2/` +
    `?uid=${encodeURIComponent(config.tmdUid)}&ukey=${encodeURIComponent(config.tmdUkey)}&format=json`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TMD responded ${response.status}`);
  }

  const payload = await response.json();
  const provinces = payload?.Provinces?.Province || [];
  const match = provinces.find(
    (entry) => (entry.ProvinceNameEnglish || '').toLowerCase() === provinceName.toLowerCase()
  );

  if (!match) {
    throw new Error(`no forecast for ${provinceName}`);
  }

  const source = match.SevenDaysForecast || {};
  const days = (source.ForecastDate || [])
    .map((date, index) => ({
      date: parseThaiDate(date),
      rainChance: Number(source.PercentRainCover?.[index] ?? 0),
      minTemp: Number(source.MinimumTemperature?.[index] ?? 0).toFixed(0),
      maxTemp: Number(source.MaximumTemperature?.[index] ?? 0).toFixed(0),
      description: source.DescriptionEnglish?.[index] || ''
    }))
    .sort((a, b) => a.date - b.date);

  if (days.length === 0) {
    throw new Error('forecast contained no days');
  }

  return {
    province: match.ProvinceNameEnglish,
    issued: payload?.header?.LastBuildDate || 'unknown',
    days,
    attribution: ATTRIBUTION_TMD
  };
}
