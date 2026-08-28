// Wind over the study area, from Open-Meteo (keyless). Two uses:
//
//   * STEERING - a storm cell drifts with the wind aloft, so a newly placed
//     cell takes its speed and bearing from here instead of standing still.
//     The 850 hPa wind (about 1.5 km up) is asked for, because that is what
//     steers convective cells; if the model serving the point has no pressure
//     levels, the 10 m wind scaled up stands in.
//   * READOUT - surface wind, gusts and sea-level pressure shown in the panel;
//     a deep low and an onshore gale are the ingredients of a storm surge,
//     which the marine sea-level forecast already folds in.
//
// Directions are meteorological (where the wind comes FROM, degrees
// clockwise from north); speeds are m/s.

import { config } from '../config.js';
import { stormSteering } from '../hydro/hydraulics.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SURFACE_VARIABLES = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl'];
const STEERING_VARIABLES = ['wind_speed_850hPa', 'wind_direction_850hPa'];

export async function createWindSource({ lat, lng } = {}) {
  let series = null;

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      series = await fetchWindSeries(lat, lng, true);
    } catch (error) {
      // Not every model offers pressure levels; fall back to the surface set.
      try {
        series = await fetchWindSeries(lat, lng, false);
      } catch (retryError) {
        console.warn('Wind forecast unavailable:', retryError.message);
      }
    }
  }

  /**
   * The series interpolated at ms. Speeds are interpolated directly; a
   * direction is interpolated as a vector so 350 -> 10 degrees goes through
   * north rather than through south.
   */
  function sampleAt(ms) {
    if (!series) {
      return null;
    }
    const { times } = series;
    const last = times.length - 1;
    if (ms < times[0] - 6 * 3.6e6 || ms > times[last] + 6 * 3.6e6) {
      return null;
    }
    let index = Math.min(last - 1, Math.max(0, Math.floor((ms - times[0]) / 3.6e6)));
    while (index > 0 && times[index] > ms) {
      index -= 1;
    }
    while (index < last - 1 && times[index + 1] <= ms) {
      index += 1;
    }
    const ratio = Math.min(1, Math.max(0, (ms - times[index]) / (times[index + 1] - times[index])));
    const lerp = (values) => values[index] + (values[index + 1] - values[index]) * ratio;
    const wind = (speeds, directions) => {
      const a = toVector(speeds[index], directions[index]);
      const b = toVector(speeds[index + 1], directions[index + 1]);
      const east = a.east + (b.east - a.east) * ratio;
      const north = a.north + (b.north - a.north) * ratio;
      return fromVector(east, north);
    };

    const surface = wind(series.speed10, series.direction10);
    const steering = series.speed850 ? wind(series.speed850, series.direction850) : null;
    return {
      speedMs: surface.speed,
      directionDeg: surface.direction,
      gustMs: lerp(series.gust),
      pressureHpa: lerp(series.pressure),
      steeringSpeedMs: steering ? steering.speed : surface.speed * config.stormSteeringSurfaceFactor,
      steeringDirectionDeg: steering ? steering.direction : surface.direction,
      steeringFromAloft: Boolean(steering)
    };
  }

  return {
    get available() {
      return Boolean(series);
    },

    get source() {
      return series ? `Open-Meteo${series.speed850 ? ' (850 hPa steering)' : ' (10 m wind)'}` : 'none';
    },

    /** Surface wind, gusts, pressure and steering wind at ms, or null. */
    windAt(ms) {
      return sampleAt(ms);
    },

    /**
     * The velocity a storm cell placed at ms should drift with, in the grid's
     * east/north metres per second, or null with no forecast.
     */
    steeringVelocityAt(ms) {
      const sample = sampleAt(ms);
      if (!sample) {
        return null;
      }
      return stormSteering({
        speedMs: sample.steeringSpeedMs,
        directionFromDeg: sample.steeringDirectionDeg,
        factor: config.stormSteeringFactor
      });
    }
  };
}

function toVector(speed, directionFromDeg) {
  // The vector points where the air is GOING, so "from" is turned around.
  const toward = ((directionFromDeg + 180) * Math.PI) / 180;
  return { east: speed * Math.sin(toward), north: speed * Math.cos(toward) };
}

function fromVector(east, north) {
  const speed = Math.hypot(east, north);
  const toward = (Math.atan2(east, north) * 180) / Math.PI;
  return { speed, direction: (toward + 180 + 360) % 360 };
}

async function fetchWindSeries(lat, lng, withSteering) {
  const variables = withSteering ? [...SURFACE_VARIABLES, ...STEERING_VARIABLES] : SURFACE_VARIABLES;
  const url =
    `${FORECAST_URL}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=${variables.join(',')}&wind_speed_unit=ms&past_days=1&forecast_days=7&timeformat=unixtime`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo responded ${response.status}`);
  }

  const hourly = (await response.json())?.hourly || {};
  const times = (hourly.time || []).map((value) => Number(value) * 1000);
  if (times.length < 2) {
    throw new Error('no wind values in the response');
  }
  const column = (name) => {
    const values = hourly[name];
    if (!Array.isArray(values) || values.length !== times.length) {
      return null;
    }
    // Gaps (null) are carried forward so interpolation never meets a NaN.
    const out = new Float64Array(times.length);
    let previous = 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = Number(values[index]);
      previous = Number.isFinite(value) ? value : previous;
      out[index] = previous;
    }
    return out;
  };

  const speed10 = column('wind_speed_10m');
  const direction10 = column('wind_direction_10m');
  if (!speed10 || !direction10) {
    throw new Error('no surface wind in the response');
  }
  const speed850 = withSteering ? column('wind_speed_850hPa') : null;
  const direction850 = withSteering ? column('wind_direction_850hPa') : null;

  return {
    times: Float64Array.from(times),
    speed10,
    direction10,
    gust: column('wind_gusts_10m') || speed10,
    pressure: column('pressure_msl') || new Float64Array(times.length).fill(1010),
    speed850: speed850 && direction850 ? speed850 : null,
    direction850: speed850 && direction850 ? direction850 : null
  };
}
