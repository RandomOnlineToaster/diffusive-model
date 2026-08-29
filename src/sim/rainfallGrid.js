// Rainfall grid: turns storm intensity into water on the ground.
//
//   Storm System  ->  [ Rainfall Grid ]  ->  Terrain / Water Grid
//
// Holds one cell per patch of ground and, each timestep, asks the storm system
// how hard it is raining there, converts that to a depth, and accumulates it.
// The terrain/hydraulic model can then read `accumulation` as its input.

import { stormIntensityAt } from './storm.js';

const METERS_PER_DEGREE_LAT = 110574;

// Blue -> cyan -> green -> yellow -> orange -> red. Stops are in mm/hour, so a
// colour means a fixed rainfall rate rather than a share of the current peak.
const INTENSITY_STOPS = [
  { mmPerHour: 0.5, color: [37, 99, 235] },
  { mmPerHour: 5, color: [6, 182, 212] },
  { mmPerHour: 15, color: [22, 163, 74] },
  { mmPerHour: 35, color: [234, 179, 8] },
  { mmPerHour: 60, color: [249, 115, 22] },
  { mmPerHour: 100, color: [220, 38, 38] }
];

export const RAINFALL_LEGEND = INTENSITY_STOPS.map((stop) => ({
  mmPerHour: stop.mmPerHour,
  color: `rgb(${stop.color.join(',')})`
}));

