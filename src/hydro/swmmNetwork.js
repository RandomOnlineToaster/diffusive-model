// EPA SWMM 5.2 as the drainage engine, in place of the diffusive model.
//
// NOT IMPLEMENTED YET. This module exists so hydro/drainage.js can name it:
// Rollup resolves dynamic imports at build time, so the engine switch needs
// something here even while the engine itself is being built.
//
// --- what this has to become ------------------------------------------------
//
// The street model stays exactly as it is. SWMM replaces only what happens
// below the grates, so this module must satisfy the same twelve-member
// contract pipeNetwork.js does - it is listed in full at the top of
// hydro/drainage.js. Signatures are identical; only the implementation differs.
//
// The pieces it needs:
//
//   1. The engine. EPA SWMM's computational core is public-domain C and
//      compiles to WebAssembly with Emscripten. Ship the built .wasm as a
//      committed artifact so a clone still needs no toolchain.
//
//   2. The model. scripts/export-swmm-inp.mjs already writes the surveyed
//      network as a .inp EPA SWMM 5.2.4 accepts and runs (continuity error
//      -0.054%). Generate it at build time, or write it into the wasm's
//      virtual filesystem at startup.
//
//   3. Coupling, per street substep. The streets already compute how much
//      water each grate takes; hand that to SWMM as node inflow rather than
//      letting SWMM's own subcatchments generate runoff - it has none here.
//
//        offer(node, m3)  ->  accumulate, then swmm_setValue(NODE_LATFLOW)
//        step(dt)         ->  swmm_step() until SWMM's clock catches up
//        headAt(node)     ->  swmm_getValue(NODE_HEAD)
//
//      Read node flooding back each step and return it to the street through
//      the onSpill callback, the way a surcharged manhole does today.
//
//   4. Rewind. SWMM has no in-memory state swap. A hotstart file can be
//      written at any point but read only between swmm_open() and
//      swmm_start(), so restore() means tearing the engine down and starting
//      it again from that file. Report this by setting
//
//        instantRestore: false
//
//      so the timeline stops assuming scrubbing is free. Measured on the real
//      network, 6 simulated hours took 15 min 29 s against the diffusive
//      engine's ~24 s, which is why a rewind cannot re-run in the background
//      and the UI needs a precompute-then-play path instead.
//
//   5. Bulk transfers. There are 6,903 nodes; crossing the JS/wasm boundary
//      once per node per step will dominate the runtime. Read and write
//      through shared typed-array views over the wasm heap instead.

/**
 * Build a SWMM-backed drainage network satisfying the drainage.js contract.
 *
 * Throws until the engine is built; drainage.js catches this, says so, and
 * falls back to the diffusive engine so the map still works.
 */
export async function createSwmmNetwork() {
  throw new Error(
    'swmmNetwork.js is not implemented yet - the EPA SWMM WebAssembly engine has ' +
      'not been built. Use VITE_DRAINAGE_ENGINE=diffusive until it is.'
  );
}
