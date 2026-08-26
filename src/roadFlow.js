import L from 'leaflet';
import { config } from './config.js';
import {
  ACCUMULATION_COLORS,
  accumulationClassifier,
  addLinesByClass,
  flowLineRenderer
} from './flow.js';
import { createChainParticleLayer } from './flowParticles.js';
import { createMinHeap } from './terrain.js';

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

  function rebuild(values, minValue, tooltipFor, classOfOverride = null, aux = null) {
    clearChains();
    const classOf = classOfOverride || accumulationClassifier(minValue, maxOf(values));
    const lines = chainByClass(nodeCount, downstream, values, classOf, minValue, lat, lng, aux);
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
  //   depth[n] -= min(depth, drainCap * dt)     (street drains have a capacity)
  //
  // Because flow follows the water surface, a flooded downstream junction
  // first slows, then stops, then reverses its inflow: blockage propagates
  // upstream (the A -> B -> C backwater case), and pits fill until the water
  // finds its own way over. Every substep is two-phase - all transfers are
  // proposed from the state at time t, scaled so no junction sends more than
  // it holds, then landed at once - so the result is order-independent and
  // mass is conserved to the outfalls and drains.
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
    const flowM3 = new Float64Array(nodeCount); // m3/s through, for tooltips

    const PATCH_M2 = config.streetPatchAreaM2;
    const CURB_M = config.streetCurbDepthM;
    const CURB_VOL_M3 = PATCH_M2 * CURB_M;

    // Water below this is a film, not flow; below the snap volume it is gone.
    const MIN_FLOW_DEPTH = 5e-4;
    const SNAP_DRY_M3 = 1e-4 * PATCH_M2;
    const OUTFALL_LEN = 20;
    const MIN_SLOPE = 0.0005;

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

      for (let n = 0; n < nodeCount; n += 1) {
        const catchmentM2 = halfLen[n] * config.streetCatchmentWidthM;
        const factor = (config.streetRunoffCoeff * catchmentM2) / PATCH_M2;
        // Never less than the rain landing on the street itself.
        runoffFactor[n] = factor > 1 ? factor : 1;
        floodAreaM2[n] = catchmentM2 > PATCH_M2 ? catchmentM2 : PATCH_M2;
      }
    }

    // The stage-storage curve, volume -> standing depth.
    function depthOf(volume, n) {
      return volume <= CURB_VOL_M3
        ? volume / PATCH_M2
        : CURB_M + (volume - CURB_VOL_M3) / floodAreaM2[n];
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
    let drainedM3 = 0;
    let dischargedM3 = 0;

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
        volM3.fill(0);
        depthCache.fill(0);
        flowM3.fill(0);
        peak = 0;
        rainedM3 = 0;
        drainedM3 = 0;
        dischargedM3 = 0;
      },

      /**
       * Couple the street model to the underground pipes. Junctions with an
       * inlet stop using the street-drain capacity: the pipe becomes their
       * only way down, so a full pipe visibly backs the street up.
       */
      attachPipes(pipeSimulation) {
        pipes = pipeSimulation;
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
          dischargedM3
        };
      },

      /** Advance by dt simulated seconds. intensityAt returns mm/h. */
      step(intensityAt, dtSeconds) {
        if (dtSeconds <= 0) {
          return;
        }

        // Rain lands first, so this step's rain can flow within this step.
        // runoffFactor x patch area is the catchment the junction collects.
        const rainVolumeScale = (dtSeconds / 3.6e6) * PATCH_M2;
        for (let n = 0; n < nodeCount; n += 1) {
          const intensity = intensityAt(lat[n], lng[n]);
          if (intensity > 0) {
            const addedM3 = intensity * rainVolumeScale * runoffFactor[n];
            volM3[n] += addedM3;
            rainedM3 += addedM3;
          }
        }

        // Inlets: junctions near a pipe hand water down, but only as much as
        // the pipe has room for.
        if (pipes) {
          const intake = 1 - Math.exp(-dtSeconds / config.pipeInletTauSeconds);
          const { inletNode } = pipes;

          for (let n = 0; n < nodeCount; n += 1) {
            const pipeIndex = inletNode[n];
            if (pipeIndex < 0 || volM3[n] <= 0) {
              continue;
            }

            const acceptedM3 = pipes.offer(pipeIndex, volM3[n] * intake);
            if (acceptedM3 > 0) {
              volM3[n] -= acceptedM3;
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

        flowM3.fill(0);

        for (let pass = 0; pass < substeps; pass += 1) {
          // Standing depths for this substep, from the frozen volumes.
          for (let n = 0; n < nodeCount; n += 1) {
            const volume = volM3[n];
            depthCache[n] = volume > 0 ? depthOf(volume, n) : 0;
          }

          proposedOut.fill(0);
          terminalQ.fill(0);
          edgeFlow.fill(0);

          // Phase 1: propose a transfer on every edge from the frozen state.
          // Water surface decides direction and rate; a higher target surface
          // means no flow that way at all, which is the backwater rule. Edges
          // with both ends dry - most of the network, most of the time - cost
          // two loads and a compare.
          for (let e = 0; e < edgeCount; e += 1) {
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
            // volume through the street patch area.
            const transferM3 = transfer * PATCH_M2;
            edgeFlow[e] = src === a ? transferM3 : -transferM3;
            proposedOut[src] += transferM3;
          }

          // Terminal junctions are the network's outfalls (sea, canals, roads
          // beyond the study area): they discharge over a nominal edge whose
          // far side is always lower.
          for (let n = 0; n < nodeCount; n += 1) {
            const available = depthCache[n];
            if (available < MIN_FLOW_DEPTH || downstream[n] >= 0) {
              continue;
            }

            let velocity =
              manningK *
              Math.cbrt(available * available) *
              Math.sqrt(MIN_SLOPE + available / OUTFALL_LEN);
            if (velocity > vMax) {
              velocity = vMax;
            }

            let fraction = (velocity * dtSub) / OUTFALL_LEN;
            if (fraction > 1) {
              fraction = 1;
            }

            const transferM3 = available * fraction * PATCH_M2;
            terminalQ[n] = transferM3;
            proposedOut[n] += transferM3;
          }

          // Phase 2: a junction may not send more water than it holds.
          for (let n = 0; n < nodeCount; n += 1) {
            const proposed = proposedOut[n];
            outflowScale[n] = proposed > volM3[n] && proposed > 0 ? volM3[n] / proposed : 1;
          }

          // Phase 3: land every transfer at once, so junction order is moot.
          delta.fill(0);
          for (let e = 0; e < edgeCount; e += 1) {
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
          }

          for (let n = 0; n < nodeCount; n += 1) {
            const out = terminalQ[n];
            if (out > 0) {
              const moved = out * outflowScale[n];
              delta[n] -= moved;
              dischargedM3 += moved;
              flowM3[n] += moved;
            }
          }

          // Phase 4: apply, drain, and keep the state sane. Junctions served
          // by a pipe inlet drain through the pipe alone.
          for (let n = 0; n < nodeCount; n += 1) {
            if (volM3[n] === 0 && delta[n] === 0) {
              continue;
            }

            let next = volM3[n] + delta[n];

            if (next > 0 && (!pipes || pipes.inletNode[n] < 0)) {
              const area = next <= CURB_VOL_M3 ? PATCH_M2 : floodAreaM2[n];
              let drainedNow = drainRate * dtSub * area;
              if (drainedNow > next) {
                drainedNow = next;
              }
              next -= drainedNow;
              drainedM3 += drainedNow;
            }

            // One comparison catches negatives, NaN and the last damp film.
            if (!(next > SNAP_DRY_M3)) {
              next = 0;
            }

            volM3[n] = next;
          }
        }

        // Final standing depths for rendering and probes, and flow as a rate.
        refreshDepths();
        for (let n = 0; n < nodeCount; n += 1) {
          flowM3[n] /= dtSeconds;
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

        rebuild(
          depthCache,
          stops[0],
          (value, flowRate) =>
            `Flooding ~${(value * 100).toFixed(0)} cm deep (${SEVERITY[classOf(value)]})` +
            (flowRate > 0.05 ? `<br>~${flowRate.toFixed(1)} m³/s flowing through` : ''),
          classOf,
          flowM3
        );
      }
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

    // Raw graph coordinates, so the pipe model can map inlets onto junctions.
    graph: { nodeCount, lat, lng },

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
      const patchM2 = config.streetPatchAreaM2;
      const m3Of = (value) => (value * patchM2) / 1000;
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
