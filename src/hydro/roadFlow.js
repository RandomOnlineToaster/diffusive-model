import L from 'leaflet';
import { config } from '../config.js';
import {
  ACCUMULATION_COLORS,
  accumulationClassifier,
  addLinesByClass,
  flowLineRenderer
} from '../terrain/flow.js';
import { createChainParticleLayer } from '../terrain/flowParticles.js';
import {
  GRAVITY,
  INLET_ORIFICE_COEFFICIENT as INLET_ORIFICE,
  INLET_WEIR_COEFFICIENT as INLET_WEIR
} from './hydraulics.js';
import { createMinHeap } from '../terrain/terrain.js';

// High-detail flow paths routed along the street network.
//
// The DEM analysis grid is ~200 m per cell, which cannot see a road at all. In a
// built-up area the streets are what actually carry surface water, so this
// routes on a graph of street junctions instead of a raster: every junction
// drains to its lowest connected neighbour, exactly like D8 but on edges that
// follow real kerb lines. Junction heights come from the full 30 m DEM, sampled
// at build time by scripts/build-road-network.py.

const NETWORK_URL = '/data/chonburi-road-network.json';

export async function createRoadFlowLayer({ minUpstream } = {}) {
  const threshold = minUpstream ?? config.roadFlowMinUpstream;
  const data = await loadNetwork();

  if (!data) {
    return { layer: L.layerGroup([]), label: 'Street Flow (no data)' };
  }

  const { lat, lng, edges } = data;
  const nodeCount = data.nodeCount;
  // COP30 is a SURFACE model: building edges bleed into the sampled street
  // heights, leaving lone spikes and pits of up to a couple of metres. The
  // router works on sink-filled heights and never noticed, but the dynamic
  // water model reads the ground directly and faithfully ponded in every
  // fake pit - one junction 80 cm deep beside neighbours barely wet.
  const elev = Float64Array.from(data.elev);
  const despiked = despikeElevations(nodeCount, elev, edges, lat, lng);
  const { downstream, accumulation, sinks, filledSinks } = routeDownhill(
    nodeCount,
    elev,
    edges,
    lat,
    lng
  );

  // Marching dashes were retired here. Re-dashing an animated stroke every
  // frame is raster work in proportion to the geometry on screen - measured
  // on this map it holds 60 fps to roughly 700 drawn vertices - and this
  // network is thousands of chains at every useful zoom (~3,700 dry, up to
  // ~18,000 under a wide storm). So the chains draw solid on one canvas, and
  // direction comes from stream particles riding the chains downstream: the
  // same trail recipe as the Flow Direction layer, whose cost is set by the
  // particle count rather than by the size of the network.
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const streams =
    config.flowPathAnimate && !reducedMotion
      ? createChainParticleLayer({ isDark: (name) => name === 'Satellite' })
      : null;
  const group = L.layerGroup();
  if (streams) {
    group.addLayer(streams);
  }
  let lineCount = 0;

  // Drop the drawn chains but keep the stream layer: removing it too would
  // tear down and rebuild its canvas on every storm refresh.
  function clearChains() {
    const stale = [];
    group.eachLayer((layer) => {
      if (layer !== streams) {
        stale.push(layer);
      }
    });
    for (const layer of stale) {
      group.removeLayer(layer);
    }
  }

  function rebuild(
    values,
    minValue,
    tooltipFor,
    classOfOverride = null,
    aux = null,
    // The terrain's steepest-descent pointers by default; the live water
    // model passes its own, so chains follow where the water is going NOW.
    downstreamOverride = null
  ) {
    clearChains();
    const classOf = classOfOverride || accumulationClassifier(minValue, maxOf(values));
    const lines = chainByClass(
      nodeCount,
      downstreamOverride || downstream,
      values,
      classOf,
      minValue,
      lat,
      lng,
      aux
    );
    lineCount = lines.length;

    addLinesByClass(group, lines, {
      // The one shared flow-line canvas: a second canvas stacked on top
      // would swallow the other flow layer's hovers (see flow.js).
      renderer: flowLineRenderer(),
      className: 'flow-path',
      weightFor: (colorClass) => 1.2 + colorClass * 0.6,
      describe: (line) => tooltipFor(line.value, line.aux),
      // With the particle layer running it IS the layer - trails, or the
      // classic dashes - as it is for Flow Direction; the lines stay only as
      // hover targets. Without it (animation off, reduced motion) the solid
      // colour-classed lines are drawn instead.
      drawn: !streams
    });

    // Chains run upstream -> downstream, so the streams flow downhill.
    streams?.setLines(lines);
  }

  const uniformTooltip = (value) =>
    `Street flow<br>${Math.round(value).toLocaleString()} junctions upstream`;

  // The terrain baseline: where water would go given the shape of the streets
  // alone. This is the layer's view whenever the rainfall simulator is off.
  function showUniform() {
    rebuild(accumulation, threshold, uniformTooltip);
  }

  // --- dynamic water: shallow-water routing on the street graph --------------
  //
  // The steady-state pass above answers "where would water end up"; it has no
  // notion of time or of how full a street already is. This model keeps water
  // DEPTH in metres as per-junction state and moves it along street edges by
  // the slope of the WATER SURFACE (ground + depth), never the ground alone:
  //
  //   depth[n] += rain * catchment factor       (the street collects its
  //                                               neighbourhood's runoff)
  //   head      = surface[src] - surface[tgt]   (backwater-aware gradient)
  //   v         = (1/n) * depth^(2/3) * sqrt(head / dist)     (Manning)
  //
  // and water LEAVES a junction four ways:
  //
  //   inlets     a grated cover takes it down at a weir/orifice rate, into
  //              the pipe network - while the manhole below has room
  //   soakage    the pervious share of the wet ground infiltrates it, on
  //              Horton's curve (fast at first, slower as it saturates)
  //   outfalls   a dead end of the street graph discharges it: freely off the
  //              map's edge, or against the TIDE where it meets the sea -
  //              and at high water the sea comes the other way
  //   drain term outside the surveyed drain network, where no inlet is
  //              known, a generic capacity stands in for all of the above
  //
  // Because flow follows the water surface, a flooded downstream junction
  // first slows, then stops, then reverses its inflow: blockage propagates
  // upstream (the A -> B -> C backwater case), and pits fill until the water
  // finds its own way over. Every substep is two-phase - all transfers are
  // proposed from the state at time t, scaled so no junction sends more than
  // it holds, then landed at once - so the result is order-independent and
  // mass is conserved to the outfalls, drains and pipes.
  function createDynamicWater() {
    // State is VOLUME per junction (m3), not depth. Depth follows from a
    // two-stage storage curve: up to curb height the water stands on the
    // street patch alone; past the curb it spreads over the junction's whole
    // catchment strip, the way a real flood leaves the kerb line and fills
    // yards and side streets. Without this, every catchment's runoff was
    // piled onto the 120 m2 street patch, and a heavy storm read as a solid
    // red disc under the cloud instead of flooding the low ground first.
    const volM3 = new Float64Array(nodeCount);
    const depthCache = new Float64Array(nodeCount); // m, derived from volM3
    const delta = new Float64Array(nodeCount); // two-phase update buffer, m3
    const proposedOut = new Float64Array(nodeCount);
    const outflowScale = new Float64Array(nodeCount);
    const terminalQ = new Float64Array(nodeCount);
    const seaInflow = new Float64Array(nodeCount); // m3 the sea pushes onto a drowned outfall
    const flowM3 = new Float64Array(nodeCount); // m3/s through, for tooltips
    // When each junction last became wet, in simulated seconds (-1 = dry):
    // Horton's infiltration curve runs from that moment. Drying resets it,
    // which lets the ground recover instantly - a simplification.
    const wetSince = new Float32Array(nodeCount).fill(-1);
    let simSeconds = 0;

    // The ground one junction stands for. Where the city survey gave the
    // carriageway a width this is that width times the junction's share of
    // its streets; elsewhere it falls back to the configured patch. It used
    // to be one number for all 266k junctions, which made a 19 m boulevard
    // hold water as deep as a 2 m lane.
    const PATCH_M2 = config.streetPatchAreaM2;
    const patchM2 = new Float64Array(nodeCount);
    const curbVolM3 = new Float64Array(nodeCount);
    const CURB_M = config.streetCurbDepthM;

    // Water below this is a film, not flow; below the snap volume it is gone.
    const MIN_FLOW_DEPTH = 5e-4;
    const SNAP_DRY_M3 = 1e-4 * PATCH_M2;
    const OUTFALL_LEN = 20;
    const MIN_SLOPE = 0.0005;
    // A sea outfall at low tide discharges as if the water stood this far
    // below it; the tide replaces that once it rises above.
    const OUTFALL_DROP_M = 0.5;

    // Horton's curve in SI: mm/h -> m/s, per hour -> per second.
    const infiltration = {
      f0: config.infiltrationF0MmPerHour / 3.6e6,
      fc: config.infiltrationFcMmPerHour / 3.6e6,
      k: config.infiltrationDecayPerHour / 3600
    };

    // Sea level the coastal dead ends drain against, metres MSL. -Infinity
    // is "no sea": every dead end discharges freely, as before.
    let seaLevelM = -Infinity;
    // Which dead ends meet the sea: the low ones. (Height is the only clue
    // the street graph carries; the pipe network knows its outfalls by
    // distance to the coast.)
    // Which dead ends meet the sea: the low ones ON THE SHORE. Height alone
    // was enough while COP30 stood every street metres too high, but with
    // the surveyed heights plenty of streets a kilometre inland sit under a
    // metre and a half, and the tide has no business reaching them - so the
    // build marks which junctions are near the zero-metre contour.
    const coastal = data.coastal;
    const seaOutfall = new Uint8Array(nodeCount);
    let seaOutfallCount = 0;
    for (let n = 0; n < nodeCount; n += 1) {
      const onShore = coastal ? coastal[n] === 1 : true;
      if (downstream[n] < 0 && onShore && elev[n] <= config.seaOutfallMaxElevM) {
        seaOutfall[n] = 1;
        seaOutfallCount += 1;
      }
    }

    // Edge geometry (length in metres), each junction's rain multiplier, and
    // the plain it floods onto past the curb. Half of every incident edge
    // belongs to the junction, so dense areas do not double-count.
    const edgeCount = edges.length / 2;
    const edgeDist = new Float32Array(edgeCount);
    const edgeFlow = new Float64Array(edgeCount); // proposed transfer m3, + is a->b
    const runoffFactor = new Float32Array(nodeCount);
    const floodAreaM2 = new Float32Array(nodeCount);
    {
      const halfLen = new Float32Array(nodeCount);
      for (let e = 0; e < edgeCount; e += 1) {
        const a = edges[2 * e];
        const b = edges[2 * e + 1];
        const midLat = ((lat[a] + lat[b]) / 2) * (Math.PI / 180);
        const dy = (lat[b] - lat[a]) * 110574;
        const dx = (lng[b] - lng[a]) * 111320 * Math.cos(midLat);
        const length = Math.hypot(dx, dy);
        edgeDist[e] = length > 3 ? length : 3;
        halfLen[a] += length / 2;
        halfLen[b] += length / 2;
      }

      const widths = data.width;
      for (let n = 0; n < nodeCount; n += 1) {
        // The street this junction owns: its surveyed width over half of
        // every street running into it. Without a width, the configured
        // patch stands in.
        const width = widths ? widths[n] : 0;
        const own = width > 0 && halfLen[n] > 0 ? width * halfLen[n] : PATCH_M2;
        patchM2[n] = own;
        curbVolM3[n] = own * CURB_M;

        const catchmentM2 = halfLen[n] * config.streetCatchmentWidthM;
        const factor = (config.streetRunoffCoeff * catchmentM2) / own;
        // Never less than the rain landing on the street itself.
        runoffFactor[n] = factor > 1 ? factor : 1;
        floodAreaM2[n] = catchmentM2 > own ? catchmentM2 : own;
      }
    }

    // Adjacency with edge ids, so a junction's live outflow can be read off
    // the per-edge transfers: which neighbour the water is actually heading
    // to this step, as opposed to the terrain's steepest descent.
    const adjOffset = new Int32Array(nodeCount + 1);
    const adjNode = new Int32Array(edgeCount * 2);
    const adjEdge = new Int32Array(edgeCount * 2);
    {
      for (let e = 0; e < edgeCount; e += 1) {
        adjOffset[edges[2 * e] + 1] += 1;
        adjOffset[edges[2 * e + 1] + 1] += 1;
      }
      for (let n = 0; n < nodeCount; n += 1) {
        adjOffset[n + 1] += adjOffset[n];
      }
      const cursor = adjOffset.slice(0, nodeCount);
      for (let e = 0; e < edgeCount; e += 1) {
        const a = edges[2 * e];
        const b = edges[2 * e + 1];
        adjNode[cursor[a]] = b;
        adjEdge[cursor[a]] = e;
        cursor[a] += 1;
        adjNode[cursor[b]] = a;
        adjEdge[cursor[b]] = e;
        cursor[b] += 1;
      }
    }
    const edgeRate = new Float64Array(edgeCount); // m3/s over the last step, + is a->b
    const liveDown = new Int32Array(nodeCount).fill(-1);

    // --- the rain lookup -------------------------------------------------
    // Asking the rain grid for every junction's intensity by lat/lng meant
    // 266k closure calls a step, each projecting a coordinate and allocating
    // an object. Which grid cell a junction sits in never changes, so it is
    // resolved once (setRainField) and the step reads the intensity field
    // straight out of the array. The callback stays as the fallback.
    let rainField = null;
    let rainCells = null;

    // --- the active set ---------------------------------------------------
    // Only junctions holding water, and the ones they can reach this
    // substep, are stepped. Most of a 266k-junction network is dry most of
    // the time, and walking all of it four times per substep is what made a
    // simulated day take half a minute.
    const nodeActive = new Uint8Array(nodeCount);
    const wetSeen = new Uint8Array(nodeCount);
    const activeNodes = new Int32Array(nodeCount);
    const activeEdges = new Int32Array(edgeCount);
    const edgeActive = new Uint8Array(edgeCount);
    let activeCount = 0;
    let activeEdgeCount = 0;

    /** Drop the active set, clearing what only it may have written. */
    function clearActive() {
      for (let i = 0; i < activeCount; i += 1) {
        const n = activeNodes[i];
        nodeActive[n] = 0;
        wetSeen[n] = 0;
        flowM3[n] = 0;
      }
      for (let i = 0; i < activeEdgeCount; i += 1) {
        const e = activeEdges[i];
        edgeActive[e] = 0;
        edgeRate[e] = 0;
      }
      activeCount = 0;
      activeEdgeCount = 0;
    }

    /** A junction that may receive water: stepped, but sends nothing yet. */
    function addNode(n) {
      if (nodeActive[n] === 0) {
        nodeActive[n] = 1;
        activeNodes[activeCount] = n;
        activeCount += 1;
      }
    }

    /** A junction holding water: it, its links and its neighbours all matter. */
    function activate(n) {
      if (wetSeen[n] === 1) {
        return;
      }
      wetSeen[n] = 1;
      addNode(n);
      for (let k = adjOffset[n]; k < adjOffset[n + 1]; k += 1) {
        const e = adjEdge[k];
        if (edgeActive[e] === 0) {
          edgeActive[e] = 1;
          activeEdges[activeEdgeCount] = e;
          activeEdgeCount += 1;
        }
        addNode(adjNode[k]);
      }
    }
    // Set by restore(): the live directions came from a snapshot, not from
    // edgeRate (which a restored state does not have), so render() must not
    // recompute them until the model has been stepped again.
    let liveDownFrozen = false;

    // Where each wet junction's water is going right now: the neighbour it
    // sent the most to over the last step, or -1 when it stood still.
    function refreshLiveDownstream(minDepth) {
      for (let n = 0; n < nodeCount; n += 1) {
        liveDown[n] = -1;
        if (depthCache[n] < minDepth) {
          continue;
        }
        let best = 0;
        for (let k = adjOffset[n]; k < adjOffset[n + 1]; k += 1) {
          const e = adjEdge[k];
          const out = edges[2 * e] === n ? edgeRate[e] : -edgeRate[e];
          if (out > best) {
            best = out;
            liveDown[n] = adjNode[k];
          }
        }
      }
    }

    // The stage-storage curve, volume -> standing depth.
    function depthOf(volume, n) {
      return volume <= curbVolM3[n]
        ? volume / patchM2[n]
        : CURB_M + (volume - curbVolM3[n]) / floodAreaM2[n];
    }

    // Flood severity is the DEPTH standing on the street, on fixed stops in
    // metres, so a colour means the same thing at every moment. Water passing
    // through quickly stays green; water piling up goes red.
    const stops = config.streetFloodDepthsM;
    const classOf = (value) => {
      let cls = 0;
      for (let index = 1; index < stops.length; index += 1) {
        if (value >= stops[index]) {
          cls = index;
        }
      }
      return cls;
    };
    const SEVERITY = ['light', 'light', 'moderate', 'severe', 'very severe'];

    let peak = 0;
    let pipes = null;
    let rainedM3 = 0;
    let drainedM3 = 0; // the generic drain term, outside the surveyed network
    let infiltratedM3 = 0;
    let capturedM3 = 0; // taken down the inlets into the pipes
    let dischargedM3 = 0; // out through the street outfalls
    let backflowM3 = 0; // in from the sea through drowned outfalls
    let spilledInM3 = 0; // surcharged out of manholes onto the streets
    let driedFilmM3 = 0; // the last damp film snapped to dry, so the balance closes

    // Junctions bucketed by ~100 m cells for point queries; built on the
    // first lookup rather than at load, since most sessions never click.
    const NEAR_CELL_DEG = 0.001;
    let nearHash = null;
    function buildNearHash() {
      nearHash = new Map();
      for (let n = 0; n < nodeCount; n += 1) {
        const key =
          Math.floor(lat[n] / NEAR_CELL_DEG) * 200000 + Math.floor(lng[n] / NEAR_CELL_DEG);
        const bucket = nearHash.get(key);
        if (bucket) {
          bucket.push(n);
        } else {
          nearHash.set(key, [n]);
        }
      }
    }

    // Recompute standing depths (and the peak) from the volumes.
    function refreshDepths() {
      peak = 0;
      for (let n = 0; n < nodeCount; n += 1) {
        const volume = volM3[n];
        const value = volume > 0 ? depthOf(volume, n) : 0;
        depthCache[n] = value;
        if (value > peak) {
          peak = value;
        }
      }
    }

    return {
      /** Each junction's catchment multiplier on the rain landing on it. */
      runoffFactor,

      reset() {
        clearActive();
        volM3.fill(0);
        depthCache.fill(0);
        flowM3.fill(0);
        edgeRate.fill(0);
        wetSince.fill(-1);
        simSeconds = 0;
        peak = 0;
        rainedM3 = 0;
        drainedM3 = 0;
        infiltratedM3 = 0;
        capturedM3 = 0;
        dischargedM3 = 0;
        backflowM3 = 0;
        spilledInM3 = 0;
        driedFilmM3 = 0;
      },

      /**
       * Couple the street model to the underground drainage (pipeNetwork.js).
       * Its inlets become the only way down for the streets it covers, so a
       * surcharged network visibly backs the street up; outside its reach
       * the generic drain term stays.
       */
      attachPipes(pipeNetwork) {
        pipes = pipeNetwork;
      },

      /**
       * Read the rain straight out of the grid's intensity field instead of
       * calling back per junction. `cells[n]` is the field index for
       * junction n (-1 off the grid); the field is read live, so the grid
       * can recompose it between steps.
       */
      setRainField(field, cells) {
        rainField = field || null;
        rainCells = field && cells ? cells : null;
      },

      /** Sea level (metres MSL) the coastal dead ends drain against. */
      setSeaLevel(metres) {
        seaLevelM = Number.isFinite(metres) ? metres : -Infinity;
      },

      get seaLevelM() {
        return seaLevelM;
      },

      /** Water arriving on a junction from outside the routing - a manhole spilling. */
      addWater(n, m3) {
        if (m3 > 0 && n >= 0 && n < nodeCount) {
          volM3[n] += m3;
          spilledInM3 += m3;
        }
      },

      /** Standing depth per junction, metres. Read-only view for the ensemble. */
      get depths() {
        return depthCache;
      },

      get simSeconds() {
        return simSeconds;
      },

      /** Water balance in m3, for probes and conservation checks. */
      totals() {
        let stored = 0;
        for (let n = 0; n < nodeCount; n += 1) {
          stored += volM3[n];
        }
        return {
          storedM3: stored,
          rainedM3,
          drainedM3,
          infiltratedM3,
          capturedM3,
          dischargedM3,
          backflowM3,
          spilledInM3,
          driedFilmM3,
          seaOutfalls: seaOutfallCount,
          seaLevelM
        };
      },

      /**
       * The state as a compact snapshot, for the outcome timeline: standing
       * depth in mm (Uint16 - 65 m is plenty), each junction's live outflow
       * as a slot into its adjacency (Int8), the counters and the clock.
       * About 0.8 MB for the whole network.
       */
      snapshot() {
        if (!liveDownFrozen) {
          refreshLiveDownstream(stops[0]);
        }
        const depthMm = new Uint16Array(nodeCount);
        const outSlot = new Int8Array(nodeCount).fill(-1);
        for (let n = 0; n < nodeCount; n += 1) {
          const mm = Math.round(depthCache[n] * 1000);
          depthMm[n] = mm > 65535 ? 65535 : mm;
          const target = liveDown[n];
          if (target >= 0) {
            for (let k = adjOffset[n]; k < adjOffset[n + 1]; k += 1) {
              if (adjNode[k] === target) {
                outSlot[n] = k - adjOffset[n];
                break;
              }
            }
          }
        }
        return {
          depthMm,
          outSlot,
          totals: {
            rainedM3,
            drainedM3,
            infiltratedM3,
            capturedM3,
            dischargedM3,
            backflowM3,
            spilledInM3,
            driedFilmM3,
            simSeconds
          }
        };
      },

      /**
       * Put a snapshot back as the live state. Depth goes back to volume
       * through the stage-storage curve; flow rates are unknown and read as
       * zero until the next step.
       */
      restore(snap) {
        const { depthMm, outSlot, totals } = snap;
        clearActive();
        for (let n = 0; n < nodeCount; n += 1) {
          const depth = depthMm[n] / 1000;
          let volume =
            depth <= CURB_M ? depth * patchM2[n] : curbVolM3[n] + (depth - CURB_M) * floodAreaM2[n];
          if (!(volume > SNAP_DRY_M3)) {
            volume = 0;
          }
          volM3[n] = volume;
          wetSince[n] = volume > 0 ? totals.simSeconds : -1;
          liveDown[n] = outSlot[n] >= 0 ? adjNode[adjOffset[n] + outSlot[n]] : -1;
        }
        flowM3.fill(0);
        edgeRate.fill(0);
        rainedM3 = totals.rainedM3;
        drainedM3 = totals.drainedM3;
        infiltratedM3 = totals.infiltratedM3;
        capturedM3 = totals.capturedM3;
        dischargedM3 = totals.dischargedM3;
        backflowM3 = totals.backflowM3;
        spilledInM3 = totals.spilledInM3;
        driedFilmM3 = totals.driedFilmM3;
        simSeconds = totals.simSeconds;
        refreshDepths();
        liveDownFrozen = true;
      },

      /** Advance by dt simulated seconds. intensityAt returns mm/h. */
      step(intensityAt, dtSeconds) {
        if (dtSeconds <= 0) {
          return;
        }
        liveDownFrozen = false;

        // Rain lands first, so this step's rain can flow within this step.
        // runoffFactor x patch area is the catchment the junction collects.
        // The same pass collects the active set: every junction holding
        // water, with its links and neighbours.
        clearActive();
        const rainVolumeScale = dtSeconds / 3.6e6;
        for (let n = 0; n < nodeCount; n += 1) {
          const cell = rainCells ? rainCells[n] : -1;
          const intensity = rainCells ? (cell >= 0 ? rainField[cell] : 0) : intensityAt(lat[n], lng[n]);
          if (intensity > 0) {
            const addedM3 = intensity * rainVolumeScale * patchM2[n] * runoffFactor[n];
            volM3[n] += addedM3;
            rainedM3 += addedM3;
          }
          if (volM3[n] > 0) {
            activate(n);
          }
        }

        // Nothing on the ground and nothing falling: the clock still runs,
        // so the infiltration curve keeps its timebase, but there is no
        // water to move.
        if (activeCount === 0) {
          simSeconds += dtSeconds;
          return;
        }

        // Inlets: every grated cover takes the street's water down at the
        // rate its grate passes (a weir at shallow depths, an orifice once
        // drowned - hydraulics.js), and only as much as the manhole below
        // has room for. A surcharged network refuses it, and the street
        // stays wet: that is how a full trunk shows on the surface.
        if (pipes) {
          const { count, street, node, perimeterM, openAreaM2 } = pipes.inlets;
          const clogging = config.inletClogging;

          for (let k = 0; k < count; k += 1) {
            const s = street[k];
            const volume = volM3[s];
            if (volume <= 0) {
              continue;
            }
            const depth = depthOf(volume, s);
            if (depth < MIN_FLOW_DEPTH) {
              continue;
            }

            // inletCapture's rule, inlined: min(weir, orifice) less the
            // blocked share. Called per inlet per step, and its argument
            // object is otherwise garbage.
            const weir = INLET_WEIR * perimeterM[k] * Math.sqrt(depth * depth * depth);
            const orifice = INLET_ORIFICE * openAreaM2[k] * Math.sqrt(2 * GRAVITY * depth);
            let wanted = (weir < orifice ? weir : orifice) * (1 - clogging) * dtSeconds;
            if (wanted > volume) {
              wanted = volume;
            }
            const acceptedM3 = pipes.offer(node[k], wanted);
            if (acceptedM3 > 0) {
              volM3[s] -= acceptedM3;
              capturedM3 += acceptedM3;
            }
          }
        }

        // Substep so the fastest possible water cannot jump past an edge, and
        // so head differences relax gradually instead of oscillating.
        const manningK = 1 / config.streetManningN;
        const vMax = config.streetFlowMaxMs;
        const substeps = Math.min(8, Math.max(1, Math.ceil((vMax * dtSeconds) / 15)));
        const dtSub = dtSeconds / substeps;
        // Street drains: a capacity, not a proportion. Below the curb only
        // the street patch drains; a spread flood soaks over its whole plain.
        const drainRate = config.streetDrainMmPerHour / 3.6e6; // m per second

        for (let pass = 0; pass < substeps; pass += 1) {
          // Standing depths for this substep, from the frozen volumes, and
          // the per-substep buffers cleared - both over the active set only,
          // which is also the only set anything below writes to.
          const stepped = activeCount;
          for (let i = 0; i < stepped; i += 1) {
            const n = activeNodes[i];
            const volume = volM3[n];
            depthCache[n] = volume > 0 ? depthOf(volume, n) : 0;
            proposedOut[n] = 0;
            terminalQ[n] = 0;
            seaInflow[n] = 0;
          }
          const steppedEdges = activeEdgeCount;
          for (let i = 0; i < steppedEdges; i += 1) {
            edgeFlow[activeEdges[i]] = 0;
          }

          // Phase 1: propose a transfer on every edge from the frozen state.
          // Water surface decides direction and rate; a higher target surface
          // means no flow that way at all, which is the backwater rule. Edges
          // with both ends dry - most of the network, most of the time - cost
          // two loads and a compare.
          for (let i = 0; i < steppedEdges; i += 1) {
            const e = activeEdges[i];
            const a = edges[2 * e];
            const b = edges[2 * e + 1];
            const depthA = depthCache[a];
            const depthB = depthCache[b];
            if (depthA < MIN_FLOW_DEPTH && depthB < MIN_FLOW_DEPTH) {
              continue;
            }

            let head = elev[a] + depthA - elev[b] - depthB;

            let src;
            let available;
            if (head > 1e-6) {
              src = a;
              available = depthA;
            } else if (head < -1e-6) {
              src = b;
              available = depthB;
              head = -head;
            } else {
              continue;
            }

            if (available < MIN_FLOW_DEPTH) {
              continue;
            }

            const dist = edgeDist[e];
            // Manning on the water-surface slope; cbrt(d^2) is d^(2/3).
            let velocity = manningK * Math.cbrt(available * available) * Math.sqrt(head / dist);
            if (velocity > vMax) {
              velocity = vMax;
            }

            let fraction = (velocity * dtSub) / dist;
            if (fraction > 1) {
              fraction = 1;
            }

            let transfer = available * fraction;
            // Never transfer past the level the two surfaces would equalise
            // at; a quarter of the head leaves room for a four-way junction
            // sending in every direction without overshooting into ping-pong.
            const equalise = head * 0.25;
            if (transfer > equalise) {
              transfer = equalise;
            }

            // Flux runs along the street corridor, so depth moved converts to
            // volume through the sending junction's street area.
            const transferM3 = transfer * patchM2[src];
            edgeFlow[e] = src === a ? transferM3 : -transferM3;
            proposedOut[src] += transferM3;
          }

          // Terminal junctions are the network's outfalls. A dead end that
          // meets the sea discharges over a nominal edge to the TIDE level:
          // the higher the tide, the less head, until a drowned outfall
          // stops - and the sea flows the other way onto the street. Other
          // dead ends (canals, roads beyond the study area) discharge over a
          // nominal edge whose far side is always lower.
          for (let i = 0; i < stepped; i += 1) {
            const n = activeNodes[i];
            if (downstream[n] >= 0) {
              continue;
            }
            const available = depthCache[n];
            const sea = seaOutfall[n] === 1 && seaLevelM > -Infinity;

            if (sea && seaLevelM > elev[n] + available + 1e-4) {
              // Drowned: the sea stands above the street water here, so it
              // comes in, at Manning's rate for the depth it covers the
              // street to, and never past a quarter of the way to level.
              const head = seaLevelM - elev[n] - available;
              const seaDepth = seaLevelM - elev[n];
              let velocity = manningK * Math.cbrt(seaDepth * seaDepth) * Math.sqrt(head / OUTFALL_LEN);
              if (velocity > vMax) {
                velocity = vMax;
              }
              let fraction = (velocity * dtSub) / OUTFALL_LEN;
              if (fraction > 1) {
                fraction = 1;
              }
              let transfer = seaDepth * fraction;
              if (transfer > head * 0.25) {
                transfer = head * 0.25;
              }
              seaInflow[n] = transfer * patchM2[n];
              continue;
            }

            if (available < MIN_FLOW_DEPTH) {
              continue;
            }

            let velocity;
            let cap = Infinity;
            if (sea) {
              const receiving = Math.max(seaLevelM, elev[n] - OUTFALL_DROP_M);
              const head = elev[n] + available - receiving;
              if (head <= 1e-6) {
                continue;
              }
              velocity = manningK * Math.cbrt(available * available) * Math.sqrt(head / OUTFALL_LEN);
              cap = head * 0.25;
            } else {
              velocity =
                manningK *
                Math.cbrt(available * available) *
                Math.sqrt(MIN_SLOPE + available / OUTFALL_LEN);
            }
            if (velocity > vMax) {
              velocity = vMax;
            }

            let fraction = (velocity * dtSub) / OUTFALL_LEN;
            if (fraction > 1) {
              fraction = 1;
            }

            let transfer = available * fraction;
            if (transfer > cap) {
              transfer = cap;
            }
            const transferM3 = transfer * patchM2[n];
            terminalQ[n] = transferM3;
            proposedOut[n] += transferM3;
          }

          // Phase 2: a junction may not send more water than it holds.
          for (let i = 0; i < stepped; i += 1) {
            const n = activeNodes[i];
            const proposed = proposedOut[n];
            outflowScale[n] = proposed > volM3[n] && proposed > 0 ? volM3[n] / proposed : 1;
            delta[n] = 0;
          }

          // Phase 3: land every transfer at once, so junction order is moot.
          for (let i = 0; i < steppedEdges; i += 1) {
            const e = activeEdges[i];
            const flow = edgeFlow[e];
            if (flow === 0) {
              continue;
            }

            const src = flow > 0 ? edges[2 * e] : edges[2 * e + 1];
            const tgt = flow > 0 ? edges[2 * e + 1] : edges[2 * e];
            const moved = (flow > 0 ? flow : -flow) * outflowScale[src];
            delta[src] -= moved;
            delta[tgt] += moved;
            flowM3[src] += moved;
            edgeRate[e] += flow > 0 ? moved : -moved;
          }

          for (let i = 0; i < stepped; i += 1) {
            const n = activeNodes[i];
            const out = terminalQ[n];
            if (out > 0) {
              const moved = out * outflowScale[n];
              delta[n] -= moved;
              dischargedM3 += moved;
              flowM3[n] += moved;
            }
            const inflow = seaInflow[n];
            if (inflow > 0) {
              delta[n] += inflow;
              backflowM3 += inflow;
              flowM3[n] += inflow;
            }
          }

          // Phase 4: apply, absorb, and keep the state sane. Soakage takes
          // its share everywhere the ground is wet; the generic drain term
          // only where no surveyed inlets exist (the inlets ran above).
          for (let i = 0; i < stepped; i += 1) {
            const n = activeNodes[i];
            if (volM3[n] === 0 && delta[n] === 0) {
              continue;
            }

            let next = volM3[n] + delta[n];

            if (next > 0) {
              const spread = next > curbVolM3[n];
              const area = spread ? floodAreaM2[n] : patchM2[n];

              if (wetSince[n] < 0) {
                wetSince[n] = simSeconds;
              }
              const pervious = spread ? config.perviousStripFraction : config.perviousStreetFraction;
              if (pervious > 0) {
                // Horton's curve, inlined: called per wet junction per
                // substep, and the argument object is otherwise garbage.
                const rate =
                  infiltration.fc +
                  (infiltration.f0 - infiltration.fc) *
                    Math.exp(-infiltration.k * (simSeconds - wetSince[n]));
                let soaked = rate * pervious * area * dtSub;
                if (soaked > next) {
                  soaked = next;
                }
                next -= soaked;
                infiltratedM3 += soaked;
              }

              if (next > 0 && (!pipes || !pipes.covered || pipes.covered[n] === 0)) {
                let drainedNow = drainRate * dtSub * area;
                if (drainedNow > next) {
                  drainedNow = next;
                }
                next -= drainedNow;
                drainedM3 += drainedNow;
              }
            }

            // One comparison catches negatives, NaN and the last damp film.
            if (!(next > SNAP_DRY_M3)) {
              if (next > 0) {
                driedFilmM3 += next;
              }
              next = 0;
              wetSince[n] = -1;
            }

            volM3[n] = next;
            // Newly wet: bring its links and neighbours into the next
            // substep, so water can carry on past the set it started in.
            if (next > 0) {
              activate(n);
            }
          }

          simSeconds += dtSub;
        }

        // Final standing depths for rendering and probes, and flow as a
        // rate. Every wet junction is in the active set, so a peak taken
        // over it is the peak over the whole network.
        peak = 0;
        for (let i = 0; i < activeCount; i += 1) {
          const n = activeNodes[i];
          const volume = volM3[n];
          const value = volume > 0 ? depthOf(volume, n) : 0;
          depthCache[n] = value;
          if (value > peak) {
            peak = value;
          }
          flowM3[n] /= dtSeconds;
        }
        for (let i = 0; i < activeEdgeCount; i += 1) {
          edgeRate[activeEdges[i]] /= dtSeconds;
        }
      },

      hasWater() {
        return peak >= stops[0];
      },

      /**
       * Deepest street water within radiusM of a point, for the map's
       * sample-point popup - reading a thin line by hovering it exactly is
       * fiddly, so clicking anywhere nearby answers the same question.
       * Returns { depthM, flowM3s, distanceM, severity } or null when dry.
       */
      depthNear(latQ, lngQ, radiusM = 60) {
        if (peak < stops[0]) {
          return null;
        }

        if (!nearHash) {
          buildNearHash();
        }

        const cosLat = Math.cos((latQ * Math.PI) / 180);
        const cellLat = Math.floor(latQ / NEAR_CELL_DEG);
        const cellLng = Math.floor(lngQ / NEAR_CELL_DEG);
        const reach = Math.ceil(radiusM / (NEAR_CELL_DEG * 110574)) + 1;

        // Nearest wet street answers "what is it like HERE"; the deepest is
        // reported separately, because a pond around the corner used to be
        // presented as if it were underfoot.
        let nearest = null;
        let deepest = null;
        for (let ci = cellLat - reach; ci <= cellLat + reach; ci += 1) {
          for (let cj = cellLng - reach; cj <= cellLng + reach; cj += 1) {
            const bucket = nearHash.get(ci * 200000 + cj);
            if (!bucket) {
              continue;
            }

            for (const n of bucket) {
              if (depthCache[n] < stops[0]) {
                continue;
              }

              const dy = (lat[n] - latQ) * 110574;
              const dx = (lng[n] - lngQ) * 111320 * cosLat;
              const distance = Math.hypot(dx, dy);
              if (distance > radiusM) {
                continue;
              }

              const found = {
                depthM: depthCache[n],
                flowM3s: flowM3[n],
                distanceM: distance,
                severity: SEVERITY[classOf(depthCache[n])]
              };

              if (!nearest || distance < nearest.distanceM) {
                nearest = found;
              }
              if (!deepest || found.depthM > deepest.depthM) {
                deepest = found;
              }
            }
          }
        }

        return nearest ? { ...nearest, deepest } : null;
      },

      render() {
        if (peak < stops[0]) {
          // In rain mode the layer shows this storm's water and nothing else,
          // so with none on the ground it stays empty - waiting for a storm,
          // not falling back to the terrain baseline.
          clearChains();
          streams?.setLines([]);
          lineCount = 0;
          return;
        }

        // Chains follow the LIVE flow - the neighbour each junction actually
        // sent water to - so a backed-up street shows its water heading
        // upstream, and a trunk shows it racing down. Water standing still
        // ends a chain; a pool with no through-flow is the Ponding layer's.
        if (!liveDownFrozen) {
          refreshLiveDownstream(stops[0]);
        }
        const frozen = liveDownFrozen;
        rebuild(
          depthCache,
          stops[0],
          (value, flowRate) =>
            `Flooding ~${(value * 100).toFixed(0)} cm deep (${SEVERITY[classOf(value)]})` +
            (flowRate > 0.05
              ? `<br>~${flowRate.toFixed(1)} m³/s flowing through`
              : frozen
                ? ''
                : '<br>standing still'),
          classOf,
          flowM3,
          liveDown
        );
      },

      // What the Ponding layer paints from: depth per junction and the area
      // each junction's water spreads over.
      floodAreaM2,
      patchAreaM2: patchM2,
      curbDepthM: CURB_M,
      depthStops: stops
    };
  }

  showUniform();
  const dynamic = createDynamicWater();

  return {
    layer: group,
    label: 'Street Flow',
    stats: {
      nodeCount,
      edgeCount: edges.length / 2,
      sinks,
      filledSinks,
      despiked: despiked.clamped,
      noisePitsFilled: despiked.pitsFilled,
      lines: lineCount
    },

    dynamic,

    // The graph as the water model sees it - coordinates, links and the
    // despiked heights - so the pipe network can sit its manholes under the
    // streets and the ponding layer can paint water along them.
    graph: { nodeCount, lat, lng, elev, edges },

    /**
     * Paint an ensemble result: how often each junction flooded deeper than
     * the threshold across the members, 0..1. Fixed colour stops, so 20%
     * always looks the same.
     */
    renderProbability(probability, { members = 0, thresholdM = 0.05 } = {}) {
      const stops = [0.05, 0.2, 0.4, 0.6, 0.8];
      const classOf = (value) => {
        let cls = 0;
        for (let index = 1; index < stops.length; index += 1) {
          if (value >= stops[index]) {
            cls = index;
          }
        }
        return cls;
      };
      rebuild(
        probability,
        stops[0],
        (value) =>
          `Flood chance: ${Math.round(value * 100)}%` +
          (members ? ` (${Math.round(value * members)} of ${members} runs)` : '') +
          `<br>deeper than ${Math.round(thresholdM * 100)} cm at some point`,
        classOf
      );
    },

    /** Shift + tick: classic dashed rendering instead of stream particles. */
    setClassic(flag) {
      // Shift + tick: the classic marching dashes, drawn by the same layer.
      streams?.setMode(flag ? 'dash' : 'trail');
    },

    /**
     * Switch between uniform terrain flow and rainfall-driven flow.
     *
     * depthAt(lat, lng) returns surface water on the ground in mm, or null
     * to restore the uniform view. Each junction collects that depth over
     * its catchment strip - the same multiplier the ponding model uses - and
     * the water is routed downhill along the streets, so a chain's value is
     * the runoff arriving from upstream right now. Junctions with no rain
     * contribute nothing, so dry districts drop out of the network.
     */
    refresh(depthAt) {
      if (!depthAt) {
        showUniform();
        return;
      }

      const weights = new Float64Array(nodeCount);
      const factor = dynamic.runoffFactor;
      let wetCount = 0;
      let weightSum = 0;

      for (let n = 0; n < nodeCount; n += 1) {
        const depth = depthAt(lat[n], lng[n]);
        if (depth > 0) {
          weights[n] = depth * factor[n];
          weightSum += weights[n];
          wetCount += 1;
        }
      }

      if (wetCount === 0) {
        clearChains();
        streams?.setLines([]);
        lineCount = 0;
        return;
      }

      // mm on the street patch, summed over the junctions upstream. Forecast
      // rain is light and falls everywhere, so an absolute cut tuned for a
      // cloudburst left nothing drawn: the cut keeps the uniform view's
      // density instead - a chain shows once it gathers the baseline's count
      // of average wet junctions - and the colour carries the amount, on a
      // fixed scale of runoff volume, a decade per class from one cubic metre.
      const weighted = accumulateFlow(nodeCount, downstream, weights);
      // A nominal patch for the tooltip's volume, not the per-junction one:
      // an accumulated total has no single junction to take an area from.
      const nominalPatchM2 = config.streetPatchAreaM2;
      const m3Of = (value) => (value * nominalPatchM2) / 1000;
      const classOf = (value) =>
        Math.max(
          0,
          Math.min(ACCUMULATION_COLORS.length - 1, Math.floor(Math.log10(Math.max(1, m3Of(value)))))
        );
      rebuild(
        weighted,
        (weightSum / wetCount) * threshold,
        (value) =>
          `Street flow (forecast rain)<br>~${Math.round(m3Of(value)).toLocaleString()} m\u00b3 of runoff from upstream`,
        classOf
      );
    }
  };
}

