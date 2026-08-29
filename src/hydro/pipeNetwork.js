// The underground drainage network, as a graph of junctions (manholes) joined
// by conduits (the surveyed drain runs), built by scripts/build-drainage-model.py.
//
//   streets ---- inlets: grated covers take water down, at a weir/orifice
//      ^                 rate, only while the manhole below has room
//      |
//      |  spill: a manhole filled above ground overflows back onto the street
//      |
//   [ junction storage ] --conduit-- [ junction storage ] --conduit-- outfall
//                                                                       |
//                                                     sea (tide level) or free
//                                              pump stations lift water out
//
// The state is a VOLUME per junction. From it comes the junction's water
// level (the hydraulic grade line, HGL); water moves through each conduit at
// Manning's rate for the depth in it, driven by the slope of the HGL between
// its two ends, in whichever direction that slope points. That single rule
// gives the behaviour a real network shows: a trunk running full backs water
// up its laterals, a drowned outfall stops draining and lets the sea in, and
// a manhole whose HGL reaches the street lid spills.
//
// Every substep is two-phase - transfers are proposed from the frozen state,
// scaled so no junction sends more than it holds, then landed together - the
// same scheme as the street model, so the two conserve mass between them.

import { config } from '../config.js';
import {
  createSection,
  equalisingVolume,
  manningFlow,
  pumpDischarge,
  sectionInto,
  sectionOf
} from './hydraulics.js';

const MODEL_URL = '/data/drainage-model.json';

export const NODE_MANHOLE = 0;
export const NODE_SEA_OUTFALL = 1;
export const NODE_FREE_OUTFALL = 2;
// Pump stations are a separate flag (nodes.pump), since one can sit on an
// outfall; this kind value is only honoured for models built before that.
export const NODE_PUMP = 3;

const BOUNDARY_LEN_M = 20; // the nominal conduit from an outfall to its receiving water
const FREE_DROP_M = 0.3; // a free outfall's receiving level sits this far below its invert
const MIN_HEAD = 1e-5;

export async function loadDrainageModel(url = MODEL_URL) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn('Drainage model unavailable:', error);
    return null;
  }
}

/**
 * @param model    the JSON from build-drainage-model.py
 * @param streets  { nodeCount, lat, lng, elev } of the street graph; ground
 *                 levels are re-read from its (despiked) heights so that a
 *                 manhole lid and the street over it agree
 * @param seaLevel optional () => metres MSL at the sea outfalls, read at every
 *                 step; without it the level set by setSeaLevel() stands
 * @param onSpill  (streetIndex, m3) => void, water surcharging onto a street
 */