export function createRainfallGrid({ bounds, columns = 240, rows = 240, drainTauSeconds = 900 }) {
  const midLat = (bounds.north + bounds.south) / 2;
  const metersPerDegreeLng = 111320 * Math.cos((midLat * Math.PI) / 180);

  const widthMeters = (bounds.east - bounds.west) * metersPerDegreeLng;
  const heightMeters = (bounds.north - bounds.south) * METERS_PER_DEGREE_LAT;
  const cellWidthMeters = widthMeters / columns;
  const cellHeightMeters = heightMeters / rows;
  const cellAreaM2 = cellWidthMeters * cellHeightMeters;

  // Cell centres in local metres: x east of the west edge, y north of the south
  // edge. Precomputed so the per-timestep loop stays arithmetic-light.
  const cellX = new Float64Array(columns);
  for (let column = 0; column < columns; column += 1) {
    cellX[column] = (column + 0.5) * cellWidthMeters;
  }

  const cellY = new Float64Array(rows);
  for (let row = 0; row < rows; row += 1) {
    // Row 0 is the north edge, matching image and DEM row order.
    cellY[row] = heightMeters - (row + 0.5) * cellHeightMeters;
  }

  const cellCount = columns * rows;
  const intensity = new Float32Array(cellCount);
  // The storm part of the field on its own, kept only while the intensity is
  // storms laid over a base field - a forecast span holding the grid. It is
  // what lets the simulator draw its storms over the forecast's own heatmap
  // instead of painting the forecast's rain a second time. With no base the
  // storms are the whole field, and this is left as it was.
  const stormRain = new Float32Array(cellCount);
  const accumulation = new Float32Array(cellCount);
  // Water currently sitting on the surface: rain adds to it, drainage and
  // infiltration take it away as exp(-dt / drainTauSeconds). The flow layers
  // weight by this, so runoff dries out after a storm moves on instead of
  // remembering every drop that ever fell.
  const surface = new Float32Array(cellCount);
  const pixels = new Uint8ClampedArray(cellCount * 4);

  let elapsedSeconds = 0;
  // Summed across cells (drives volume) and the single wettest cell (a real
  // depth, which is what the readout should show).
  let lastStepDepthMm = 0;
  let lastStepPeakMm = 0;

  const columnFromX = (x) => Math.floor(x / cellWidthMeters);
  const rowFromY = (y) => Math.floor((heightMeters - y) / cellHeightMeters);

  return {
    columns,
    rows,
    bounds,
    cellWidthMeters,
    cellHeightMeters,
    cellAreaM2,
    intensity,
    stormIntensity: stormRain,
    accumulation,
    surface,

    get elapsedSeconds() {
      return elapsedSeconds;
    },

    get lastStepDepthMm() {
      return lastStepDepthMm;
    },

    get lastStepPeakMm() {
      return lastStepPeakMm;
    },

    /** Local metres for a lat/lng: the coordinate space storms live in. */
    toLocal(lat, lng) {
      return {
        x: (lng - bounds.west) * metersPerDegreeLng,
        y: (lat - bounds.south) * METERS_PER_DEGREE_LAT
      };
    },

    /** Inverse of toLocal, for placing a storm from a map click. */
    toLatLng(x, y) {
      return {
        lat: bounds.south + y / METERS_PER_DEGREE_LAT,
        lng: bounds.west + x / metersPerDegreeLng
      };
    },

    indexAt(lat, lng) {
      const { x, y } = this.toLocal(lat, lng);
      const column = columnFromX(x);
      const row = rowFromY(y);

      if (column < 0 || row < 0 || column >= columns || row >= rows) {
        return -1;
      }

      return row * columns + column;
    },

    reset() {
      intensity.fill(0);
      accumulation.fill(0);
      surface.fill(0);
      elapsedSeconds = 0;
      lastStepDepthMm = 0;
      lastStepPeakMm = 0;
    },

    /**
     * Rebuild the intensity field from a list of storms, optionally on top of
     * a base field - the forecast's rain, while a forecast span holds the
     * grid, so a placed storm rains into the same water the forecast does.
     *
     * Only cells inside a storm's rain radius are visited, so cost scales with
     * storm area rather than grid size.
     */
    compose(storms, { noiseAmplitude = 0, base = null, atSeconds = elapsedSeconds } = {}) {
      // With a base the storms are built apart and summed onto it; without
      // one they are the field itself, and are built straight into it.
      const target = base ? stormRain : intensity;
      target.fill(0);

      for (const storm of storms) {
        const radius = storm.rainRadiusMeters;
        const firstColumn = Math.max(0, columnFromX(storm.x - radius));
        const lastColumn = Math.min(columns - 1, columnFromX(storm.x + radius));
        // Rows count southward, so +radius in y is the smaller row index.
        const firstRow = Math.max(0, rowFromY(storm.y + radius));
        const lastRow = Math.min(rows - 1, rowFromY(storm.y - radius));

        for (let row = firstRow; row <= lastRow; row += 1) {
          const y = cellY[row];
          const rowOffset = row * columns;

          for (let column = firstColumn; column <= lastColumn; column += 1) {
            const value = stormIntensityAt(storm, cellX[column], y);
            if (value > 0) {
              target[rowOffset + column] += value;
            }
          }
        }
      }

      // Optional spatial variation, applied after the Gaussian so the Gaussian
      // stays dominant, and to the storms alone - a published forecast is not
      // ours to add texture to. Smooth over ~1 km rather than per-cell random,
      // which would just look like static.
      // The texture drifts with time - the grid's own clock unless the caller
      // is composing the field for some other moment.
      if (noiseAmplitude > 0) {
        applyNoise(target, columns, rows, atSeconds, noiseAmplitude);
      }

      if (base) {
        for (let index = 0; index < cellCount; index += 1) {
          intensity[index] = target[index] + base[index];
        }
      }
    },

    /**
     * One timestep of storm rain: rebuild the field, then integrate it. Two
     * calls rather than one so a forecast span can rebuild the field at each
     * of its own slices and integrate on its own clock.
     */
    step(stormSystem, dtSeconds, options = {}) {
      this.compose(stormSystem.storms, options);
      this.integrate(dtSeconds);
    },

    /**
     * One timestep with the intensity field as it stands, held constant.
     *
     * step() rebuilds intensity from the storms; this takes whatever the
     * caller has put in `intensity` - a forecast hour resampled onto the
     * grid - and rains it for dt. At a steady rate the surface-water
     * equation ds/dt = I/3600 - s/tau has a closed form, so one call over a
     * whole forecast hour lands on the same water as sixty one-minute steps.
     */
    integrate(dtSeconds) {
      if (!(dtSeconds > 0)) {
        return;
      }

      elapsedSeconds += dtSeconds;
      const hours = dtSeconds / 3600;
      const decay = Math.exp(-dtSeconds / drainTauSeconds);
      // Surface water left at the end of dt from rain at 1 mm/h throughout.
      const gain = (drainTauSeconds / 3600) * (1 - decay);
      let stepTotal = 0;
      let stepPeak = 0;

      for (let index = 0; index < cellCount; index += 1) {
        const rate = intensity[index];
        let remaining = surface[index] * decay;

        if (rate > 0) {
          const depth = rate * hours;
          accumulation[index] += depth;
          stepTotal += depth;
          if (depth > stepPeak) {
            stepPeak = depth;
          }
          remaining += rate * gain;
        }

        surface[index] = remaining > 0.02 ? remaining : 0;
      }

      lastStepDepthMm = stepTotal;
      lastStepPeakMm = stepPeak;
    },

    /** Water added over the whole grid this step, in cubic metres. */
    stepVolumeM3() {
      return (lastStepDepthMm / 1000) * cellAreaM2;
    },

    /** Water standing on the ground across the grid right now, in cubic metres. */
    surfaceVolumeM3() {
      let total = 0;
      for (let index = 0; index < cellCount; index += 1) {
        total += surface[index];
      }
      return (total / 1000) * cellAreaM2;
    },

    totals() {
      let wetCells = 0;
      let peakAccumulationMm = 0;
      let totalDepth = 0;

      for (let index = 0; index < cellCount; index += 1) {
        const value = accumulation[index];
        if (value > 0) {
          wetCells += 1;
          totalDepth += value;
          if (value > peakAccumulationMm) {
            peakAccumulationMm = value;
          }
        }
      }

      return {
        wetCells,
        peakAccumulationMm,
        totalVolumeM3: (totalDepth / 1000) * cellAreaM2
      };
    },

    /** Paint a field into an RGBA buffer for the canvas layer. */
    toPixels(field = intensity, scale = 1) {
      for (let index = 0; index < cellCount; index += 1) {
        const offset = index * 4;
        const value = field[index] * scale;
        const alpha = intensityAlpha(value);

        if (alpha <= 0) {
          pixels[offset + 3] = 0;
          continue;
        }

        const [r, g, b] = rampColor(value);
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = alpha;
      }

      return pixels;
    }
  };
}

