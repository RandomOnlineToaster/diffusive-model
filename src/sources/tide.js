// Sea level at the outfalls: the boundary the street and pipe models drain
// against. A drain that ends at the beach cannot discharge when the tide is
// above it, and at high water the sea comes back up through it.
//
//   Open-Meteo Marine  -> hourly sea level (tide + surge), keyless, ~7 days
//   harmonic fallback  -> the shape of Pattaya's mixed diurnal tide, when the
//                         forecast cannot be fetched (see hydraulics.js)
//   manual override    -> a fixed level, for "what if the sea stood at +1 m"
//
// On top of whichever source is active sits an OFFSET the panel's surge slider
// sets, so a storm surge can be tried without changing the source.
//
// Levels are metres above mean sea level. COP30 heights are on the EGM2008
// geoid, which is within a few decimetres of local MSL here, so the two are
// compared directly.

import { config } from '../config.js';
import { harmonicTide } from '../hydro/hydraulics.js';

const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const HOUR_MS = 3600 * 1000;

export async function createTideSource({ lat, lng } = {}) {
  let series = null; // { times: Float64Array (ms), levels: Float64Array (m) }
  let cell = null;
  let manualLevel = null;
  let offsetM = 0;
  let mode = config.tideMode; // 'auto' | 'harmonic' | 'manual'

  if (mode === 'manual') {
    manualLevel = config.tideManualM;
  }

  if (mode === 'auto' && Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      const fetched = await fetchMarineSeries(lat, lng);
      series = fetched.series;
      cell = fetched.cell;
    } catch (error) {
      console.warn('Sea level forecast unavailable, using the harmonic tide:', error.message);
    }
  }

  /** Interpolated level from the series, or null outside its span. */
  function seriesLevelAt(ms) {
    if (!series) {
      return null;
    }
    const { times, levels } = series;
    const last = times.length - 1;
    if (ms <= times[0]) {
      return ms >= times[0] - 6 * HOUR_MS ? levels[0] : null;
    }
    if (ms >= times[last]) {
      return ms <= times[last] + 6 * HOUR_MS ? levels[last] : null;
    }
    // Hourly samples, so the slot is a division rather than a search.
    const step = (times[last] - times[0]) / last;
    let index = Math.floor((ms - times[0]) / step);
    if (index >= last) {
      index = last - 1;
    }
    while (index > 0 && times[index] > ms) {
      index -= 1;
    }
    while (index < last - 1 && times[index + 1] <= ms) {
      index += 1;
    }
    const ratio = (ms - times[index]) / (times[index + 1] - times[index]);
    return levels[index] + (levels[index + 1] - levels[index]) * ratio;
  }

  let range = null;
  if (series) {
    let low = Infinity;
    let high = -Infinity;
    for (const level of series.levels) {
      low = Math.min(low, level);
      high = Math.max(high, level);
    }
    range = { minM: low, maxM: high };
  }

  return {
    get available() {
      return Boolean(series);
    },

    /** Which source the level is coming from right now. */
    get source() {
      if (manualLevel !== null) {
        return 'manual';
      }
      return series ? 'Open-Meteo Marine' : 'harmonic tide (synthetic)';
    },

    get cell() {
      return cell;
    },

    /** Lowest and highest level in the fetched series, or null. */
    get range() {
      return range;
    },

    get offsetM() {
      return offsetM;
    },

    /** Extra metres on top of the source - the surge slider. */
    setOffset(metres) {
      offsetM = Number.isFinite(metres) ? metres : 0;
    },

    /** Pin the level (metres MSL), or null to go back to the source. */
    setManual(metres) {
      manualLevel = Number.isFinite(metres) ? metres : null;
      mode = manualLevel === null ? config.tideMode : 'manual';
    },

    /** Sea level in metres MSL at a moment (Unix ms). */
    levelAt(ms) {
      if (manualLevel !== null) {
        return manualLevel + offsetM;
      }
      const forecast = seriesLevelAt(ms);
      if (forecast !== null) {
        return forecast + offsetM;
      }
      return harmonicTide(ms) + offsetM;
    },

    /** True when levelAt(ms) would be the synthetic tide, for labelling. */
    isSyntheticAt(ms) {
      return manualLevel === null && seriesLevelAt(ms) === null;
    }
  };
}

async function fetchMarineSeries(lat, lng) {
  const url =
    `${MARINE_URL}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    '&hourly=sea_level_height_msl&past_days=1&forecast_days=7&timeformat=unixtime';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo Marine responded ${response.status}`);
  }

  const payload = await response.json();
  const rawTimes = payload?.hourly?.time || [];
  const rawLevels = payload?.hourly?.sea_level_height_msl || [];
  const times = [];
  const levels = [];
  for (let index = 0; index < rawTimes.length; index += 1) {
    const level = Number(rawLevels[index]);
    if (Number.isFinite(level)) {
      times.push(Number(rawTimes[index]) * 1000);
      levels.push(level);
    }
  }
  if (times.length < 2) {
    throw new Error('no sea level values in the response');
  }

  return {
    series: { times: Float64Array.from(times), levels: Float64Array.from(levels) },
    cell: { lat: payload.latitude, lng: payload.longitude }
  };
}