export function createPipeNetwork({ model, streets, seaLevel = null, onSpill = null }) {
  const nodeCount = model.nodes.count;
  const conduitCount = model.conduits.count;
  const nodes = model.nodes;
  const conduits = model.conduits;

  // --- junctions ------------------------------------------------------------
  const lat = Float64Array.from(nodes.lat);
  const lng = Float64Array.from(nodes.lng);
  const kind = Uint8Array.from(nodes.kind);
  const isPump = nodes.pump
    ? Uint8Array.from(nodes.pump)
    : Uint8Array.from(nodes.kind, (k) => (k === NODE_PUMP ? 1 : 0));
  // Each pump's rated flow: the city plan's figure where the build found
  // one, else the configured default. 0 in this array means "use default",
  // read at step time so the setting can still be tried live.
  const pumpRated = new Float64Array(nodeCount);
  if (model.pumps?.node && model.pumps?.ratedM3s) {
    model.pumps.node.forEach((n, index) => {
      const rate = model.pumps.ratedM3s[index];
      if (Number.isFinite(rate) && rate > 0) {
        pumpRated[n] = rate;
      }
    });
  }
  const street = Int32Array.from(nodes.street);
  const shaftM2 = Float64Array.from(nodes.shaftM2);
  const ground = new Float64Array(nodeCount);
  const invert = new Float64Array(nodeCount);
  for (let n = 0; n < nodeCount; n += 1) {
    // Keep the surveyed burial depth, but sit it under the height the street
    // model actually uses, which despiking may have moved.
    const s = street[n];
    const shift = s >= 0 && streets?.elev ? streets.elev[s] - nodes.ground[n] : 0;
    ground[n] = nodes.ground[n] + shift;
    invert[n] = nodes.invert[n] + shift;
  }

  // --- conduits -------------------------------------------------------------
  const from = Int32Array.from(conduits.from);
  const to = Int32Array.from(conduits.to);
  const lengthM = Float64Array.from(conduits.lengthM);
  const shape = Uint8Array.from(conduits.shape);
  const widthM = Float64Array.from(conduits.widthM);
  const heightM = Float64Array.from(conduits.heightM);
  const manningN = Float64Array.from(conduits.manningN);
  const feature = Int32Array.from(conduits.feature);
  const fullAreaM2 = new Float64Array(conduitCount);
  let minLength = Infinity;
  for (let c = 0; c < conduitCount; c += 1) {
    fullAreaM2[c] = sectionOf(shape[c], widthM[c], heightM[c], heightM[c]).area;
    minLength = Math.min(minLength, lengthM[c]);
  }
  // The length the substep rule keeps the fastest water inside. Floored at
  // 20 m: shorter conduits are the joins the build could not merge, hold
  // next to nothing, and are protected by the transfer limiter anyway - and
  // the streets now step the drains inside their own 15 s substeps, where a
  // floor of 10 m asked for twice the substeps for no change in the answer.
  minLength = Math.max(20, Number.isFinite(minLength) ? minLength : 20);

  // --- stage-storage per junction --------------------------------------------
  //
  // Filling a junction from its invert to the crown of its pipes also fills
  // the half of each pipe nearest it, so below the crown the junction behaves
  // as a tank of plan area shaft + sum(half pipe volume / pipe height); above
  // the crown only the shaft fills (the network is SURCHARGED); at the lid it
  // spills.
  const crownDepth = new Float64Array(nodeCount); // invert -> crown
  const lowArea = new Float64Array(nodeCount); // plan area below the crown
  const largest = new Int32Array(nodeCount).fill(-1); // biggest incident conduit
  for (let c = 0; c < conduitCount; c += 1) {
    for (const n of [from[c], to[c]]) {
      crownDepth[n] = Math.max(crownDepth[n], heightM[c]);
      lowArea[n] += (0.5 * fullAreaM2[c] * lengthM[c]) / heightM[c];
      if (largest[n] < 0 || fullAreaM2[c] > fullAreaM2[largest[n]]) {
        largest[n] = c;
      }
    }
  }
  const lowVolume = new Float64Array(nodeCount); // volume at the crown
  const fullVolume = new Float64Array(nodeCount); // volume at the lid
  for (let n = 0; n < nodeCount; n += 1) {
    lowArea[n] += shaftM2[n];
    if (crownDepth[n] <= 0) {
      crownDepth[n] = 0.6;
    }
    lowVolume[n] = lowArea[n] * crownDepth[n];
    const lidDepth = Math.max(ground[n] - invert[n], crownDepth[n] + 0.1);
    fullVolume[n] = lowVolume[n] + shaftM2[n] * (lidDepth - crownDepth[n]);
  }

  // Which junctions are worth stepping: those holding water, the ones a
  // conduit could push water into, and every outfall (the sea can push water
  // IN through those). Most of the network is dry most of the time, and the
  // step is four passes over every junction and conduit per substep, up to
  // 30 substeps - so walking only the wet part is the difference between a
  // simulated day in half a minute and in a few seconds.
  const nodeAdjOffset = new Int32Array(nodeCount + 1);
  const nodeAdjConduit = new Int32Array(conduitCount * 2);
  const nodeAdjNode = new Int32Array(conduitCount * 2);
  {
    for (let c = 0; c < conduitCount; c += 1) {
      nodeAdjOffset[from[c] + 1] += 1;
      nodeAdjOffset[to[c] + 1] += 1;
    }
    for (let n = 0; n < nodeCount; n += 1) {
      nodeAdjOffset[n + 1] += nodeAdjOffset[n];
    }
    const cursor = nodeAdjOffset.slice(0, nodeCount);
    for (let c = 0; c < conduitCount; c += 1) {
      const a = from[c];
      const b = to[c];
      nodeAdjConduit[cursor[a]] = c;
      nodeAdjNode[cursor[a]] = b;
      cursor[a] += 1;
      nodeAdjConduit[cursor[b]] = c;
      nodeAdjNode[cursor[b]] = a;
      cursor[b] += 1;
    }
  }

  // One section record, rewritten per conduit: the step evaluates tens of
  // thousands of them and a fresh object each time is pure garbage.
  const section = createSection();

  const volM3 = new Float64Array(nodeCount);
  const head = new Float64Array(nodeCount); // water level, metres MSL
  const planArea = new Float64Array(nodeCount); // tank area at the current stage
  const proposedOut = new Float64Array(nodeCount);
  const outflowScale = new Float64Array(nodeCount);
  const delta = new Float64Array(nodeCount);
  const conduitFlow = new Float64Array(conduitCount); // proposed m3, + is from->to
  const conduitRate = new Float64Array(conduitCount); // m3/s over the last step
  const boundaryOut = new Float64Array(nodeCount); // this substep's proposed outfall discharge, m3
  const boundaryFlow = new Float64Array(nodeCount); // over the step: + out to sea/free, - in from the sea
  const pumpRunning = new Uint8Array(nodeCount);
  // What each station has lifted this run, for its marker's popup.
  const pumpedByNode = new Float64Array(nodeCount);
  const pumpNodes = model.pumps?.node ? Int32Array.from(model.pumps.node) : new Int32Array(0);

  let inflowM3 = 0;
  let dischargedM3 = 0;
  let backflowM3 = 0;
  let pumpedM3 = 0;
  let spilledM3 = 0;
  let spilledLostM3 = 0;
  let seaLevelM = -Infinity;

  function headOf(n) {
    const volume = volM3[n];
    if (volume <= lowVolume[n]) {
      return invert[n] + volume / lowArea[n];
    }
    return invert[n] + crownDepth[n] + (volume - lowVolume[n]) / shaftM2[n];
  }

  function refreshHeads() {
    for (let n = 0; n < nodeCount; n += 1) {
      head[n] = headOf(n);
      planArea[n] = volM3[n] <= lowVolume[n] ? lowArea[n] : shaftM2[n];
    }
  }

  // --- the active set ---------------------------------------------------
  const nodeActive = new Uint8Array(nodeCount);
  const wetSeen = new Uint8Array(nodeCount);
  const activeNodes = new Int32Array(nodeCount);
  const activeConduits = new Int32Array(Math.max(1, conduitCount));
  const conduitActive = new Uint8Array(Math.max(1, conduitCount));
  let activeCount = 0;
  let activeConduitCount = 0;

  function clearActive() {
    for (let i = 0; i < activeCount; i += 1) {
      const n = activeNodes[i];
      nodeActive[n] = 0;
      wetSeen[n] = 0;
    }
    for (let i = 0; i < activeConduitCount; i += 1) {
      conduitActive[activeConduits[i]] = 0;
    }
    activeCount = 0;
    activeConduitCount = 0;
  }

  function addNode(n) {
    if (nodeActive[n] === 0) {
      nodeActive[n] = 1;
      activeNodes[activeCount] = n;
      activeCount += 1;
    }
  }

  /** A junction with water (or an open outfall): its conduits matter. */
  function activate(n) {
    if (wetSeen[n] === 1) {
      return;
    }
    wetSeen[n] = 1;
    addNode(n);
    for (let k = nodeAdjOffset[n]; k < nodeAdjOffset[n + 1]; k += 1) {
      const c = nodeAdjConduit[k];
      if (conduitActive[c] === 0) {
        conduitActive[c] = 1;
        activeConduits[activeConduitCount] = c;
        activeConduitCount += 1;
      }
      addNode(nodeAdjNode[k]);
    }
  }

  /** Rebuild the active set from the water standing in the network now. */
  function collectActive() {
    clearActive();
    for (let n = 0; n < nodeCount; n += 1) {
      if (volM3[n] > 0) {
        activate(n);
      } else if (kind[n] === NODE_SEA_OUTFALL && seaLevelM > invert[n]) {
        // A drowned outfall lets the sea in even with nothing in the pipe.
        activate(n);
      } else if (isPump[n] === 1 && pumpRunning[n] === 1) {
        // A pump left running has to be told its sump is empty.
        activate(n);
      }
    }
  }

  // --- inlets ----------------------------------------------------------------
  const inlets = {
    count: model.inlets.count,
    node: Int32Array.from(model.inlets.node),
    street: Int32Array.from(model.inlets.street),
    perimeterM: Float64Array.from(model.inlets.perimeterM),
    openAreaM2: Float64Array.from(model.inlets.openAreaM2)
  };

  // Street junctions the inlets serve. Those ARE the drainage where they
  // exist, so the generic per-junction drain term stays only where they do
  // not - which is exactly the junctions with no inlet, not a radius around
  // the network that would leave some streets with no way down at all.
  const covered = streets ? new Uint8Array(streets.nodeCount) : null;
  if (covered) {
    for (let k = 0; k < inlets.count; k += 1) {
      covered[inlets.street[k]] = 1;
    }
  }

  // Pipe junctions bucketed for point queries (popup readouts).
  const NEAR_CELL_DEG = 0.001;
  const nearHash = new Map();
  for (let n = 0; n < nodeCount; n += 1) {
    const key = Math.floor(lat[n] / NEAR_CELL_DEG) * 200000 + Math.floor(lng[n] / NEAR_CELL_DEG);
    const bucket = nearHash.get(key);
    if (bucket) {
      bucket.push(n);
    } else {
      nearHash.set(key, [n]);
    }
  }

  refreshHeads();

  return {
    nodeCount,
    conduitCount,
    inlets,
    covered,
    kind,
    pumps: model.pumps,

    // This engine's whole state is a few typed arrays, so any moment can be
    // put back instantly and the timeline can scrub. An engine that has to
    // restart to rewind - SWMM, through a hotstart file - says false here,
    // and the UI stops offering free scrubbing. See hydro/drainage.js.
    instantRestore: true,

    stats: {
      nodes: nodeCount,
      conduits: conduitCount,
      inlets: inlets.count,
      pumps: countKind(isPump, 1),
      seaOutfalls: countKind(kind, NODE_SEA_OUTFALL),
      freeOutfalls: countKind(kind, NODE_FREE_OUTFALL),
      coveredStreets: covered ? countKind(covered, 1) : 0,
      capacityM3: Math.round(fullVolume.reduce((total, v) => total + v, 0))
    },

    reset() {
      clearActive();
      volM3.fill(0);
      conduitRate.fill(0);
      boundaryFlow.fill(0);
      pumpRunning.fill(0);
      pumpedByNode.fill(0);
      inflowM3 = 0;
      dischargedM3 = 0;
      backflowM3 = 0;
      pumpedM3 = 0;
      spilledM3 = 0;
      spilledLostM3 = 0;
      refreshHeads();
    },

    /** The state as a snapshot (volumes, pump states, counters), ~30 KB. */
    snapshot() {
      return {
        vol: Float32Array.from(volM3),
        pumps: Uint8Array.from(pumpRunning),
        pumped: Float64Array.from(pumpNodes, (n) => pumpedByNode[n]),
        totals: { inflowM3, dischargedM3, backflowM3, pumpedM3, spilledM3, spilledLostM3 }
      };
    },

    /** Put a snapshot back as the live state; flow rates read as zero. */
    restore(snap) {
      clearActive();
      volM3.set(snap.vol);
      pumpRunning.set(snap.pumps);
      pumpedByNode.fill(0);
      if (snap.pumped) {
        pumpNodes.forEach((n, i) => {
          pumpedByNode[n] = snap.pumped[i];
        });
      }
      ({ inflowM3, dischargedM3, backflowM3, pumpedM3, spilledM3, spilledLostM3 } = snap.totals);
      conduitRate.fill(0);
      boundaryFlow.fill(0);
      refreshHeads();
    },

    /** Sea level (metres MSL) the sea outfalls drain against. */
    setSeaLevel(metres) {
      seaLevelM = Number.isFinite(metres) ? metres : -Infinity;
    },

    get seaLevelM() {
      return seaLevelM;
    },

    /**
     * Put up to m3 into a junction; returns what fit. Room is measured to the
     * street lid, so a surcharged manhole refuses water and the inlet above
     * it stops draining - that is how a full network shows on the street.
     */
    offer(n, m3) {
      const room = fullVolume[n] - volM3[n];
      if (room <= 0 || !(m3 > 0)) {
        return 0;
      }
      const taken = m3 < room ? m3 : room;
      volM3[n] += taken;
      inflowM3 += taken;
      head[n] = headOf(n);
      return taken;
    },

    /** Water level at a junction, metres MSL. */
    headAt(n) {
      return headOf(n);
    },

    /** Advance by dt simulated seconds. */
    step(dtSeconds) {
      if (!(dtSeconds > 0)) {
        return;
      }

      const vMax = config.pipeFlowMaxMs;
      const substeps = Math.min(30, Math.max(1, Math.ceil((vMax * dtSeconds) / minLength)));
      const dtSub = dtSeconds / substeps;
      if (seaLevel) {
        const sea = seaLevel();
        seaLevelM = Number.isFinite(sea) ? sea : -Infinity;
      }
      const flap = config.outfallFlapValve;

      conduitRate.fill(0);
      boundaryFlow.fill(0);

      // Only the wet part of the network is stepped; everything below reads
      // and writes the active set alone.
      collectActive();
      if (activeCount === 0) {
        return;
      }

      for (let pass = 0; pass < substeps; pass += 1) {
        const stepped = activeCount;
        for (let i = 0; i < stepped; i += 1) {
          const n = activeNodes[i];
          head[n] = headOf(n);
          planArea[n] = volM3[n] <= lowVolume[n] ? lowArea[n] : shaftM2[n];
          proposedOut[n] = 0;
          boundaryOut[n] = 0;
          delta[n] = 0;
        }
        const steppedConduits = activeConduitCount;
        for (let i = 0; i < steppedConduits; i += 1) {
          conduitFlow[activeConduits[i]] = 0;
        }

        // Phase 1: propose a transfer through every conduit from the frozen
        // heads. The higher end sends; the depth of flow is the water above
        // the invert at that end, capped at the pipe height (a surcharged
        // pipe runs full, and the extra head only steepens the slope).
        for (let i = 0; i < steppedConduits; i += 1) {
          const c = activeConduits[i];
          const a = from[c];
          const b = to[c];
          let dh = head[a] - head[b];
          let src;
          let dst;
          if (dh > MIN_HEAD) {
            src = a;
            dst = b;
          } else if (dh < -MIN_HEAD) {
            src = b;
            dst = a;
            dh = -dh;
          } else {
            continue;
          }
          if (volM3[src] <= 0) {
            continue;
          }

          const depth = Math.min(head[src] - invert[src], heightM[c]);
          if (depth < 1e-3) {
            continue;
          }
          sectionInto(section, shape[c], widthM[c], heightM[c], depth);
          let flow = manningFlow(section.area, section.hydraulicRadius, dh / lengthM[c], manningN[c]);
          if (flow > vMax * section.area) {
            flow = vMax * section.area;
          }

          let transfer = flow * dtSub;
          // Never past a quarter of the way to level: a junction feeding
          // several pipes at once must not overshoot into ping-pong.
          const equalise = 0.25 * equalisingVolume(dh, planArea[src], planArea[dst]);
          if (transfer > equalise) {
            transfer = equalise;
          }
          if (transfer <= 0) {
            continue;
          }

          conduitFlow[c] = src === a ? transfer : -transfer;
          proposedOut[src] += transfer;
        }

        // Outfalls: a nominal conduit, the size of the biggest one arriving,
        // to the receiving water. Sea outfalls face the tide and flow either
        // way; free outfalls always find a lower level.
        for (let i = 0; i < stepped; i += 1) {
          const n = activeNodes[i];
          const k = kind[n];
          if (k !== NODE_SEA_OUTFALL && k !== NODE_FREE_OUTFALL) {
            continue;
          }
          const c = largest[n];
          if (c < 0) {
            continue;
          }

          const receiving =
            k === NODE_SEA_OUTFALL && seaLevelM > invert[n] - FREE_DROP_M ? seaLevelM : invert[n] - FREE_DROP_M;
          const dh = head[n] - receiving;

          if (dh > MIN_HEAD && volM3[n] > 0) {
            const depth = Math.min(head[n] - invert[n], heightM[c]);
            if (depth < 1e-3) {
              continue;
            }
            sectionInto(section, shape[c], widthM[c], heightM[c], depth);
            let flow = manningFlow(section.area, section.hydraulicRadius, dh / BOUNDARY_LEN_M, manningN[c]);
            if (flow > vMax * section.area) {
              flow = vMax * section.area;
            }
            const transfer = flow * dtSub;
            boundaryOut[n] = transfer;
            proposedOut[n] += transfer;
          } else if (dh < -MIN_HEAD && k === NODE_SEA_OUTFALL && !flap) {
            // The sea stands higher than the water in the outfall: it flows
            // in, through the same pipe, at the depth the sea covers it to.
            const depth = Math.min(seaLevelM - invert[n], heightM[c]);
            if (depth < 1e-3) {
              continue;
            }
            sectionInto(section, shape[c], widthM[c], heightM[c], depth);
            let flow = manningFlow(section.area, section.hydraulicRadius, -dh / BOUNDARY_LEN_M, manningN[c]);
            if (flow > vMax * section.area) {
              flow = vMax * section.area;
            }
            let transfer = flow * dtSub;
            const equalise = 0.25 * -dh * planArea[n];
            if (transfer > equalise) {
              transfer = equalise;
            }
            boundaryFlow[n] -= transfer;
            delta[n] += transfer;
            backflowM3 += transfer;
          }
        }

        // Phase 2: a junction may not send more than it holds.
        for (let i = 0; i < stepped; i += 1) {
          const n = activeNodes[i];
          const proposed = proposedOut[n];
          outflowScale[n] = proposed > volM3[n] && proposed > 0 ? volM3[n] / proposed : 1;
        }

        // Phase 3: land every transfer together.
        for (let i = 0; i < steppedConduits; i += 1) {
          const c = activeConduits[i];
          const flow = conduitFlow[c];
          if (flow === 0) {
            continue;
          }
          const src = flow > 0 ? from[c] : to[c];
          const dst = flow > 0 ? to[c] : from[c];
          const moved = (flow > 0 ? flow : -flow) * outflowScale[src];
          delta[src] -= moved;
          delta[dst] += moved;
          conduitRate[c] += flow > 0 ? moved : -moved;
        }
        for (let i = 0; i < stepped; i += 1) {
          const n = activeNodes[i];
          const out = boundaryOut[n];
          if (out > 0) {
            const moved = out * outflowScale[n];
            delta[n] -= moved;
            dischargedM3 += moved;
            boundaryFlow[n] += moved;
          }
        }

        // Phase 4: apply; pump; spill whatever stands above the lid.
        for (let i = 0; i < stepped; i += 1) {
          const n = activeNodes[i];
          let next = volM3[n] + delta[n];
          if (next < 0) {
            next = 0;
          }

          if (isPump[n] === 1) {
            // pumpDischarge's rule, inlined: it is called per pump per
            // substep and its result object is otherwise garbage.
            const depth = next / lowArea[n];
            const running =
              pumpRunning[n] === 1 ? depth > config.pumpStopDepthM : depth >= config.pumpStartDepthM;
            pumpRunning[n] = running ? 1 : 0;
            const rated = pumpRated[n] > 0 ? pumpRated[n] : config.pumpRatedM3s;
            if (running && rated > 0) {
              const lifted = Math.min(next, rated * dtSub);
              next -= lifted;
              pumpedM3 += lifted;
              pumpedByNode[n] += lifted;
            }
          }

          if (next > fullVolume[n]) {
            const excess = next - fullVolume[n];
            next = fullVolume[n];
            spilledM3 += excess;
            if (onSpill && street[n] >= 0) {
              onSpill(street[n], excess);
            } else {
              spilledLostM3 += excess;
            }
          }

          volM3[n] = next;
          // Newly wet: bring its conduits into the next substep.
          if (next > 0) {
            activate(n);
          }
        }
      }

      for (let i = 0; i < activeCount; i += 1) {
        const n = activeNodes[i];
        head[n] = headOf(n);
        planArea[n] = volM3[n] <= lowVolume[n] ? lowArea[n] : shaftM2[n];
      }
      for (let i = 0; i < activeConduitCount; i += 1) {
        conduitRate[activeConduits[i]] /= dtSeconds;
      }
    },

    /** Water balance in m3. */
    totals() {
      let stored = 0;
      let surcharged = 0;
      let pumpsOn = 0;
      for (let n = 0; n < nodeCount; n += 1) {
        stored += volM3[n];
        if (volM3[n] > lowVolume[n]) {
          surcharged += 1;
        }
        pumpsOn += pumpRunning[n];
      }
      return {
        storedM3: stored,
        inflowM3,
        dischargedM3,
        backflowM3,
        pumpedM3,
        spilledM3,
        spilledLostM3,
        surchargedNodes: surcharged,
        pumpsRunning: pumpsOn,
        seaLevelM
      };
    },

    /**
     * How full each surveyed drain run is, 0..1, indexed by its feature id in
     * drainage-pipes.geojson (NaN where a run became no conduit), for
     * recolouring the Drainage Pipes layer.
     */
    fillByFeature() {
      const fill = new Float32Array(model.featureCount).fill(NaN);
      for (let c = 0; c < conduitCount; c += 1) {
        const f = feature[c];
        const depth = Math.max(head[from[c]] - invert[from[c]], head[to[c]] - invert[to[c]]);
        const fraction = Math.min(1, Math.max(0, depth / heightM[c]));
        if (!(fill[f] >= fraction)) {
          fill[f] = fraction;
        }
      }
      return fill;
    },

    /** Flow through a conduit over the last step, m3/s (+ is from -> to). */
    conduitRateAt(c) {
      return conduitRate[c];
    },

    /**
     * The nearest junction within radiusM of a point, with its state, or
     * null. For the map's sample-point popup.
     */
    /** A pump station's live state, for its marker. */
    pumpState(n) {
      const rated = pumpRated[n] > 0 ? pumpRated[n] : config.pumpRatedM3s;
      return {
        running: pumpRunning[n] === 1,
        depthM: lowArea[n] > 0 ? volM3[n] / lowArea[n] : 0,
        ratedM3s: rated,
        pumpedM3: pumpedByNode[n],
        surcharged: volM3[n] > lowVolume[n]
      };
    },

    nearestNode(latQ, lngQ, radiusM = 60) {
      const cosLat = Math.cos((latQ * Math.PI) / 180);
      const cellLat = Math.floor(latQ / NEAR_CELL_DEG);
      const cellLng = Math.floor(lngQ / NEAR_CELL_DEG);
      const reach = Math.ceil(radiusM / (NEAR_CELL_DEG * 110574)) + 1;
      let best = -1;
      let bestDistance = radiusM;
      for (let ci = cellLat - reach; ci <= cellLat + reach; ci += 1) {
        for (let cj = cellLng - reach; cj <= cellLng + reach; cj += 1) {
          const bucket = nearHash.get(ci * 200000 + cj);
          if (!bucket) {
            continue;
          }
          for (const n of bucket) {
            const dy = (lat[n] - latQ) * 110574;
            const dx = (lng[n] - lngQ) * 111320 * cosLat;
            const distance = Math.hypot(dx, dy);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = n;
            }
          }
        }
      }
      if (best < 0) {
        return null;
      }
      const c = largest[best];
      const level = headOf(best);
      return {
        node: best,
        distanceM: bestDistance,
        kind: kind[best],
        headM: level,
        invertM: invert[best],
        groundM: ground[best],
        depthM: Math.max(0, level - invert[best]),
        fill: c >= 0 ? Math.min(1, Math.max(0, level - invert[best]) / heightM[c]) : 0,
        surcharged: volM3[best] > lowVolume[best],
        sizeText: c < 0 ? null : shape[c] === 1 ? `${widthM[c]}×${heightM[c]} m box` : `Ø${widthM[c]} m`,
        pump: isPump[best] === 1,
        pumpRunning: pumpRunning[best] === 1,
        pumpRatedM3s: isPump[best] === 1 ? (pumpRated[best] > 0 ? pumpRated[best] : config.pumpRatedM3s) : 0
      };
    }
  };
}

function countKind(values, wanted) {
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === wanted) {
      count += 1;
    }
  }
  return count;
}