// Clamp junctions that sit far outside the height range of their own street
// neighbours. A single node has no business being metres above or below both
// sides of its street - that is a building or a survey artefact, not ground -
// while a genuine depression spans many junctions and is left alone.
function despikeElevations(nodeCount, elev, edges, lat, lng) {
  const degree = new Int32Array(nodeCount);
  for (let i = 0; i < edges.length; i += 1) {
    degree[edges[i]] += 1;
  }

  const offset = new Int32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n += 1) {
    offset[n + 1] = offset[n] + degree[n];
  }

  const neighbours = new Int32Array(edges.length);
  const cursor = offset.slice(0, nodeCount);
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i];
    const b = edges[i + 1];
    neighbours[cursor[a]] = b;
    cursor[a] += 1;
    neighbours[cursor[b]] = a;
    cursor[b] += 1;
  }

  // Each junction is held within TOLERANCE of its neighbours' mean. A node on
  // a monotone climb sits at that mean and is untouched however steep the
  // street; a spike sits far above it and is pulled in. One 30 m DEM cell
  // spans 2-4 street nodes, so contamination usually comes in short runs
  // whose members prop each other up - iterating erodes them from the ends,
  // which a single min/max clamp against direct neighbours cannot do.
  // 0.25 m of curvature per 20 m hop is already beyond what 30 m COP30 can
  // genuinely resolve; anything sharper is aliasing or building bleed.
  const TOLERANCE_M = 0.25;
  let total = 0;

  for (let pass = 0; pass < 6; pass += 1) {
    let clamped = 0;

    for (let n = 0; n < nodeCount; n += 1) {
      if (offset[n] === offset[n + 1]) {
        continue;
      }

      let sum = 0;
      for (let k = offset[n]; k < offset[n + 1]; k += 1) {
        sum += elev[neighbours[k]];
      }
      const mean = sum / (offset[n + 1] - offset[n]);

      if (elev[n] > mean + TOLERANCE_M) {
        elev[n] = mean + TOLERANCE_M;
        clamped += 1;
      } else if (elev[n] < mean - TOLERANCE_M) {
        elev[n] = mean - TOLERANCE_M;
        clamped += 1;
      }
    }

    total += clamped;
    if (clamped === 0) {
      break;
    }
  }

  // Dead-end tips: a cul-de-sac's pavement is graded with its street, but the
  // DEM routinely drops the tip half a metre into the neighbouring plot. The
  // water model then ponds a red stub there until the fake dip overtops, so
  // pin every degree-1 tip to within a kerb's depth below its only neighbour.
  for (let n = 0; n < nodeCount; n += 1) {
    if (offset[n + 1] - offset[n] !== 1) {
      continue;
    }

    const floor = elev[neighbours[offset[n]]] - 0.1;
    if (elev[n] < floor) {
      elev[n] = floor;
      total += 1;
    }
  }

  // Finally, fill depressions too shallow to be real. COP30 resolves height
  // to metres, so a bowl a handful of centimetres deep is noise - but the
  // water model cannot tell, and faithfully ponds a lone 30 cm puddle in it
  // that outlasts the whole storm because every neighbour is higher. Anything
  // deeper than the threshold is left alone: those are plausible basins, and
  // ponding in them is the behaviour we want.
  const filled = fillGraphSinks(nodeCount, elev, offset, neighbours, lat, lng);
  const inDepression = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n += 1) {
    if (filled[n] - elev[n] > 1e-6) {
      inDepression[n] = 1;
    }
  }

  // A real basin covers a stretch of streets; an artefact is point-like. Group
  // the depression nodes into connected bowls so size can be judged, not just
  // depth: a one- or two-junction hollow is filled however deep it looks.
  const component = new Int32Array(nodeCount).fill(-1);
  const sizes = [];
  const stack = [];
  for (let seed = 0; seed < nodeCount; seed += 1) {
    if (!inDepression[seed] || component[seed] >= 0) {
      continue;
    }

    const label = sizes.length;
    let size = 0;
    component[seed] = label;
    stack.push(seed);

    while (stack.length > 0) {
      const node = stack.pop();
      size += 1;

      for (let k = offset[node]; k < offset[node + 1]; k += 1) {
        const m = neighbours[k];
        if (inDepression[m] && component[m] < 0) {
          component[m] = label;
          stack.push(m);
        }
      }
    }

    sizes.push(size);
  }

  let pitsFilled = 0;
  for (let n = 0; n < nodeCount; n += 1) {
    if (!inDepression[n]) {
      continue;
    }

    const shallow = filled[n] - elev[n] <= config.streetMaxNoisePitM;
    const pointLike = sizes[component[n]] <= config.streetMinBasinNodes;
    if (shallow || pointLike) {
      elev[n] = filled[n];
      pitsFilled += 1;
    }
  }

  return { clamped: total, pitsFilled };
}

