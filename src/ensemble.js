// An ensemble of storm scenarios, for the "chaos" in a forecast: nobody knows
// exactly where a cell will track, how fast it will move or how hard it will
// rain, so instead of one answer the same storms are replayed many times with
// those things jittered, and the result is a CHANCE of flooding per street.
//
//   placed storms --jitter x N--> N runs of grid + streets + pipes
//                                        |
//                                        v
//               probability[n] = runs in which junction n flooded / N
//
// Member 1 is the storms exactly as placed (the control); the others draw
// their jitters from a seeded generator, so a run repeats exactly.
//
// Each member is a full simulation of the street network, so the runner
// yields to the browser between members and reports progress; a few members
// over a few hours takes tens of seconds.

import { config } from './config.js';

export function createEnsembleRunner({ rainfall, streets, pipes = null, seaLevelAt = null, onProgress = null }) {
  let cancelled = false;
  let running = false;

  /**
   * Run the ensemble. Resets the water on the map before and after: the
   * scenario is the storms as placed, replayed from dry ground.
   *
   * Returns null with no storms placed, otherwise
   *   { probability, meanMaxDepth, members, thresholdM, floodedJunctions, durationS }
   * with one entry per street junction.
   */
  async function run(options = {}) {
    const members = options.members ?? config.ensembleMembers;
    const durationS = (options.durationHours ?? config.ensembleDurationHours) * 3600;
    const stepS = options.stepSeconds ?? config.ensembleStepSeconds;
    const thresholdM = options.thresholdM ?? config.ensembleThresholdM;
    const seed = options.seed ?? 12345;

    const stormSystem = rainfall.stormSystem;
    const grid = rainfall.grid;
    if (stormSystem.storms.length === 0 || running) {
      return null;
    }

    running = true;
    cancelled = false;

    // The storms as placed, to restore after every member and at the end.
    const snapshot = stormSystem.storms.map((storm) => ({ ...storm }));
    const nodeCount = streets.depths.length;
    const exceed = new Uint16Array(nodeCount);
    const sumMax = new Float32Array(nodeCount);
    const maxDepth = new Float32Array(nodeCount);
    const intensityAt = (lat, lng) => rainfall.intensityAt(lat, lng);
    const steps = Math.max(1, Math.ceil(durationS / stepS));
    let completed = 0;

    try {
      for (let m = 0; m < members && !cancelled; m += 1) {
        restore(stormSystem, snapshot);
        if (m > 0) {
          perturb(stormSystem.storms, mulberry32(seed + 1000 * m));
        }

        grid.reset();
        streets.reset();
        pipes?.reset();
        maxDepth.fill(0);

        for (let i = 0; i < steps; i += 1) {
          const elapsed = (i + 1) * stepS;
          if (seaLevelAt) {
            const level = seaLevelAt(elapsed);
            streets.setSeaLevel(level);
            pipes?.setSeaLevel(level);
          }
          stormSystem.advance(stepS);
          grid.step(stormSystem, stepS, { noiseAmplitude: config.rainNoiseAmplitude });
          streets.step(intensityAt, stepS);
          pipes?.step(stepS);

          const depths = streets.depths;
          for (let n = 0; n < nodeCount; n += 1) {
            if (depths[n] > maxDepth[n]) {
              maxDepth[n] = depths[n];
            }
          }
        }

        for (let n = 0; n < nodeCount; n += 1) {
          if (maxDepth[n] >= thresholdM) {
            exceed[n] += 1;
          }
          sumMax[n] += maxDepth[n];
        }

        completed += 1;
        onProgress?.(completed, members);
        // Let the page paint and the user cancel between members.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      restore(stormSystem, snapshot);
      grid.reset();
      streets.reset();
      pipes?.reset();
      running = false;
    }

    if (completed === 0) {
      return null;
    }

    const probability = new Float32Array(nodeCount);
    const meanMaxDepth = new Float32Array(nodeCount);
    let flooded = 0;
    for (let n = 0; n < nodeCount; n += 1) {
      probability[n] = exceed[n] / completed;
      meanMaxDepth[n] = sumMax[n] / completed;
      if (exceed[n] > 0) {
        flooded += 1;
      }
    }

    return { probability, meanMaxDepth, members: completed, thresholdM, floodedJunctions: flooded, durationS };
  }

  return {
    run,
    cancel() {
      cancelled = true;
    },
    get running() {
      return running;
    }
  };
}

/** Put every storm back exactly as it was snapshotted. */
function restore(stormSystem, snapshot) {
  // Storms may have expired and been dropped during a member; rebuild the
  // list rather than patching whatever is left.
  stormSystem.clear();
  for (const saved of snapshot) {
    const storm = stormSystem.add({});
    Object.assign(storm, saved);
  }
}

/**
 * Jitter each storm's track, speed, bearing, size and intensity by the
 * configured one-sigma amounts. Multiplicative jitters are floored so a
 * storm never rains backwards or shrinks to nothing.
 */
function perturb(storms, random) {
  const gauss = gaussian(random);
  for (const storm of storms) {
    storm.x += gauss() * config.ensembleTrackSigmaM;
    storm.y += gauss() * config.ensembleTrackSigmaM;

    const speed = Math.hypot(storm.velocityEastMs, storm.velocityNorthMs);
    const bearing = Math.atan2(storm.velocityEastMs, storm.velocityNorthMs);
    const newSpeed = Math.max(0, speed * (1 + gauss() * config.ensembleSpeedSigma));
    const newBearing = bearing + (gauss() * config.ensembleBearingSigmaDeg * Math.PI) / 180;
    storm.velocityEastMs = newSpeed * Math.sin(newBearing);
    storm.velocityNorthMs = newSpeed * Math.cos(newBearing);
    storm.headingDegrees = undefined;

    storm.maxIntensityMmPerHour *= Math.max(0.2, 1 + gauss() * config.ensembleIntensitySigma);
    const size = Math.max(0.3, 1 + gauss() * config.ensembleSizeSigma);
    storm.sigmaMeters *= size;
    storm.rainRadiusMeters *= size;
    storm.cloudRadiusMeters = Math.max(storm.cloudRadiusMeters * size, storm.rainRadiusMeters * 1.2);
  }
}

/** A small, fast, seedable random generator (32-bit state). */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples from a uniform generator (Box-Muller). */
function gaussian(random) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u;
    let v;
    let s;
    do {
      u = random() * 2 - 1;
      v = random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * factor;
    return u * factor;
  };
}
