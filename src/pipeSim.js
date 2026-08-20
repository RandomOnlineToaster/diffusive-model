// Underground pipe simulation: the drainage side of the street water model.
//
//   streets (rain, surface routing)
//        |  inlets: junctions near a pipe hand water down
//        v
//   [ pipe network: finite capacity, finite velocity ]
//        |
//        v  outfall at each route's end
//
// Pipes are subdivided into ~50 m nodes. Each node holds a volume of water,
// bounded by capacity = shapeFactor x boreHeight^2 x nodeLength (the database
// records bore height but not cross-section, so the area is an assumption the
// shape factor makes explicit). Water moves node-to-node at a fixed velocity
// and leaves the system at the route's last node.
//
// The interesting failure mode falls out naturally: when a node is full,
// offer() refuses water, the street above stops draining, and the surface
// model shows it backing up.

import { config } from './config.js';

const NODE_SPACING_M = 50;
const METERS_PER_DEGREE_LAT = 110574;

export function createPipeSimulation({ features, streets }) {
  // --- build pipe nodes, route by route, in flow order ----------------------
  const byRoute = new Map();
  for (const feature of features) {
    const routeId = feature.properties.routeId;
    if (!byRoute.has(routeId)) {
      byRoute.set(routeId, []);
    }
    byRoute.get(routeId).push(feature);
  }

  const lat = [];
  const lng = [];
  const capacity = [];
  const downstream = [];
  const segmentOf = [];

  for (const segments of byRoute.values()) {
    segments.sort((a, b) => a.properties.segmentIndex - b.properties.segmentIndex);
    const routeStart = lat.length;

    for (const feature of segments) {
      const { startHeightRef, endHeightRef, routeStationId } = feature.properties;
      const bore =
        ((startHeightRef > 0 ? startHeightRef : 1.5) + (endHeightRef > 0 ? endHeightRef : 1.5)) / 2;
      const areaM2 = config.pipeShapeFactor * bore * bore;

      const coords = feature.geometry.coordinates;
      for (let leg = 0; leg < coords.length - 1; leg += 1) {
        const [lngA, latA] = coords[leg];
        const [lngB, latB] = coords[leg + 1];
        const midLat = ((latA + latB) / 2) * (Math.PI / 180);
        const legLen = Math.hypot(
          (latB - latA) * METERS_PER_DEGREE_LAT,
          (lngB - lngA) * 111320 * Math.cos(midLat)
        );
        const pieces = Math.max(1, Math.round(legLen / NODE_SPACING_M));

        for (let piece = 0; piece < pieces; piece += 1) {
          const t = piece / pieces;
          lat.push(latA + (latB - latA) * t);
          lng.push(lngA + (lngB - lngA) * t);
          capacity.push(areaM2 * (legLen / pieces));
          segmentOf.push(routeStationId);
          downstream.push(lat.length); // provisional: next node
        }
      }
    }

    // Last node of the route is the outfall: water there leaves the system.
    if (lat.length > routeStart) {
      downstream[lat.length - 1] = -1;
    }
  }

  const nodeCount = lat.length;
  const water = new Float64Array(nodeCount);
  const inflowBuffer = new Float64Array(nodeCount);
  let dischargedM3 = 0;

  // --- map street junctions to their nearest pipe node ----------------------
  // Spatial hash so 266k street nodes x pipe nodes stays O(N).
  const radius = config.pipeInletRadiusM;
  const cellDeg = radius / METERS_PER_DEGREE_LAT;
  const hash = new Map();
  const keyOf = (la, ln) => `${Math.floor(la / cellDeg)}:${Math.floor(ln / cellDeg)}`;

  for (let p = 0; p < nodeCount; p += 1) {
    const key = keyOf(lat[p], lng[p]);
    if (!hash.has(key)) {
      hash.set(key, []);
    }
    hash.get(key).push(p);
  }

  const inletNode = new Int32Array(streets.nodeCount).fill(-1);
  let inletCount = 0;
  const radiusSq = radius * radius;

  for (let n = 0; n < streets.nodeCount; n += 1) {
    const la = streets.lat[n];
    const ln = streets.lng[n];
    const baseLa = Math.floor(la / cellDeg);
    const baseLn = Math.floor(ln / cellDeg);
    let best = -1;
    let bestDistSq = radiusSq;

    for (let dLa = -1; dLa <= 1; dLa += 1) {
      for (let dLn = -1; dLn <= 1; dLn += 1) {
        const bucket = hash.get(`${baseLa + dLa}:${baseLn + dLn}`);
        if (!bucket) {
          continue;
        }

        for (const p of bucket) {
          const midLat = la * (Math.PI / 180);
          const dy = (lat[p] - la) * METERS_PER_DEGREE_LAT;
          const dx = (lng[p] - ln) * 111320 * Math.cos(midLat);
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = p;
          }
        }
      }
    }

    if (best >= 0) {
      inletNode[n] = best;
      inletCount += 1;
    }
  }

  return {
    inletNode,

    stats: {
      pipeNodes: nodeCount,
      inletCount,
      capacityM3: Math.round(capacity.reduce((total, c) => total + c, 0))
    },

    /** Try to put m3 into a pipe node; returns how much actually fit. */
    offer(pipeIndex, volumeM3) {
      const free = capacity[pipeIndex] - water[pipeIndex];
      if (free <= 0) {
        return 0;
      }

      const taken = volumeM3 < free ? volumeM3 : free;
      water[pipeIndex] += taken;
      return taken;
    },

    /** Move pipe water downstream; the route's last node discharges out. */
    step(dtSeconds) {
      if (dtSeconds <= 0) {
        return;
      }

      const velocity = config.pipeFlowVelocityMs;
      const substeps = Math.min(6, Math.max(1, Math.ceil((velocity * dtSeconds) / NODE_SPACING_M)));
      const dtSub = dtSeconds / substeps;

      for (let pass = 0; pass < substeps; pass += 1) {
        inflowBuffer.fill(0);

        for (let p = 0; p < nodeCount; p += 1) {
          const amount = water[p];
          if (amount <= 0) {
            continue;
          }

          let fraction = (velocity * dtSub) / NODE_SPACING_M;
          if (fraction > 1) {
            fraction = 1;
          }

          const moved = amount * fraction;
          const target = downstream[p];
          water[p] = amount - moved;

          if (target >= 0) {
            inflowBuffer[target] += moved;
          } else {
            dischargedM3 += moved;
          }
        }

        for (let p = 0; p < nodeCount; p += 1) {
          // Inflow may exceed capacity when an upstream surge arrives; the
          // excess stays in the upstream-most full node by pushing it back.
          const total = water[p] + inflowBuffer[p];
          if (total <= capacity[p]) {
            water[p] = total;
          } else {
            water[p] = capacity[p];
            const previous = p > 0 && downstream[p - 1] === p ? p - 1 : -1;
            if (previous >= 0) {
              water[previous] += total - capacity[p];
            }
          }
        }
      }
    },

    /** Worst fill fraction per segment: the choke point indicator. */
    fillBySegment() {
      const fills = new Map();
      for (let p = 0; p < nodeCount; p += 1) {
        const fraction = capacity[p] > 0 ? water[p] / capacity[p] : 0;
        const segment = segmentOf[p];
        if (fraction > (fills.get(segment) || 0)) {
          fills.set(segment, fraction);
        }
      }
      return fills;
    },

    totalWaterM3() {
      let total = 0;
      for (let p = 0; p < nodeCount; p += 1) {
        total += water[p];
      }
      return total;
    },

    get dischargedM3() {
      return dischargedM3;
    },

    reset() {
      water.fill(0);
      dischargedM3 = 0;
    }
  };
}