// Compressed adjacency, then steepest-descent routing and a topological
// accumulation pass. Same shape as the grid version, but the neighbours come
// from street connections rather than the eight surrounding cells.
function routeDownhill(nodeCount, elev, edges, lat, lng) {
  const degree = new Int32Array(nodeCount);
  for (let i = 0; i < edges.length; i += 1) {
    degree[edges[i]] += 1;
  }

  const offset = new Int32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n += 1) {
    offset[n + 1] = offset[n] + degree[n];
  }

  const neighbours = new Int32Array(edges.length);
  const cursor = offset.slice(0, nodeCount);
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i];
    const b = edges[i + 1];
    neighbours[cursor[a]] = b;
    cursor[a] += 1;
    neighbours[cursor[b]] = a;
    cursor[b] += 1;
  }

  // Junctions sit far closer together than the 30 m DEM cells, so ~30% of
  // neighbouring pairs read the same height and 43% of junctions have nowhere
  // lower to go. Without filling, almost nothing accumulates.
  const rawSinks = countSinks(nodeCount, elev, offset, neighbours);
  const height = config.roadFlowFillSinks
    ? fillGraphSinks(nodeCount, elev, offset, neighbours, lat, lng)
    : elev;

  const downstream = new Int32Array(nodeCount).fill(-1);
  let sinks = 0;

  for (let n = 0; n < nodeCount; n += 1) {
    let best = -1;
    let bestElevation = height[n];

    for (let k = offset[n]; k < offset[n + 1]; k += 1) {
      const m = neighbours[k];
      if (height[m] < bestElevation) {
        bestElevation = height[m];
        best = m;
      }
    }

    downstream[n] = best;
    if (best < 0) {
      sinks += 1;
    }
  }

  const accumulation = accumulateFlow(nodeCount, downstream, null);

  return { downstream, accumulation, sinks, filledSinks: rawSinks - sinks };
}

