import L from 'leaflet';
import { config } from './config.js';
import {
  createForecastGridLayer,
  FORECAST_LEGEND,
  legendGradient,
  loadForecastGrid
} from './forecast.js';

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

/**
 * Infrared cloud-top imagery: where the cloud is, rain or not.
 *
 * Bounded to the study area. GSMaP tiles are global, and without a bound
 * Leaflet fetches and paints them across the whole visible world - a lot of
 * requests and a lot of compositing for cloud nobody is looking at.
 */
export function createCloudLayer({ bounds } = {}) {
  const frame = latestGsmapFrame();

  // The tiles are white clouds over alpha; on a light basemap that is
  // invisible. The wx-cloud class inverts them, so cloud reads as grey
  // shading whose darkness is the cloud thickness.
  const layer = L.tileLayer(gsmapUrl('gsmap_tile_ir.py', 'ir', frame), {
    className: 'wx-cloud',
    opacity: config.cloudLayerOpacity,
    maxNativeZoom: GSMAP_MAX_NATIVE_ZOOM,
    attribution: ATTRIBUTION_GSMAP,
    bounds: bounds
      ? L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east])
      : undefined,
    // Blank ocean/edge tiles are normal here; a missing tile must not leave a
    // broken-image box on the map.
    errorTileUrl:
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  });

  return {
    layer,
    label: 'Cloud Cover',
    frame,

    /**
     * Soften the 0.1-degree squares by however many pixels one covers at this
     * zoom. The blur lives on the layer container, never per tile, so the
     * mosaic smooths as one image without seams at the tile joins.
     */
    updateBlur(zoom) {
      const cellPx = (Math.pow(2, zoom) * 256) / 3600;
      const blur = Math.min(9, Math.max(1, cellPx / 5));
      document.documentElement.style.setProperty('--wx-blur', blur.toFixed(1) + 'px');
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
export async function createRainForecastLayer({ boundary, bounds, provinceName = 'Chonburi' } = {}) {
  // A real grid beats one figure for the whole province, so try that first
  // and keep the province outlook as the fallback.
  if (bounds) {
    try {
      const grid = await loadForecastGrid(bounds);
      if (grid?.points?.length && grid.times.length) {
        return buildGridForecastLayer(grid);
      }
    } catch (error) {
      console.warn('Gridded forecast unavailable, using province outlook:', error.message);
    }
  }

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

  // The province boundary layer is already on screen in orange, so a faint
  // same-coloured outline disappeared entirely. A solid tint plus an
  // always-visible chip makes the forecast unmissable at any zoom.
  const shape = L.geoJSON(boundary, {
    style: { weight: 2.5, fillOpacity: 0.3, dashArray: '8 6' }
  });
  shape.bindTooltip('', { sticky: true });
  shape.bindPopup('', { maxWidth: 320 });
  group.addLayer(shape);

  const chip = L.marker(shape.getBounds().getCenter(), {
    interactive: true,
    keyboard: false,
    icon: L.divIcon({ className: 'wx-chip-anchor', html: '', iconSize: null })
  });
  chip.bindPopup('', { maxWidth: 320 });
  group.addLayer(chip);

  // One slider step per forecast day. The endpoint in use is daily-only;
  // with an nwpapi OAuth token the same control would carry hourly steps.
  let sliderLabel = null;
  let sliderInput = null;

  function applyDay(index) {
    const day = forecast.days[index];
    const style = forecastStyleFor(day.rainChance);
    const when = index === 0 ? 'today' : shortDate(day);

    shape.setStyle({ color: style.color, fillColor: style.color });
    shape.setTooltipContent(
      `Rain ${when}: <strong>${day.rainChance}%</strong> (${style.text})`
    );

    const popup = forecastPopup(forecast, index);
    shape.setPopupContent(popup);
    chip.setPopupContent(popup);
    chip.setIcon(
      L.divIcon({
        className: 'wx-chip-anchor',
        html:
          `<span class="wx-chip" style="border-color:${style.color}">` +
          `Rain ${when}: <strong>${day.rainChance}%</strong></span>`,
        iconSize: null
      })
    );

    if (sliderLabel) {
      sliderLabel.textContent = `${shortDate(day)} · ${day.rainChance}% (${style.text})`;
    }
  }

  const TimeControl = L.Control.extend({
    options: { position: 'topleft' },

    onAdd() {
      const container = L.DomUtil.create('div', 'wx-time-control');
      container.innerHTML =
        '<span class="wx-time-title">TMD forecast</span>' +
        `<input type="range" min="0" max="${forecast.days.length - 1}" step="1" value="0" />` +
        '<span class="wx-time-label"></span>';

      // The slider must not drag or zoom the map underneath it.
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      sliderInput = container.querySelector('input');
      sliderLabel = container.querySelector('.wx-time-label');
      sliderInput.addEventListener('input', () => applyDay(Number(sliderInput.value)));
      applyDay(Number(sliderInput.value));
      return container;
    },

    onRemove() {
      sliderLabel = null;
      sliderInput = null;
    }
  });

  // The control follows the layer checkbox: on the map only while the
  // forecast is.
  const timeControl = new TimeControl();
  group.on('add', (event) => timeControl.addTo(event.target._map));
  group.on('remove', () => timeControl.remove());

  applyDay(0);

  return {
    layer: group,
    label: 'Rain Forecast (TMD)',
    available: true,
    forecast
  };
}

function shortDate(day) {
  return day.date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  });
}