/**
 * How opaque a rain rate is painted, 0-255. Translucent throughout: the field
 * is context, and the streets and flow lines underneath have to stay readable
 * through it. Nothing below the first legend stop is drawn at all.
 */
export function intensityAlpha(value) {
  return value < INTENSITY_STOPS[0].mmPerHour ? 0 : Math.min(145, 35 + value * 1.3);
}

/**
 * The same colour as one of the field's pixels, as CSS - for painting a rain
 * rate anywhere the grid's own image cannot reach.
 */
export function intensityCss(value) {
  const alpha = intensityAlpha(value);
  if (alpha <= 0) {
    return 'rgba(0, 0, 0, 0)';
  }
  const [r, g, b] = rampColor(value);
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(alpha / 255).toFixed(3)})`;
}

// Continuous colour for a rain rate, interpolated between the legend stops.
// Shared with the forecast heatmap so predicted and simulated rain read on
// exactly the same scale.
export function rampColor(value) {
  for (let index = 1; index < INTENSITY_STOPS.length; index += 1) {
    const previous = INTENSITY_STOPS[index - 1];
    const current = INTENSITY_STOPS[index];

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

  return INTENSITY_STOPS[INTENSITY_STOPS.length - 1].color;
}

// Smooth value noise on a coarse lattice, drifting with time. Coarse on purpose:
// per-cell randomness would break the smooth falloff the Gaussian provides.
const NOISE_LATTICE_CELLS = 8;

function applyNoise(field, columns, rows, elapsedSeconds, amplitude) {
  const drift = elapsedSeconds / 600;

  for (let row = 0; row < rows; row += 1) {
    const gy = row / NOISE_LATTICE_CELLS;
    const y0 = Math.floor(gy);
    const ty = smoothStep(gy - y0);

    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (field[index] === 0) {
        continue;
      }

      const gx = column / NOISE_LATTICE_CELLS + drift;
      const x0 = Math.floor(gx);
      const tx = smoothStep(gx - x0);

      const top = lerp(hashNoise(x0, y0), hashNoise(x0 + 1, y0), tx);
      const bottom = lerp(hashNoise(x0, y0 + 1), hashNoise(x0 + 1, y0 + 1), tx);
      const noise = lerp(top, bottom, ty);

      // noise is 0..1, so this scales intensity by 1 +/- amplitude.
      field[index] *= 1 + (noise * 2 - 1) * amplitude;
    }
  }
}

function hashNoise(x, y) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

const smoothStep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