// Topological accumulation over fixed downstream pointers. Routing depends only
// on terrain, so this is the piece that re-runs when rain weights change.
function accumulateFlow(nodeCount, downstream, weights) {
  const indegree = new Int32Array(nodeCount);
  for (let n = 0; n < nodeCount; n += 1) {
    if (downstream[n] >= 0) {
      indegree[downstream[n]] += 1;
    }
  }

  const accumulation = new Float64Array(nodeCount);
  for (let n = 0; n < nodeCount; n += 1) {
    accumulation[n] = weights ? weights[n] : 1;
  }

  const queue = new Int32Array(nodeCount);
  let tail = 0;

  for (let n = 0; n < nodeCount; n += 1) {
    if (indegree[n] === 0) {
      queue[tail] = n;
      tail += 1;
    }
  }

  for (let head = 0; head < tail; head += 1) {
    const n = queue[head];
    const target = downstream[n];
    if (target < 0) {
      continue;
    }

    accumulation[target] += accumulation[n];
    indegree[target] -= 1;
    if (indegree[target] === 0) {
      queue[tail] = target;
      tail += 1;
    }
  }

  return accumulation;
}

function countSinks(nodeCount, height, offset, neighbours) {
  let sinks = 0;

  for (let n = 0; n < nodeCount; n += 1) {
    let lower = false;
    for (let k = offset[n]; k < offset[n + 1]; k += 1) {
      if (height[neighbours[k]] < height[n]) {
        lower = true;
        break;
      }
    }

    if (!lower) {
      sinks += 1;
    }
  }

  return sinks;
}