function forecastPopup(forecast, selectedIndex = 0) {
  const rows = forecast.days
    .map((day, index) => {
      const style = forecastStyleFor(day.rainChance);
      const date = shortDate(day);

      return (
        `<tr${index === selectedIndex ? ' class="wx-selected"' : ''}><td>${date}</td>` +
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

/**
 * The gridded view: coloured cells plus an hour-by-hour slider.
 *
 * Same control furniture as the province fallback below it, so the layer
 * behaves identically whichever provider answered.
 */
function buildGridForecastLayer(grid) {
  const { group, showStep, valueAt, stepCount } = createForecastGridLayer(grid);

  // The timeline is split into a day picker and an hour slider. As one slider
  // over every hour it ran to 168 steps, where a single pixel of travel jumped
  // hours and landing on a particular morning took real effort.
  const days = groupByDay(grid.times);

  const dom = {
    card: document.querySelector('#forecast-card'),
    source: document.querySelector('#forecast-source'),
    day: document.querySelector('#forecast-day'),
    dayValue: document.querySelector('#forecast-day-value'),
    hour: document.querySelector('#forecast-hour'),
    hourValue: document.querySelector('#forecast-hour-value'),
    peak: document.querySelector('#forecast-peak'),
    total: document.querySelector('#forecast-total'),
    gradient: document.querySelector('#forecast-gradient'),
    ticks: document.querySelector('#forecast-ticks')
  };

  function applyStep(index) {
    const { peak } = showStep(index);
    dom.peak.textContent = `${peak.toFixed(1)} mm/h`;
  }

  /** The hour slider spans whatever hours that day actually carries. */
  function selectDay(dayIndex) {
    const day = days[dayIndex];
    dom.hour.min = '0';
    dom.hour.max = String(day.steps.length - 1);
    dom.hour.value = String(Math.min(Number(dom.hour.value), day.steps.length - 1));
    dom.dayValue.textContent = day.weekday;

    // The day's total at the wettest point. Summing the area-wide peak hour
    // by hour instead would add up rain that fell in different places, and
    // read far higher than anywhere actually gets.
    dom.total.textContent = `${wettestDailyTotal(day.steps).toFixed(1)} mm`;

    selectHour(Number(dom.hour.value));
  }

  function selectHour(hourIndex) {
    const day = days[Number(dom.day.value)];
    const step = day.steps[hourIndex];
    dom.hourValue.textContent = day.hours[hourIndex];
    applyStep(step);
  }

  /** The largest per-point total across a day's steps. */
  function wettestDailyTotal(steps) {
    let wettest = 0;
    for (const point of grid.points) {
      let sum = 0;
      for (const step of steps) {
        sum += Number(point.rain[step] ?? 0);
      }
      if (sum > wettest) {
        wettest = sum;
      }
    }
    return wettest;
  }

  function buildCard() {
    dom.source.textContent = `${grid.source} · ${grid.resolutionText}`;
    dom.day.innerHTML = days
      .map((day, index) => `<option value="${index}">${day.label}</option>`)
      .join('');
    dom.gradient.style.background = legendGradient();
    dom.ticks.innerHTML =
      FORECAST_LEGEND.map((stop) => `<span>${stop.mmPerHour}</span>`).join('') +
      '<span>mm/h</span>';

    dom.day.value = '0';
    selectDay(0);
    dom.card.hidden = false;
  }

  dom.day.addEventListener('change', () => selectDay(Number(dom.day.value)));
  dom.hour.addEventListener('input', () => selectHour(Number(dom.hour.value)));

  // An image overlay cannot carry per-cell tooltips, so the readout follows
  // the cursor instead - which also reads better than hovering tiny squares.
  const readout = L.tooltip({ sticky: true, className: 'wx-heat-tip' });
  function onMove(event) {
    const value = valueAt(event.latlng.lat, event.latlng.lng);
    if (value === null) {
      readout.close();
      return;
    }

    readout
      .setLatLng(event.latlng)
      .setContent(
        `<strong>${value.toFixed(1)} mm/h</strong> forecast<br>` +
          `<small>${grid.sourceLabel}, ${grid.resolutionText}</small>`
      )
      .openOn(event.target);
  }

  // The card belongs to the layer: it appears and disappears with it.
  group.on('add', (event) => {
    buildCard();
    event.target._map.on('mousemove', onMove);
  });
  group.on('remove', (event) => {
    dom.card.hidden = true;
    event.target._map?.off('mousemove', onMove);
    readout.close();
  });

  applyStep(0);

  return {
    layer: group,
    label: `Rain Forecast (${grid.source})`,
    available: true,
    gridded: true,
    source: grid.source,
    forecast: null,
    stepCount
  };
}

/** Split a flat hourly timeline into days, each with its own step indices. */
function groupByDay(times) {
  const days = [];
  const byDate = new Map();

  times.forEach((stamp, index) => {
    const [date, clock] = String(stamp).split('T');
    if (!byDate.has(date)) {
      const parsed = new Date(`${date}T00:00:00Z`);
      const day = {
        date,
        label: parsed.toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC'
        }),
        weekday: days.length === 0 ? 'today' : `+${days.length}d`,
        steps: [],
        hours: []
      };
      byDate.set(date, day);
      days.push(day);
    }

    const day = byDate.get(date);
    day.steps.push(index);
    day.hours.push((clock || '00:00').slice(0, 5));
  });

  return days;
}

// --- observed rainfall, from TMD's own gauges --------------------------------
//
// The forecast endpoints publish a chance of rain per province; this one
// publishes what actually fell, in millimetres, at real stations. It is the
// only measured ground truth available without registering, and there are 14
// gauges inside the study area - Pattaya sits almost exactly on the
// simulation centre.

// Daily totals, not rates: these stops are what a rain gauge reads over a day.
const GAUGE_STOPS = [
  { mm: 0, color: '#cbd5e1', text: 'dry' },
  { mm: 0.1, color: '#93c5fd', text: 'a trace' },
  { mm: 1, color: '#3b82f6', text: 'light' },
  { mm: 10, color: '#16a34a', text: 'moderate' },
  { mm: 35, color: '#eab308', text: 'heavy' },
  { mm: 90, color: '#f97316', text: 'very heavy' },
  { mm: 150, color: '#dc2626', text: 'extreme' }
];

function gaugeStyleFor(mm) {
  let picked = GAUGE_STOPS[0];
  for (const stop of GAUGE_STOPS) {
    if (mm >= stop.mm) {
      picked = stop;
    }
  }
  return picked;
}

function gaugeRadius(mm) {
  // Square-root so a 180 mm downpour does not swamp the map, while the
  // difference between 1 mm and 10 mm stays visible.
  return 4 + Math.min(11, Math.sqrt(Math.max(0, mm)) * 1.4);
}

export async function createRainGaugeLayer({ isInside } = {}) {
  const group = L.layerGroup();

  let stations = [];
  try {
    stations = await loadStations();
  } catch (error) {
    console.warn('TMD gauges unavailable:', error.message);
    return { layer: group, label: 'Rain Gauges (no TMD data)', available: false, count: 0 };
  }

  // TMD publishes the whole national network; only the handful inside the
  // study area are reference data for this map, and the rest just clutter it.
  //
  // The test is "inside or just offshore", not strictly inside: coastal gauges
  // sit on piers and reclaimed land outside the land polygon. Laem Chabang,
  // on its deep-sea port, is a couple of kilometres out and would otherwise
  // be dropped.
  const COASTAL_TOLERANCE_DEG = 0.03;
  const nearProvince = (lat, lng) => {
    if (isInside(lat, lng)) {
      return true;
    }

    const d = COASTAL_TOLERANCE_DEG;
    return [
      [d, 0], [-d, 0], [0, d], [0, -d],
      [d, d], [d, -d], [-d, d], [-d, -d]
    ].some(([dy, dx]) => isInside(lat + dy, lng + dx));
  };

  const local = isInside ? stations.filter((s) => nearProvince(s.lat, s.lng)) : stations;

  for (const station of local) {
    const style = gaugeStyleFor(station.rainMm);

    const marker = L.circleMarker([station.lat, station.lng], {
      radius: gaugeRadius(station.rainMm),
      color: '#ffffff',
      weight: 1.5,
      fillColor: style.color,
      fillOpacity: 0.9
    });

    marker.bindTooltip(
      `<strong>${station.name}</strong><br>${station.rainMm.toFixed(1)} mm (${style.text})`,
      { direction: 'top' }
    );

    const rows = [
      ['Rainfall', `${station.rainMm.toFixed(1)} mm`],
      ['Temperature', station.temperature ? `${station.temperature} °C` : null],
      ['Humidity', station.humidity ? `${station.humidity} %` : null],
      ['Wind', station.windSpeed ? `${station.windSpeed} km/h from ${station.windDirection}°` : null],
      ['Pressure', station.pressure ? `${station.pressure} hPa` : null]
    ].filter(([, value]) => value);

    marker.bindPopup(
      `<strong>${station.name}</strong><br>` +
        `<small>${station.province} · WMO ${station.wmo}</small>` +
        '<table class="wx-forecast"><tbody>' +
        rows.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('') +
        '</tbody></table>' +
        `<small>Observed ${station.observedAt}<br>Thai Meteorological Department</small>`
    );

    group.addLayer(marker);
  }

  return {
    layer: group,
    label: 'Rain Gauges (TMD)',
    available: true,
    count: local.length,
    totalCount: stations.length,
    stations: local
  };
}

async function loadStations() {
  const url =
    `${config.tmdProxyPath}/api/WeatherToday/V2/` +
    `?uid=${encodeURIComponent(config.tmdUid)}&ukey=${encodeURIComponent(config.tmdUkey)}&format=json`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TMD responded ${response.status}`);
  }

  const payload = await response.json();
  const raw = payload?.Stations?.Station || [];

  return raw
    .map((entry) => {
      const observation = entry.Observation || {};
      return {
        wmo: entry.WmoStationNumber,
        // English names are plain ASCII; the Thai ones are kept for the label
        // where they exist, since that is what local users read.
        name: entry.StationNameThai || entry.StationNameEnglish,
        province: entry.Province || '',
        lat: Number(entry.Latitude),
        lng: Number(entry.Longitude),
        rainMm: Number(observation.Rainfall ?? 0),
        temperature: observation.Temperature,
        humidity: observation.RelativeHumidity,
        windSpeed: observation.WindSpeed,
        windDirection: observation.WindDirection,
        pressure: observation.MeanSeaLevelPressure,
        observedAt: observation.DateTime || 'unknown'
      };
    })
    .filter(
      (station) =>
        Number.isFinite(station.lat) &&
        Number.isFinite(station.lng) &&
        Number.isFinite(station.rainMm)
    );
}

/** Colour key for the gauge layer, for the map legend. */
export const GAUGE_LEGEND = GAUGE_STOPS;
