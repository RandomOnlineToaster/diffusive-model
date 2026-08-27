// Exercises src/pipeNetwork.js on a hand-built three-manhole network:
//
//   A --50 m Ø0.60--> B --50 m Ø0.60--> C (sea outfall)      P (pump, alone)
//
// Checks that water put in at A reaches the sea, that mass is conserved to
// the last litre, that a high tide flows back in and spills onto the street,
// that a full manhole refuses more water, and that a pump empties its sump.
//
// Run: node scripts/test-pipe-network.mjs

import { createPipeNetwork, NODE_FREE_OUTFALL, NODE_SEA_OUTFALL } from '../src/pipeNetwork.js';

let failures = 0;

function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!condition) {
    failures += 1;
  }
}

function buildModel({ outfallKind = NODE_SEA_OUTFALL } = {}) {
  // Ground falls 0.5 m per manhole towards the sea; every pipe is buried
  // 0.6 m under the lid, so inverts fall the same way.
  const ground = [3.0, 2.5, 2.0, 2.5];
  const invert = ground.map((g) => g - 0.6 - 0.6);
  return {
    featureCount: 2,
    nodes: {
      count: 4,
      lat: [12.93, 12.9304, 12.9308, 12.94],
      lng: [100.88, 100.88, 100.88, 100.88],
      ground,
      invert,
      shaftM2: [1, 1, 1, 4],
      kind: [0, 0, outfallKind, 0],
      pump: [0, 0, 0, 1],
      assumedOutfall: [0, 0, 0, 0],
      street: [0, 1, 2, -1]
    },
    conduits: {
      count: 2,
      from: [0, 1],
      to: [1, 2],
      lengthM: [50, 50],
      shape: [0, 0],
      widthM: [0.6, 0.6],
      heightM: [0.6, 0.6],
      manningN: [0.013, 0.013],
      feature: [0, 1]
    },
    inlets: { count: 1, node: [0], street: [0], perimeterM: [2], openAreaM2: [0.12] },
    pumps: { count: 1, node: [3], name: ['test pump'] }
  };
}

const streets = {
  nodeCount: 3,
  lat: [12.93, 12.9304, 12.9308],
  lng: [100.88, 100.88, 100.88],
  elev: Float64Array.from([3.0, 2.5, 2.0])
};

function balance(net, spilled) {
  const t = net.totals();
  const expected = t.inflowM3 + t.backflowM3 - t.dischargedM3 - t.pumpedM3 - t.spilledM3;
  return { t, drift: Math.abs(expected - t.storedM3), spilled };
}

// --- 1. drain to a low sea --------------------------------------------------
{
  const spills = [];
  const net = createPipeNetwork({
    model: buildModel(),
    streets,
    seaLevel: () => -1,
    onSpill: (s, m3) => spills.push([s, m3])
  });
  check('stats: 4 junctions, 2 conduits, 1 sea outfall, 1 pump', net.stats.nodes === 4 && net.stats.conduits === 2 && net.stats.seaOutfalls === 1 && net.stats.pumps === 1);
  check('coverage marks the three street junctions', net.stats.coveredStreets === 3);

  const taken = net.offer(0, 2);
  check('2 m3 fits in an empty manhole', taken === 2);
  const headBefore = net.headAt(0);
  check('head rises above the invert', headBefore > 1.8, headBefore.toFixed(3));

  for (let i = 0; i < 60; i += 1) {
    net.step(60);
  }
  const { t, drift } = balance(net, spills);
  // The last few millimetres drain asymptotically (Manning flow vanishes with
  // depth), so a film stays behind - as it does in a real pipe.
  check('water reaches the sea within an hour', t.dischargedM3 > 1.8, `${t.dischargedM3.toFixed(3)} m3 discharged`);
  check('only a film is left standing', t.storedM3 < 0.2, `${t.storedM3.toFixed(3)} m3 stored`);
  check('mass balance closes', drift < 1e-6, `drift ${drift.toExponential(2)} m3`);
  check('no spill on a dry day', spills.length === 0);
}

// --- 2. a high tide flows back in and floods the street ----------------------
{
  const spills = [];
  const net = createPipeNetwork({
    model: buildModel(),
    streets,
    seaLevel: () => 2.6, // above the lid of C (2.0 m) and B (2.5 m)
    onSpill: (s, m3) => spills.push([s, m3])
  });
  for (let i = 0; i < 30; i += 1) {
    net.step(60);
  }
  const { t, drift } = balance(net, spills);
  check('the sea comes in through the outfall', t.backflowM3 > 0.5, `${t.backflowM3.toFixed(3)} m3 back`);
  check('the outfall manhole surcharges', t.surchargedNodes >= 1, `${t.surchargedNodes} surcharged`);
  const spilledOnC = spills.filter(([s]) => s === 2).reduce((sum, [, m3]) => sum + m3, 0);
  check('it spills onto the street at C', spilledOnC > 0.1, `${spilledOnC.toFixed(3)} m3 onto street 2`);
  check('mass balance closes with backflow and spill', drift < 1e-6, `drift ${drift.toExponential(2)} m3`);
  check('fill shows the outfall run full', net.fillByFeature()[1] > 0.99, net.fillByFeature()[1].toFixed(2));

  net.setSeaLevel(-1);
  const flapped = createPipeNetwork({ model: buildModel(), streets, seaLevel: () => 2.6 });
  // Flap valves are a config flag; without one the sea got in above. Here we
  // only confirm the level readout follows setSeaLevel.
  check('setSeaLevel is reported back', net.seaLevelM === -1);
  check('a fresh network starts empty', flapped.totals().storedM3 === 0);
}

// --- 3. a full manhole refuses water ------------------------------------------
{
  const net = createPipeNetwork({ model: buildModel(), streets, seaLevel: () => -1 });
  const first = net.offer(0, 1000);
  const second = net.offer(0, 1);
  check('offer is capped at the manhole capacity', first < 1000 && first > 1, `${first.toFixed(2)} m3 taken`);
  check('a full manhole takes nothing more', second === 0);
  const near = net.nearestNode(12.93, 100.88, 30);
  check('nearestNode finds A, full to the lid', near && near.node === 0 && near.surcharged && near.fill === 1, JSON.stringify(near));
}

// --- 4. a pump empties its sump ----------------------------------------------
{
  const net = createPipeNetwork({ model: buildModel(), streets, seaLevel: () => -1 });
  net.offer(3, 3); // 3 m3 in a 4 m2 sump: 0.75 m deep, above the 0.5 m start
  net.step(60);
  const t = net.totals();
  check('pump runs once the sump is deep enough', t.pumpedM3 > 0, `${t.pumpedM3.toFixed(3)} m3 pumped`);
  check('pumped water leaves the system', Math.abs(3 - t.pumpedM3 - t.storedM3) < 1e-9);
}

// --- 5. a free outfall drains regardless of the tide --------------------------
{
  const net = createPipeNetwork({ model: buildModel({ outfallKind: NODE_FREE_OUTFALL }), streets, seaLevel: () => 5 });
  net.offer(0, 2);
  for (let i = 0; i < 60; i += 1) {
    net.step(60);
  }
  const t = net.totals();
  check('free outfall ignores the sea level', t.dischargedM3 > 1.8 && t.backflowM3 === 0, `${t.dischargedM3.toFixed(3)} m3 out`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