// Priority-flood with an epsilon gradient, the same technique the DEM grid uses,
// applied to the street graph. Outlets are the coastal junctions and anything on
// the edge of the downloaded area, because those are where water can leave.
const FILL_EPSILON_METERS = 1e-4;

function fillGraphSinks(nodeCount, elev, offset, neighbours, lat, lng) {
  const filled = Float64Array.from(elev);
  const resolved = new Uint8Array(nodeCount);
  const heap = createMinHeap();

  let minElevation = Infinity;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;

  for (let n = 0; n < nodeCount; n += 1) {
    minElevation = Math.min(minElevation, elev[n]);
    west = Math.min(west, lng[n]);
    east = Math.max(east, lng[n]);
    south = Math.min(south, lat[n]);
    north = Math.max(north, lat[n]);
  }

  const marginLng = (east - west) * 0.01;
  const marginLat = (north - south) * 0.01;

  for (let n = 0; n < nodeCount; n += 1) {
    const coastal = elev[n] <= minElevation + 1;
    const onEdge =
      lng[n] <= west + marginLng ||
      lng[n] >= east - marginLng ||
      lat[n] <= south + marginLat ||
      lat[n] >= north - marginLat;

    if (coastal || onEdge) {
      resolved[n] = 1;
      heap.push(n, filled[n]);
    }
  }

  while (heap.size() > 0) {
    const { index, priority } = heap.pop();

    for (let k = offset[index]; k < offset[index + 1]; k += 1) {
      const m = neighbours[k];
      if (resolved[m]) {
        continue;
      }

      resolved[m] = 1;
      if (filled[m] <= priority) {
        filled[m] = priority + FILL_EPSILON_METERS;
      }

      heap.push(m, filled[m]);
    }
  }

  return filled;
}

