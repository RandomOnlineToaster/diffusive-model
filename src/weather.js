import L from 'leaflet';
import { config } from './config.js';
import {
  createForecastGridLayer,
  FORECAST_LEGEND,
  legendGradient,
  loadFastForecastGrid,
  loadTmdForecastGrid
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
/**
 * Two rain-forecast layers that share one card.
 *
 *   Open-Meteo  - keyless, ~8 km, a week ahead. Awaited, so the first paint
 *                 already has a forecast on it.
 *   TMD         - the local model, ~3 km, a day ahead. Its area endpoint takes
 *                 about a minute to answer and is rate limited, so it loads in
 *                 the background and the layer fills in when it lands.
 *
 * They are separate toggles but never both drawn: switching one on turns the
 * other off, and the card follows whichever is on, animating its timeline
 * between the two runs' spans.
 */
export async function createRainForecastLayers({ boundary, bounds, provinceName = 'Chonburi' } = {}) {
  const card = createForecastCard({ boundary });

  // The province chance-of-rain rides along for the map chip; it is not a
  // grid and must not block either layer.
  loadProvinceForecast(provinceName)
    .then((outlook) => card.setProvinceOutlook(outlook))
    .catch(() => card.setProvinceOutlook(null));

  const openMeteo = createForecastSource({ key: 'open-meteo', name: 'Open-Meteo', card });
  const tmd = createForecastSource({ key: 'tmd', name: 'TMD', card });
  card.registerSources([openMeteo, tmd]);

  try {
    openMeteo.setGrid(await loadFastForecastGrid(bounds));
  } catch (error) {
    openMeteo.setStatus(`unavailable (${error.message})`);
  }

  if (config.tmdToken) {
    tmd.setStatus('loading, about a minute');
    loadTmdForecastGrid(bounds)
      .then((grid) => {
        if (grid?.points?.length && grid.times.length) {
          tmd.setGrid(grid);
          console.info(
            `Weather: TMD forecast ready, ${grid.points.length} points at ${grid.resolutionText}`
          );
        } else {
          tmd.setStatus('no data returned');
        }
      })
      .catch((error) => tmd.setStatus(error.message));
  } else {
    tmd.setStatus('no token configured');
  }

  card.show(openMeteo.available ? 'open-meteo' : 'tmd', { animate: false });

  return { openMeteo, tmd, card };
}

/** One forecast provider: a map layer plus the grid behind it, if any. */
function createForecastSource({ key, name, card }) {
  const group = L.layerGroup();
  const state = { key, name, grid: null, heat: null, status: 'loading' };

  group.on('add', (event) => card.onSourceShown(key, event.target._map));
  group.on('remove', (event) => card.onSourceHidden(key, event.target._map));

  return {
    key,
    name,
    layer: group,
    label: `Rain Forecast (${name})`,
    state,

    get available() {
      return Boolean(state.grid);
    },

    get source() {
      return name;
    },

    setGrid(grid) {
      if (state.heat) {
        group.removeLayer(state.heat.overlay);
      }

      state.grid = grid;
      state.heat = createForecastGridLayer(grid);
      state.status = '';
      group.addLayer(state.heat.overlay);
      card.onSourceUpdated(key);
    },

    setStatus(text) {
      state.status = text;
      card.onSourceUpdated(key);
    }
  };
}

/**
 * The card in the analysis panel: timeline, readouts, colour key, plus the
 * map-side readout and chance-of-rain chip. One instance serves every source.
 */
function createForecastCard({ boundary }) {
  const dom = {
    source: document.querySelector('#forecast-source'),
    timeline: document.querySelector('#forecast-timeline'),
    track: document.querySelector('#forecast-track'),
    head: document.querySelector('#forecast-head'),
    headLabel: document.querySelector('#forecast-head-label'),
    range: document.querySelector('#forecast-head-range'),
    fill: document.querySelector('#forecast-head-fill'),
    now: document.querySelector('#forecast-now'),
    hint: document.querySelector('#forecast-hint'),
    peak: document.querySelector('#forecast-peak'),
    total: document.querySelector('#forecast-total'),
    gradient: document.querySelector('#forecast-gradient'),
    ticks: document.querySelector('#forecast-ticks')
  };

  dom.gradient.style.background = legendGradient();
  dom.ticks.innerHTML =
    FORECAST_LEGEND.map((stop) => `<span>${stop.mmPerHour}</span>`).join('') + '<span>mm/h</span>';

  const sources = new Map();
  let activeKey = null;
  let days = [];
  let stepCount = 0;
  let current = 0;
  // The moment on screen, kept across source switches so the playhead lands
  // on the same hour in the other run rather than the same fraction of a
  // different span.
  let lookingAt = null;
  let provinceOutlook = null;
  let attachedMap = null;
  let swapToken = 0;
  // Shift + drag marks a span of the forecast that plays onto the map when
  // released; a plain click or drag inside it shows any moment of it. The
  // driver (map.js) does the simulating; the card turns pointer positions
  // into times and draws the span and how far it has played.
  let seriesHandler = null;
  let series = null;
  let stampsMs = [];
  let hintTimer = 0;
  // The cursor reaches this far beyond the red lines, as the single cursor
  // does about its hairline; the time box reaches this far beyond the cursor.
  const HEAD_PAD_PX = 12;
  const LABEL_MARGIN_PX = 10;

  const active = () => (activeKey ? sources.get(activeKey)?.state : null);
  const fractionOf = (index) => (stepCount <= 1 ? 0 : index / (stepCount - 1));
  const dayOfStep = (index) => days.find((day) => day.steps.includes(index)) || days[0];

  // The bar as a clock: its ends are the first and last stamps, and the
  // steps sit where the stepped view puts them.
  const spanStartMs = () => stampsMs[0] ?? 0;
  const spanEndMs = () => stampsMs[stampsMs.length - 1] ?? 0;
  const stepMs = () => (stampsMs.length > 1 ? stampsMs[1] - stampsMs[0] : 3600 * 1000);
  const fractionOfMs = (ms) => {
    const start = spanStartMs();
    const end = spanEndMs();
    return end > start ? Math.max(0, Math.min(1, (ms - start) / (end - start))) : 0;
  };
  const msAtClient = (clientX) => {
    const rect = dom.track.getBoundingClientRect();
    const fraction = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    return spanStartMs() + fraction * (spanEndMs() - spanStartMs());
  };
  /** The hour bucket a moment falls in: the last stamp at or before it. */
  const bucketOfMs = (ms) => {
    let bucket = 0;
    for (let index = 1; index < stampsMs.length && stampsMs[index] <= ms; index += 1) {
      bucket = index;
    }
    return bucket;
  };

  // --- chance-of-rain chip ---------------------------------------------------
  const chip = boundary
    ? L.marker(polygonCentroid(boundary), {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: 'wx-chip-anchor', html: '', iconSize: null })
      })
    : null;
  let chipHtml = '';

  function outlookFor(date) {
    if (!provinceOutlook) {
      return null;
    }

    return (
      provinceOutlook.days.find((entry) => entry.date.toISOString().slice(0, 10) === date) || null
    );
  }

  function updateChip() {
    if (!chip) {
      return;
    }

    const zoom = attachedMap ? attachedMap.getZoom() : config.forecastChipMinZoom;
    chip.setIcon(
      L.divIcon({
        className: 'wx-chip-anchor',
        html: zoom >= config.forecastChipMinZoom ? chipHtml : '',
        iconSize: null
      })
    );
  }

  // --- readouts --------------------------------------------------------------
  function wettestDailyTotal(grid, steps) {
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

  function clampLabel() {
    // Measure from the centred layout, or a box pinned by an earlier pass
    // would measure as still flush and never let go.
    dom.head.classList.remove('timeline-head--flush-left', 'timeline-head--flush-right');
    dom.headLabel.style.marginLeft = '0px';
    const track = dom.track.getBoundingClientRect();
    const label = dom.headLabel.getBoundingClientRect();
    if (track.width === 0 || label.width === 0) {
      return;
    }

    let shift = 0;
    if (label.left < track.left) {
      shift = track.left - label.left;
    } else if (label.right > track.right) {
      shift = track.right - label.right;
    }
    if (shift !== 0) {
      dom.headLabel.style.marginLeft = `${shift.toFixed(1)}px`;
    }

    // Pushed flush with the cursor's edge, the box is pinned to it exactly
    // and that corner goes square, so the two outlines run as one straight
    // line: an L at the ends of the bar rather than a T.
    const head = dom.head.getBoundingClientRect();
    const placed = dom.headLabel.getBoundingClientRect();
    dom.head.classList.toggle('timeline-head--flush-left', Math.abs(placed.left - head.left) < 1.5);
    dom.head.classList.toggle('timeline-head--flush-right', Math.abs(placed.right - head.right) < 1.5);
  }

  /** Put one forecast hour on the map and in the readouts. */
  function showBucket(index) {
    const state = active();
    if (!state?.grid) {
      return false;
    }

    current = Math.max(0, Math.min(stepCount - 1, index));
    lookingAt = stampsMs[current] || lookingAt;

    const { peak } = state.heat.showStep(current);
    const day = dayOfStep(current);

    dom.peak.textContent = `${peak.toFixed(1)} mm/h`;
    dom.total.textContent = `${wettestDailyTotal(state.grid, day.steps).toFixed(1)} mm`;
    dom.track.setAttribute('aria-valuenow', String(current));

    const outlook = outlookFor(day.date);
    chipHtml = outlook
      ? `<span class="wx-chip" style="border-color:${forecastStyleFor(outlook.rainChance).color}">` +
        `<strong>${outlook.rainChance}%</strong> chance of rain</span>`
      : '';
    updateChip();
    return true;
  }

  /** The single cursor, on the hour being shown. */
  function placeStepHead() {
    const state = active();
    const day = dayOfStep(current);
    dom.timeline.style.setProperty('--x', `${(fractionOf(current) * 100).toFixed(3)}%`);
    dom.headLabel.classList.remove('timeline-head-label--stacked');
    dom.headLabel.style.width = '';
    dom.headLabel.textContent = `${day.short} ${String(state.grid.times[current]).slice(11, 16)}`;
    dom.track.setAttribute('aria-valuetext', dom.headLabel.textContent);
    clampLabel();
  }

  function setStep(index) {
    if (!showBucket(index)) {
      return;
    }

    if (series) {
      placeSeriesHead();
    } else {
      placeStepHead();
    }
  }

  // --- Shift + drag: raining the forecast onto the map ----------------------

  const pad2 = (value) => String(value).padStart(2, '0');
  const clockOf = (ms) => {
    const date = new Date(ms);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  };

  function dayShortOf(ms) {
    const date = new Date(ms);
    const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    const day = days.find((entry) => entry.date === key);
    return day
      ? day.short
      : date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
  }

  /**
   * "Mon 25 14:00 – Tue 26 03:30" for the span, the day named once when both
   * ends share it; as two lines when asked, for a narrow box.
   */
  function spanLabel(fromMs, toMs, stacked) {
    const from = `${dayShortOf(fromMs)} ${clockOf(fromMs)}`;
    if (toMs - fromMs < 30 * 1000) {
      return stacked ? [dayShortOf(fromMs), clockOf(fromMs)] : from;
    }

    const sameDay = new Date(fromMs).toDateString() === new Date(toMs).toDateString();
    const to = sameDay ? clockOf(toMs) : `${dayShortOf(toMs)} ${clockOf(toMs)}`;
    if (!stacked) {
      return `${from} \u2013 ${to}`;
    }

    return sameDay
      ? [dayShortOf(fromMs), `${clockOf(fromMs)} \u2013 ${clockOf(toMs)}`]
      : [`${from} \u2013`, to];
  }

  function lineOf(text) {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  /**
   * The span cursor: red lines at the span's two ends, the tint from the
   * start to the moment on the map. The time box sits over it, at least as
   * wide as it, one line when that box has room for the two times and two
   * smaller lines otherwise.
   */
  function placeSeriesHead() {
    const width = dom.track.getBoundingClientRect().width;
    if (!(width > 0)) {
      return;
    }

    const px = (ms) => Math.max(HEAD_PAD_PX, Math.min(width - HEAD_PAD_PX, fractionOfMs(ms) * width));
    const x0 = px(series.fromMs);
    const x1 = Math.max(x0, px(series.endMs));
    const xs = Math.min(x1, Math.max(x0, px(series.shownMs)));
    const headWidth = x1 - x0 + 2 * HEAD_PAD_PX;

    dom.head.style.left = `${(x0 - HEAD_PAD_PX).toFixed(2)}px`;
    dom.head.style.width = `${headWidth.toFixed(2)}px`;
    // Two 2 px lines centred on x0 and x1; the tint from x0 to xs.
    dom.range.style.width = `${(x1 - x0 + 2).toFixed(2)}px`;
    dom.fill.style.width = `${(xs - x0).toFixed(2)}px`;
    dom.timeline.style.setProperty('--x', `${((xs / width) * 100).toFixed(3)}%`);

    const room = headWidth + 2 * LABEL_MARGIN_PX;
    dom.headLabel.classList.remove('timeline-head-label--stacked');
    dom.headLabel.style.width = '';
    dom.headLabel.textContent = spanLabel(series.fromMs, series.shownMs, false);
    let natural = dom.headLabel.getBoundingClientRect().width;
    if (natural > room) {
      const [top, bottom] = spanLabel(series.fromMs, series.shownMs, true);
      dom.headLabel.replaceChildren(lineOf(top), lineOf(bottom));
      dom.headLabel.classList.add('timeline-head-label--stacked');
      natural = dom.headLabel.getBoundingClientRect().width;
    }
    dom.headLabel.style.width = `${Math.min(width, Math.max(room, natural)).toFixed(2)}px`;
    dom.track.setAttribute('aria-valuetext', spanLabel(series.fromMs, series.shownMs, false));
    clampLabel();
  }

  /** Whether a pointer position lies on the span (a few pixels' grace). */
  function onSpan(clientX) {
    if (!series) {
      return false;
    }

    const rect = dom.track.getBoundingClientRect();
    const x = clientX - rect.left;
    return x >= fractionOfMs(series.fromMs) * rect.width - 4 && x <= fractionOfMs(series.endMs) * rect.width + 4;
  }

  function exitSeries() {
    series = null;
    dom.timeline.classList.remove('timeline--series');
    dom.head.style.left = '';
    dom.head.style.width = '';
    dom.range.style.width = '';
    dom.fill.style.width = '';
    dom.headLabel.classList.remove('timeline-head-label--stacked');
    dom.headLabel.style.width = '';
    if (active()?.grid && stepCount > 0) {
      setStep(current);
    }
    refreshHint();
  }

  /** Both layers on, and a driver to rain with. */
  function seriesAvailable() {
    const state = active();
    const source = activeKey ? sources.get(activeKey) : null;
    return Boolean(
      seriesHandler &&
        state?.grid &&
        stampsMs.length > 1 &&
        attachedMap &&
        source &&
        attachedMap.hasLayer(source.layer) &&
        seriesHandler.canStart()
    );
  }

  function setHint(text) {
    dom.hint.hidden = !text;
    dom.hint.textContent = text || '';
  }

  /** The standing hint: how to start, shown whenever it would work. */
  function refreshHint() {
    clearTimeout(hintTimer);
    hintTimer = 0;
    setHint(
      seriesAvailable()
        ? 'Shift + drag the bar to rain this forecast onto the map, hour by hour.'
        : null
    );
  }

  /** Why Shift + drag did nothing, for a few seconds. */
  function flashHint() {
    const text = !seriesHandler?.canStart()
      ? 'Shift + drag rains this forecast onto the map: tick the Rainfall Simulator layer first.'
      : 'Shift + drag rains this forecast onto the map: switch this forecast layer on first.';
    setHint(text);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(refreshHint, 3200);
  }

  /** Nearest step in the active grid to the moment last looked at. */
  function stepNearest(target) {
    const state = active();
    if (!state?.grid || !Number.isFinite(target)) {
      return 0;
    }

    let best = 0;
    let bestGap = Infinity;
    state.grid.times.forEach((time, index) => {
      const gap = Math.abs(Date.parse(time) - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    });
    return best;
  }

  // --- timeline --------------------------------------------------------------
  function buildTimeline() {
    const state = active();

    if (!state?.grid) {
      const text = state ? `${state.name} · ${state.status || 'loading'}` : 'no forecast';
      dom.source.textContent = text;
      dom.track.innerHTML = `<span class="timeline-day timeline-day--status">${state?.status || 'loading'}</span>`;
      dom.timeline.style.setProperty('--x', '0%');
      dom.headLabel.textContent = '--:--';
      dom.now.hidden = true;
      dom.peak.textContent = '-';
      dom.total.textContent = '-';
      days = [];
      stepCount = 0;
      stampsMs = [];
      chipHtml = '';
      updateChip();
      refreshHint();
      return;
    }

    const { grid } = state;
    days = groupByDay(grid.times);
    stepCount = grid.times.length;
    stampsMs = grid.times.map((time) => Date.parse(time));

    // "hourly" is already implied by the timeline.
    dom.source.textContent = `${state.name} · ${grid.resolutionText.split(',')[0]}`;
    dom.track.innerHTML = days
      .map((day) => `<span class="timeline-day" style="flex-grow:${day.steps.length}">${day.short}</span>`)
      .join('');
    dom.track.setAttribute('aria-valuemax', String(stepCount - 1));

    const stamp = new Date();
    const nowKey =
      `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-` +
      `${String(stamp.getDate()).padStart(2, '0')}T${String(stamp.getHours()).padStart(2, '0')}`;
    const nowStep = grid.times.findIndex((time) => String(time).startsWith(nowKey));
    dom.now.hidden = nowStep < 0;
    if (nowStep >= 0) {
      dom.now.style.left = `${(fractionOf(nowStep) * 100).toFixed(3)}%`;
    }

    // Land on the hour being looked at before the switch; failing that, now.
    const target = Number.isFinite(lookingAt) ? lookingAt : Date.now();
    setStep(stepNearest(target));
    refreshHint();
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Rebuild the timeline for the active source, sliding the old one away. */
  async function show(key, { animate = true } = {}) {
    // A span rained from one run means nothing on another's bar.
    if (series) {
      seriesHandler?.end();
    }
    activeKey = key;
    const token = ++swapToken;

    if (!animate) {
      buildTimeline();
      return;
    }

    dom.timeline.classList.add('timeline--leaving');
    await wait(170);
    if (token !== swapToken) {
      return;
    }

    buildTimeline();
    dom.timeline.classList.remove('timeline--leaving');
    dom.timeline.classList.add('timeline--entering');
    void dom.track.offsetWidth;
    dom.timeline.classList.remove('timeline--entering');
  }

  // --- scrubbing -------------------------------------------------------------
  function stepAt(clientX) {
    const rect = dom.track.getBoundingClientRect();
    if (rect.width <= 0 || stepCount === 0) {
      return current;
    }

    const fraction = (clientX - rect.left) / rect.width;
    return Math.round(Math.max(0, Math.min(1, fraction)) * (stepCount - 1));
  }

  // A pointer reports moves faster than the screen refreshes, and each one
  // would otherwise redraw the whole heatmap. Coalescing them means at most
  // one redraw per frame, of the position the pointer actually reached.
  let pendingStep = null;
  let pendingFrame = 0;
  function scrubTo(index) {
    pendingStep = index;
    if (pendingFrame) {
      return;
    }

    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const target = pendingStep;
      pendingStep = null;
      if (target !== null) {
        setStep(target);
      }
    });
  }

  // 'steps' is the ordinary scrub; 'end' is Shift + drag, placing the end of
  // the forecast-rain span; 'scrub' is a plain drag inside the span.
  let dragging = null;
  dom.track.addEventListener('pointerdown', (event) => {
    if (event.shiftKey && seriesHandler) {
      if (!seriesAvailable()) {
        flashHint();
      } else {
        const ms = msAtClient(event.clientX);
        // A fresh span when none is running, or the pointer landed before
        // this one's start; otherwise the end of the running span moves.
        if (!series || ms < series.fromMs) {
          seriesHandler.begin({ grid: active().grid, fromMs: ms });
        }
        seriesHandler.setEnd(ms);
        dragging = 'end';
        dom.track.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
    }

    if (series) {
      // On the span: look at that moment of it. Off it: the forecast is
      // just being looked at again, and the span and its water go.
      if (onSpan(event.clientX)) {
        seriesHandler?.showAt(msAtClient(event.clientX));
        dragging = 'scrub';
        dom.track.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      seriesHandler?.end();
    }
    dragging = 'steps';
    dom.track.setPointerCapture(event.pointerId);
    setStep(stepAt(event.clientX));
    event.preventDefault();
  });
  dom.track.addEventListener('pointermove', (event) => {
    if (dragging === 'steps') {
      scrubTo(stepAt(event.clientX));
    } else if (dragging === 'end') {
      seriesHandler?.setEnd(msAtClient(event.clientX));
    } else if (dragging === 'scrub') {
      // The driver shows at most one moment per frame.
      seriesHandler?.showAt(msAtClient(event.clientX));
    }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    dom.track.addEventListener(type, (event) => {
      // The span plays once its end is let go of.
      if (dragging === 'end') {
        seriesHandler?.play();
      }
      dragging = null;
      if (dom.track.hasPointerCapture(event.pointerId)) {
        dom.track.releasePointerCapture(event.pointerId);
      }
    });
  }
  dom.track.addEventListener('keydown', (event) => {
    const jump = { ArrowLeft: -1, ArrowRight: 1, PageDown: -24, PageUp: 24 }[event.key];
    if (jump === undefined) {
      return;
    }
    if (series && seriesHandler) {
      if (event.shiftKey) {
        // Shift moves the end, and the span plays on to it.
        seriesHandler.setEnd(series.endMs + jump * stepMs());
        seriesHandler.play();
      } else {
        seriesHandler.showAt(series.shownMs + jump * stepMs());
      }
      event.preventDefault();
      return;
    }
    setStep(current + jump);
    event.preventDefault();
  });
  dom.track.title =
    'Drag to scrub the hours · Shift + drag to mark a span of the forecast to rain onto the map';

  // The span cursor is placed in pixels, so it has to follow the panel.
  window.addEventListener('resize', () => {
    if (series) {
      placeSeriesHead();
    } else if (active()?.grid) {
      clampLabel();
    }
  });

  // --- map readout -----------------------------------------------------------
  // The x offset is deliberate. A pointer's hotspot is the arrow's tip, at the
  // top-left of the glyph, so a readout centred on the hotspot sits visibly
  // left of the arrow a user is looking at; nine pixels puts it over the glyph.
  const readout = L.tooltip({ sticky: true, direction: 'top', offset: [9, -4], className: 'wx-heat-tip' });

  function onMove(event) {
    const state = active();
    const value = state?.heat ? state.heat.valueAt(event.latlng.lat, event.latlng.lng) : null;
    if (value === null || value === undefined) {
      readout.close();
      return;
    }

    readout
      .setLatLng(event.latlng)
      .setContent(
        `<strong>${value.toFixed(1)} mm/h</strong>` +
          `<small>${state.name} · ${state.grid.resolutionText.split(',')[0]}</small>`
      )
      .openOn(event.target);
  }

  const onZoom = () => updateChip();

  function anySourceOnMap(map) {
    for (const source of sources.values()) {
      if (map.hasLayer(source.layer)) {
        return true;
      }
    }
    return false;
  }

  return {
    registerSources(list) {
      for (const source of list) {
        sources.set(source.key, source);
      }
    },

    setProvinceOutlook(outlook) {
      provinceOutlook = outlook;
      if (active()?.grid) {
        setStep(current);
      }
    },

    show,

    /** A source's layer was switched on: it takes the card, and the other goes. */
    onSourceShown(key, map) {
      // Deferred a tick on purpose. Leaflet's layers control ignores layer
      // changes while it is handling the click that caused this, so removing
      // the sibling synchronously took it off the map but left its checkbox
      // ticked. After the click completes the control resyncs normally.
      setTimeout(() => {
        for (const source of sources.values()) {
          if (source.key !== key && map.hasLayer(source.layer)) {
            map.removeLayer(source.layer);
          }
        }
      }, 0);

      if (attachedMap !== map) {
        attachedMap = map;
        map.on('mousemove', onMove);
        map.on('zoomend', onZoom);
        if (chip) {
          chip.addTo(map);
        }
      }

      show(key, { animate: true });
    },

    onSourceHidden(key, map) {
      if (series && key === activeKey) {
        seriesHandler?.end();
      }
      if (map && !anySourceOnMap(map)) {
        map.off('mousemove', onMove);
        map.off('zoomend', onZoom);
        readout.close();
        if (chip) {
          chip.remove();
        }
        attachedMap = null;
      }
      // The card keeps showing the last source: the forecast is worth reading
      // whether or not it is drawn on the map.
      refreshHint();
    },

    /**
     * Wire up Shift + drag. handler.canStart() says whether the simulator is
     * there to rain onto; begin/setEnd/play/showAt/end drive the span, and
     * the driver reports back through setSeries.
     */
    setSeriesHandler(handler) {
      seriesHandler = handler;
      refreshHint();
    },

    /** From the driver: where the span stands, or null when it has ended. */
    setSeries(state) {
      if (!state) {
        if (series) {
          exitSeries();
        }
        return;
      }

      const entering = !series;
      series = state;
      if (entering) {
        dom.timeline.classList.add('timeline--series');
      }
      const bucket = bucketOfMs(state.shownMs);
      if (entering || bucket !== current) {
        showBucket(bucket);
      }
      placeSeriesHead();
    },

    /** Re-read the standing hint after a layer changed under it. */
    refreshHint,

    /** A source's data changed; if it is the one on the card, redraw it. */
    onSourceUpdated(key) {
      if (key === activeKey) {
        show(key, { animate: Boolean(active()?.grid) });
      }
    }
  };
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

/**
 * Centre of area of the largest ring in a GeoJSON polygon.
 *
 * Chon Buri is an L-shape with offshore islands, so its bounding-box centre
 * lands outside the province. The area centroid of the mainland ring sits
 * where a label belongs.
 */
function polygonCentroid(geojson) {
  const features = geojson.features || [geojson];
  let best = null;
  let bestArea = 0;

  for (const feature of features) {
    const geometry = feature.geometry || feature;
    const polygons =
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates || [];

    for (const polygon of polygons) {
      const ring = polygon[0];
      if (!ring || ring.length < 4) {
        continue;
      }

      // Shoelace: twice the signed area, and the area-weighted centre.
      let twiceArea = 0;
      let x = 0;
      let y = 0;
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        const cross = x1 * y2 - x2 * y1;
        twiceArea += cross;
        x += (x1 + x2) * cross;
        y += (y1 + y2) * cross;
      }

      const area = Math.abs(twiceArea / 2);
      if (area > bestArea && twiceArea !== 0) {
        bestArea = area;
        best = [y / (3 * twiceArea), x / (3 * twiceArea)];
      }
    }
  }

  return best || [0, 0];
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
        // Short enough to fit a timeline cell one seventh of a panel wide.
        short: parsed.toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
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
  // difference between 1 mm and 10 mm stays visible. The floor is a target a
  // fingertip or a hurried mouse can hit: at 4 px a dry gauge was 8 px
  // across. Pixel radius, so the dot keeps its size at every zoom.
  return 7 + Math.min(9, Math.sqrt(Math.max(0, mm)) * 1.3);
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
      // markerPane sits above the overlay pane, so a gauge stays hoverable
      // with the forecast heatmap drawn over the same ground.
      pane: 'markerPane',
      radius: gaugeRadius(station.rainMm),
      color: '#ff69b4',
      weight: 2,
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
