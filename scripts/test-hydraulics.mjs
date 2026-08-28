// Sanity checks for src/hydro/hydraulics.js against textbook values.
//
// Run: node scripts/test-hydraulics.mjs
// No framework - each check prints its numbers, and the process exits 1 if
// any is outside tolerance, so it doubles as a worked example of the formulas.

import {
  boxSection,
  circularSection,
  equalisingVolume,
  fullFlowCapacity,
  harmonicTide,
  hortonRate,
  inletCapture,
  manningFlow,
  pumpDischarge,
  SHAPE_BOX,
  SHAPE_CIRCULAR,
  stormSteering
} from '../src/hydro/hydraulics.js';

let failures = 0;

function check(label, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= tolerance;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual.toFixed(4)} (expected ${expected} +/- ${tolerance})`);
  if (!ok) {
    failures += 1;
  }
}

// A full 0.60 m pipe: area pi r^2, R = D/4.
const full = circularSection(0.6, 0.6);
check('full Ø0.60 area', full.area, 0.2827, 0.001);
check('full Ø0.60 hydraulic radius', full.hydraulicRadius, 0.15, 0.001);

// Half full: half the area, R = D/4 as well (a known property of the half circle).
const half = circularSection(0.6, 0.3);
check('half-full Ø0.60 area', half.area, 0.1414, 0.001);
check('half-full Ø0.60 hydraulic radius', half.hydraulicRadius, 0.15, 0.001);
check('half-full Ø0.60 top width', half.topWidth, 0.6, 0.001);

// A 2 x 2 box culvert half full: A = 2 x 1, P = 2 + 2 x 1.
const box = boxSection(2, 2, 1);
check('2x2 box half-full area', box.area, 2, 1e-9);
check('2x2 box half-full hydraulic radius', box.hydraulicRadius, 0.5, 1e-9);

// Manning: a concrete Ø0.60 at 0.3% carries about 0.34 m3/s running full.
check('Ø0.60 concrete at 0.3% full-flow capacity', fullFlowCapacity(SHAPE_CIRCULAR, 0.6, 0.6, 0.013, 0.003), 0.336, 0.005);
// ...and a 2 x 2 box at 0.1% about 11 m3/s.
check('2x2 box concrete at 0.1% capacity', fullFlowCapacity(SHAPE_BOX, 2, 2, 0.013, 0.001), 6.13, 0.05);
check('manningFlow matches capacity', manningFlow(full.area, full.hydraulicRadius, 0.003, 0.013), 0.336, 0.005);

// Inlet: a 0.4 x 0.6 grate under 5 cm of water passes ~37 L/s as a weir,
// which is below its ~80 L/s orifice figure, so the weir governs.
const grate = { perimeterM: 2 * (0.4 + 0.6), openAreaM2: 0.4 * 0.6 * 0.5 };
check('grate at 5 cm (weir governs)', inletCapture({ depthM: 0.05, ...grate }), 0.0371, 0.001);
check('grate at 5 cm, half clogged', inletCapture({ depthM: 0.05, ...grate, clogging: 0.5 }), 0.0186, 0.001);
// Deep water: the orifice governs (A sqrt(2 g d) grows slower than d^1.5).
check('grate at 50 cm (orifice governs)', inletCapture({ depthM: 0.5, ...grate }), 0.2519, 0.002);
check('dry grate', inletCapture({ depthM: 0, ...grate }), 0, 0);

// Horton: starts at f0, halfway to fc after ln(2)/k, ends at fc.
check('Horton at t = 0', hortonRate({ f0: 60, fc: 12, k: 2 / 3600, wetSeconds: 0 }), 60, 1e-9);
check('Horton after one half-life', hortonRate({ f0: 60, fc: 12, k: 2 / 3600, wetSeconds: (Math.LN2 * 3600) / 2 }), 36, 1e-6);
check('Horton after a long time', hortonRate({ f0: 60, fc: 12, k: 2 / 3600, wetSeconds: 1e7 }), 12, 1e-6);

// Tide: bounded by the sum of amplitudes, and mean-zero over a long window.
let peak = -Infinity;
let trough = Infinity;
let sum = 0;
const samples = 24 * 60;
for (let i = 0; i < samples; i += 1) {
  const level = harmonicTide(i * 3.6e6);
  peak = Math.max(peak, level);
  trough = Math.min(trough, level);
  sum += level;
}
check('harmonic tide peak below sum of amplitudes', peak <= 1.25 ? 1 : 0, 1, 0);
check('harmonic tide has a range of 1.5-2.5 m', peak - trough, 2, 0.5);
check('harmonic tide is mean-zero', sum / samples, 0, 0.02);

// Pump hysteresis: off below start, on above it, stays on until below stop.
let pump = pumpDischarge({ depthM: 0.3, startDepthM: 0.5, stopDepthM: 0.1, ratedM3s: 1, running: false });
check('pump stays off below start level', pump.rateM3s, 0, 0);
pump = pumpDischarge({ depthM: 0.6, startDepthM: 0.5, stopDepthM: 0.1, ratedM3s: 1, running: pump.running });
check('pump starts above start level', pump.rateM3s, 1, 0);
pump = pumpDischarge({ depthM: 0.3, startDepthM: 0.5, stopDepthM: 0.1, ratedM3s: 1, running: pump.running });
check('pump keeps running between stop and start', pump.rateM3s, 1, 0);
pump = pumpDischarge({ depthM: 0.05, startDepthM: 0.5, stopDepthM: 0.1, ratedM3s: 1, running: pump.running });
check('pump stops below stop level', pump.rateM3s, 0, 0);

// Wind from the south-west (225°) pushes a cell towards the north-east (45°).
const drift = stormSteering({ speedMs: 10, directionFromDeg: 225, factor: 0.75 });
check('storm drifts north-east: east component', drift.east, 5.303, 0.01);
check('storm drifts north-east: north component', drift.north, 5.303, 0.01);
check('storm bearing', drift.bearingDeg, 45, 1e-9);

// Two equal tanks 1 m apart level out after half the head moves across.
check('equalising volume, equal tanks', equalisingVolume(1, 10, 10), 5, 1e-9);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
