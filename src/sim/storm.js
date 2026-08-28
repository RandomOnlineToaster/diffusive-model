// Storm system: the rainfall source, independent of terrain and hydraulics.
//
//   Storm System  ->  Rainfall Grid  ->  Terrain / Water Grid
//
// Nothing here knows about Leaflet, the DEM, or the map. It answers one
// question: at a point on the ground, how hard is it raining right now?
//
// All internal units are SI: metres, seconds, m/s. Intensity is carried in
// mm/hour because that is how rainfall is quoted; conversion to a depth for a
// timestep happens in rainfallGrid.js.

// Every cell uses the same Gaussian, so only distance changes between cells:
//
//   I(d) = Imax * exp(-d^2 / (2 * sigma^2))     for d < rainRadius
//   I(d) = 0                                    for d >= rainRadius
//
// sigma sets how quickly rain falls off from the centre; rainRadius gives the
// storm a finite edge so the exponential tail does not drizzle over the whole
// province.
export const STORM_DEFAULTS = {
  maxIntensityMmPerHour: 100,
  sigmaMeters: 1000,
  rainRadiusMeters: 3000,
  // The cloud is deliberately larger than the rain area: being under cloud does
  // not mean rain is reaching the ground.
  cloudRadiusMeters: 5000,
  velocityEastMs: 0,
  velocityNorthMs: 0,
  lifetimeSeconds: Infinity
};

let nextStormId = 1;

export function createStorm(options = {}) {
  return {
    id: `storm-${nextStormId++}`,
    // Position in local metres, east/north of the grid origin.
    x: 0,
    y: 0,
    ageSeconds: 0,
    ...STORM_DEFAULTS,
    ...options
  };
}

export function createStormSystem() {
  const storms = [];

  return {
    get storms() {
      return storms;
    },

    add(options) {
      const storm = createStorm(options);
      storms.push(storm);
      return storm;
    },

    remove(id) {
      const index = storms.findIndex((storm) => storm.id === id);
      if (index >= 0) {
        storms.splice(index, 1);
      }
    },

    clear() {
      storms.length = 0;
    },

    /** Advance every storm by dt seconds, dropping any that have expired. */
    advance(dtSeconds) {
      for (let index = storms.length - 1; index >= 0; index -= 1) {
        const storm = storms[index];
        storm.x += storm.velocityEastMs * dtSeconds;
        storm.y += storm.velocityNorthMs * dtSeconds;
        storm.ageSeconds += dtSeconds;

        if (storm.ageSeconds >= storm.lifetimeSeconds) {
          storms.splice(index, 1);
        }
      }
    },

    /**
     * Rainfall intensity in mm/hour at a point, summed over every active storm.
     * Overlapping cells add, which is what lets two storm cells reinforce.
     */
    intensityAt(x, y) {
      let total = 0;

      for (const storm of storms) {
        total += stormIntensityAt(storm, x, y);
      }

      return total;
    },

    /** True when the point lies under any storm's cloud, rain or not. */
    isUnderCloud(x, y) {
      return storms.some((storm) => {
        const dx = x - storm.x;
        const dy = y - storm.y;
        return dx * dx + dy * dy < storm.cloudRadiusMeters * storm.cloudRadiusMeters;
      });
    }
  };
}

export function stormIntensityAt(storm, x, y) {
  const dx = x - storm.x;
  const dy = y - storm.y;
  const distanceSquared = dx * dx + dy * dy;

  if (distanceSquared >= storm.rainRadiusMeters * storm.rainRadiusMeters) {
    return 0;
  }

  return (
    storm.maxIntensityMmPerHour *
    Math.exp(-distanceSquared / (2 * storm.sigmaMeters * storm.sigmaMeters))
  );
}

export function distanceToStorm(storm, x, y) {
  return Math.hypot(x - storm.x, y - storm.y);
}