// Walk downstream from each junction, drawing every edge at most once, so the
// shared trunks are not redrawn per tributary.
function chainByClass(nodeCount, downstream, accumulation, classOf, threshold, lat, lng, aux = null) {
  const order = [];
  for (let n = 0; n < nodeCount; n += 1) {
    if (accumulation[n] >= threshold && downstream[n] >= 0) {
      order.push(n);
    }
  }

  order.sort((a, b) => accumulation[a] - accumulation[b]);

  const drawn = new Uint8Array(nodeCount);
  const lines = [];

  for (const seed of order) {
    if (drawn[seed]) {
      continue;
    }

    let current = seed;
    let currentClass = classOf(accumulation[seed]);
    let points = [[lat[seed], lng[seed]]];
    let peak = accumulation[seed];
    let auxPeak = aux ? aux[seed] : 0;
    drawn[seed] = 1;

    for (let step = 0; step < 4000; step += 1) {
      const next = downstream[current];
      if (next < 0) {
        break;
      }

      // Depth data is not monotone along a chain the way upstream counts
      // are: downstream of a wet junction can be bone dry, and painting on
      // through it drew kilometres of dry street. One dry node is included
      // so a single wet junction still shows as a short segment.
      if (accumulation[next] < threshold) {
        points.push([lat[next], lng[next]]);
        break;
      }

      points.push([lat[next], lng[next]]);
      peak = Math.max(peak, accumulation[next]);
      if (aux) {
        auxPeak = Math.max(auxPeak, aux[next]);
      }

      const nextClass = classOf(accumulation[next]);
      const already = drawn[next] === 1;

      if (nextClass !== currentClass && !already) {
        lines.push({ points, value: peak, colorClass: currentClass, aux: auxPeak });
        points = [[lat[next], lng[next]]];
        peak = accumulation[next];
        auxPeak = aux ? aux[next] : 0;
        currentClass = nextClass;
      }

      if (already) {
        break;
      }

      drawn[next] = 1;
      current = next;
    }

    if (points.length > 1) {
      lines.push({ points, value: peak, colorClass: currentClass, aux: auxPeak });
    }
  }

  return lines;
}

function maxOf(values) {
  let peak = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > peak) {
      peak = values[i];
    }
  }
  return peak;
}

async function loadNetwork() {
  try {
    const response = await fetch(NETWORK_URL);
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Street network unavailable:', error);
    return null;
  }
}
