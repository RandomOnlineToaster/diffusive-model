// Which engine routes the water under the streets.
//
//   VITE_DRAINAGE_ENGINE=diffusive   the model in this repo (default)
//   VITE_DRAINAGE_ENGINE=swmm        EPA SWMM 5.2, compiled to WebAssembly
//
// Both engines are handed the same drainage model, the same street graph and
// the same spill callback, and both are driven by the same street step. That
// is deliberate: with the surface, the data and the rain held identical, a
// difference in the answer is the drainage engine and nothing else. Running
// the two on separate branches instead would let the streets and the datasets
// drift apart, and the comparison would stop meaning anything.
//
// Vite bakes import.meta.env at server start, so switching engines means
// editing .env.local and RESTARTING the dev server - a reload will not do it.
//
// --- the contract -----------------------------------------------------------
//
// Everything outside this folder touches a drainage network through twelve
// members. An engine that provides these is a drop-in replacement:
//
//   hydraulics   offer(node, m3) -> m3 accepted   (roadFlow, per inlet per substep)
//                step(dtSeconds)                  (roadFlow, every simulated minute)
//                inlets                           { count, node, street,
//                                                   perimeterM, openAreaM2 }
//                covered                          Uint8Array per street junction
//                headAt(node) -> metres MSL
//
//   state        snapshot() -> opaque             (forecastRain, outcomeTimeline)
//                restore(snapshot)
//                reset()
//                setSeaLevel(metres)
//
//   display      stats                            { nodes, conduits, inlets,
//                                                   pumps, seaOutfalls,
//                                                   freeOutfalls, capacityM3,
//                                                   coveredStreets }
//                totals()                         running water balance
//                fillByFeature()                  per-pipe fill, for recolouring
//                nearestNode(lat, lng, maxM)
//                pumpState(node)
//
// snapshot/restore is the one place the two engines are not alike. The
// diffusive engine copies typed arrays - about 30 KB, instantly. SWMM has no
// in-memory state swap: a hotstart file can be written at any point but can
// only be READ between swmm_open() and swmm_start(), so restoring means
// tearing the engine down and starting it again. An engine says which it is
// through `instantRestore`, and the timeline UI reads that rather than
// assuming scrubbing is free.

import { config } from '../config.js';

export { loadDrainageModel } from './pipeNetwork.js';

/**
 * Build the drainage network the configured engine asks for.
 *
 * The engine module is imported dynamically so Vite code-splits it: a build
 * running the diffusive engine never downloads SWMM's WebAssembly, and a
 * build running SWMM never pays for what it does not use.
 */
export async function createDrainage(options) {
  const engine = config.drainageEngine;

  if (engine === 'swmm') {
    try {
      const { createSwmmNetwork } = await import('./swmmNetwork.js');
      const network = await createSwmmNetwork(options);
      console.info('Drainage engine: EPA SWMM 5.2 (WebAssembly)');
      return network;
    } catch (error) {
      // Falling back rather than failing: an engine that is not built yet, or
      // a browser that refuses the WebAssembly, should still leave a usable
      // map rather than a blank one.
      console.error(
        'Drainage engine: SWMM was requested but could not start, falling back to the ' +
          'diffusive engine. Set VITE_DRAINAGE_ENGINE=diffusive to silence this.',
        error
      );
    }
  }

  const { createPipeNetwork } = await import('./pipeNetwork.js');
  const network = createPipeNetwork(options);
  console.info('Drainage engine: diffusive wave (src/hydro/pipeNetwork.js)');
  return network;
}
