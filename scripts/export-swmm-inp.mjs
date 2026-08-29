// Write the drainage network out as an EPA SWMM 5 input file.
//
//   public/data/drainage-model.json  ->  swmm/pattaya.inp
//
// The point is a benchmark that isolates the pipe routing. Our streets decide
// how much water goes down each grate; this file lets EPA SWMM route that
// same water through the same pipes, so any difference in the answer is the
// routing and nothing else. Feed it the capture series our own run recorded
// (--inflows) and the two models see identical inputs.
//
// Everything is metric: SWMM reads CMS flow units as a switch into SI for
// every other quantity too, so lengths are metres and areas m^2 throughout.
//
//   node run scripts/export-swmm-inp.mjs [options]
//
//     --out <path>       where to write            (default swmm/pattaya.inp)
//     --hours <n>        simulated duration        (default 6)
//     --routing-step <s> dynamic wave step         (default 5)
//     --tide <m>         fixed stage at sea outfalls, metres MSL (default 0)
//     --inflows <path>   JSON of per-node capture, see readInflows below
//     --start <date>     DD/MM/YYYY                (default 01/01/2026)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MODEL_PATH = 'public/data/drainage-model.json';

// Our node kinds, from src/hydro/pipeNetwork.js.
const NODE_MANHOLE = 0;
const NODE_SEA_OUTFALL = 1;
const NODE_FREE_OUTFALL = 2;

// Our conduit shapes, from the same place.
const SHAPE_CIRCULAR = 0;

// A pump in our model lifts water out of a node and out of the system: there
// is nowhere for it to go, because what a station discharges into is beyond
// the surveyed network. SWMM has no such thing - a pump is a LINK - so each
// one gets a free outfall of its own to lift into, this far below its sump.
const PUMP_OUTFALL_DROP_M = 1;

// A node the survey left unconnected cannot be written: SWMM rejects a node
// with no links. Six of them exist and all six are outfalls, so nothing that
// carries water is lost.
//
// An outfall SWMM will accept has exactly one link. Ours mostly do; the one
// that does not becomes an ordinary junction with a new outfall hung off it
// over a nominal conduit this long.
const RELIEF_CONDUIT_M = 1;

function parseArgs(argv) {
  const options = {
    out: 'swmm/pattaya.inp',
    hours: 6,
    routingStep: 5,
    tide: 0,
    inflows: null,
    start: '01/01/2026'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--out': options.out = value; i += 1; break;
      case '--hours': options.hours = Number(value); i += 1; break;
      case '--routing-step': options.routingStep = Number(value); i += 1; break;
      case '--tide': options.tide = Number(value); i += 1; break;
      case '--inflows': options.inflows = value; i += 1; break;
      case '--start': options.start = value; i += 1; break;
      default:
        if (flag.startsWith('--')) {
          throw new Error(`unknown option ${flag}`);
        }
    }
  }
  return options;
}

/**
 * Per-node inflow recorded from one of our own runs, as
 *
 *   { "stepSeconds": 60, "nodes": { "<index>": [m3s, m3s, ...], ... } }
 *
 * one rate per step, in m^3/s, starting at the run's own zero. Written by the
 * benchmark harness; absent, the network is exported dry and whoever runs it
 * supplies their own rain.
 */
function readInflows(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const stepSeconds = raw.stepSeconds > 0 ? raw.stepSeconds : 60;
  const series = new Map();
  for (const [key, values] of Object.entries(raw.nodes ?? {})) {
    const node = Number(key);
    if (Number.isInteger(node) && Array.isArray(values) && values.some((v) => v > 0)) {
      series.set(node, values);
    }
  }
  return { stepSeconds, series };
}

/** SWMM wants HH:MM:SS, and will happily take more than 24 hours of it. */
function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

const round = (value, places = 3) => Number(value.toFixed(places));

function build(model, options) {
  const { nodes, conduits, pumps } = model;
  const inflows = options.inflows ? readInflows(options.inflows) : null;

  // Which nodes carry a link at all. A node with none is dropped, and so is
  // anything that would have referred to it.
  const degree = new Int32Array(nodes.count);
  for (let c = 0; c < conduits.count; c += 1) {
    degree[conduits.from[c]] += 1;
    degree[conduits.to[c]] += 1;
  }

  // A node a pump lifts out of has to be a junction: the pump is a link, and
  // an outfall SWMM will accept carries exactly one. Four of our pump stations
  // sit on nodes the survey also marked as outfalls.
  const pumpNodes = new Set();
  for (let p = 0; p < pumps.count; p += 1) {
    pumpNodes.add(pumps.node[p]);
  }

  // Which nodes SWMM will accept as outfalls, decided before anything is
  // written because the conduits have to be oriented to match.
  //
  // An outfall takes exactly one link, and that link must run INTO it. Ours
  // carry the survey's direction rather than the flow's, so a good number
  // point the wrong way and get reversed below; direction in SWMM only sets
  // the sign convention on reported flow, and dynamic wave routes either way,
  // which is what our own HGL-driven model does too.
  const isOutfallNode = new Uint8Array(nodes.count);
  for (let n = 0; n < nodes.count; n += 1) {
    const boundary = nodes.kind[n] !== NODE_MANHOLE;
    if (boundary && degree[n] === 1 && !pumpNodes.has(n)) {
      isOutfallNode[n] = 1;
    }
  }
  // A conduit cannot run from one outfall to another. Six do; the upstream
  // end of each becomes an ordinary junction with its own outfall hung off it.
  for (let c = 0; c < conduits.count; c += 1) {
    if (isOutfallNode[conduits.from[c]] && isOutfallNode[conduits.to[c]]) {
      isOutfallNode[conduits.from[c]] = 0;
    }
  }

  const name = (n) => `N${n}`;
  const junctions = [];
  const outfalls = [];
  const extraConduits = [];
  const dropped = [];

  for (let n = 0; n < nodes.count; n += 1) {
    if (degree[n] === 0) {
      dropped.push(n);
      continue;
    }

    const invert = nodes.invert[n];
    // The lid is where our model spills, so it is where SWMM should flood.
    const maxDepth = Math.max(0.3, nodes.ground[n] - invert);
    const kind = nodes.kind[n];

    if (kind === NODE_MANHOLE) {
      junctions.push({ n, invert, maxDepth });
      continue;
    }

    // A boundary node SWMM will not take as an outfall - too many links, a
    // pump about to hang off it, or another outfall on the far side of its
    // only conduit. Keep the junction where it is and hang a real outfall off
    // it over a nominal conduit, so the boundary still sits at the same place
    // and the same level.
    if (!isOutfallNode[n]) {
      junctions.push({ n, invert, maxDepth });
      const relief = `${name(n)}_OUT`;
      outfalls.push({ id: relief, invert, kind });
      extraConduits.push({
        id: `${name(n)}_REL`,
        from: name(n),
        to: relief,
        length: RELIEF_CONDUIT_M,
        // Wide enough never to be the constraint: this conduit is bookkeeping,
        // not hydraulics.
        shape: SHAPE_CIRCULAR,
        width: 2,
        height: 2,
        manningN: 0.013
      });
      continue;
    }

    outfalls.push({ id: name(n), invert, kind });
  }

  // Pumps. Each lifts into an outfall of its own, at a fixed rate, with the
  // same start/stop depths our model uses - SWMM carries that hysteresis in
  // [PUMPS] itself, so it maps across exactly.
  const pumpLinks = [];
  const pumpCurves = [];
  for (let p = 0; p < pumps.count; p += 1) {
    const n = pumps.node[p];
    if (degree[n] === 0) {
      continue;
    }
    const rated = pumps.ratedM3s[p] > 0 ? pumps.ratedM3s[p] : 1;
    const sump = `${name(n)}_PMP`;
    const curve = `PC${p}`;
    outfalls.push({ id: sump, invert: nodes.invert[n] - PUMP_OUTFALL_DROP_M, kind: NODE_FREE_OUTFALL });
    // A TYPE4 curve is flow against the depth at the inlet node. Flat, so the
    // station runs at its rated flow whenever it runs at all.
    pumpCurves.push({ curve, rated });
    pumpLinks.push({ id: `P${p}`, from: name(n), to: sump, curve });
  }

  const lines = [];
  const push = (text = '') => lines.push(text);
  const section = (title) => {
    push('');
    push(`[${title}]`);
  };

  push(';; Pattaya drainage network, exported from water-map');
  push(`;; source: ${model.source}`);
  push(`;; ${junctions.length} junctions, ${outfalls.length} outfalls, ` +
    `${conduits.count + extraConduits.length} conduits, ${pumpLinks.length} pumps`);
  push(';;');
  push(';; Inverts: 42% of them are assumed rather than surveyed, so an adverse');
  push(';; slope here is usually the assumption and not the pipe. Dynamic wave');
  push(';; routing carries them; kinematic wave would not.');

  section('OPTIONS');
  const rows = [
    ['FLOW_UNITS', 'CMS'],
    ['INFILTRATION', 'HORTON'],
    ['FLOW_ROUTING', 'DYNWAVE'],
    ['LINK_OFFSETS', 'DEPTH'],
    ['MIN_SLOPE', '0'],
    ['ALLOW_PONDING', 'NO'],
    ['SKIP_STEADY_STATE', 'NO'],
    ['START_DATE', options.start],
    ['START_TIME', '00:00:00'],
    ['REPORT_START_DATE', options.start],
    ['REPORT_START_TIME', '00:00:00'],
    ['END_DATE', options.start],
    ['END_TIME', clock(options.hours * 3600)],
    ['SWEEP_START', '01/01'],
    ['SWEEP_END', '12/31'],
    ['DRY_DAYS', '0'],
    ['REPORT_STEP', '00:01:00'],
    ['WET_STEP', '00:01:00'],
    ['DRY_STEP', '00:01:00'],
    ['ROUTING_STEP', clock(options.routingStep)],
    ['INERTIAL_DAMPING', 'PARTIAL'],
    ['NORMAL_FLOW_LIMITED', 'BOTH'],
    ['FORCE_MAIN_EQUATION', 'H-W'],
    ['VARIABLE_STEP', '0.75'],
    ['LENGTHENING_STEP', '0'],
    // Our manholes carry a 1 m^2 shaft; SWMM's default minimum surface area is
    // larger than that and would quietly give every node more storage than the
    // model it is being compared with.
    ['MIN_SURFAREA', '1.0'],
    ['MAX_TRIALS', '8'],
    ['HEAD_TOLERANCE', '0.0015'],
    ['THREADS', '4']
  ];
  for (const [key, value] of rows) {
    push(`${key.padEnd(22)}${value}`);
  }

  section('EVAPORATION');
  push('CONSTANT            0.0');
  push('DRY_ONLY            NO');

  section('JUNCTIONS');
  push(';;Name          InvertElev  MaxDepth  InitDepth  SurDepth  Aponded');
  for (const j of junctions) {
    // Surcharge depth 0 and ponded area 0: water above the lid leaves the
    // system and is reported as flooding, which is what our spill is.
    push(`${name(j.n).padEnd(15)} ${String(round(j.invert)).padEnd(11)} ` +
      `${String(round(j.maxDepth)).padEnd(9)} 0          0         0`);
  }

  section('OUTFALLS');
  push(';;Name          InvertElev  Type      StageData  Gated');
  for (const o of outfalls) {
    // A sea outfall faces the tide; anything else finds a lower level on its
    // own. Ungated throughout - Pattaya's outfalls are open, and letting the
    // sea back in is the behaviour being compared.
    const [type, stage] =
      o.kind === NODE_SEA_OUTFALL ? ['FIXED', String(round(options.tide))] : ['FREE', ''];
    push(`${o.id.padEnd(15)} ${String(round(o.invert)).padEnd(11)} ` +
      `${type.padEnd(9)} ${stage.padEnd(10)} NO`);
  }

  section('CONDUITS');
  push(';;Name          FromNode        ToNode          Length   Roughness  InOff  OutOff');
  let reversed = 0;
  for (let c = 0; c < conduits.count; c += 1) {
    let a = conduits.from[c];
    let b = conduits.to[c];
    // An outfall may only be written as the downstream end.
    if (isOutfallNode[a]) {
      [a, b] = [b, a];
      reversed += 1;
    }
    const length = String(round(conduits.lengthM[c], 2));
    push(`${`C${c}`.padEnd(15)} ${name(a).padEnd(15)} ` +
      `${name(b).padEnd(15)} ${length.padEnd(8)} ` +
      `${String(conduits.manningN[c]).padEnd(10)} 0      0`);
  }
  for (const c of extraConduits) {
    push(`${c.id.padEnd(15)} ${c.from.padEnd(15)} ${c.to.padEnd(15)} ` +
      `${String(c.length).padEnd(8)} ${String(c.manningN).padEnd(10)} 0      0`);
  }

  section('PUMPS');
  push(';;Name          FromNode        ToNode          PumpCurve  Status  Startup  Shutoff');
  for (const p of pumpLinks) {
    push(`${p.id.padEnd(15)} ${p.from.padEnd(15)} ${p.to.padEnd(15)} ` +
      `${p.curve.padEnd(10)} OFF     0.5      0.1`);
  }

  section('XSECTIONS');
  push(';;Link          Shape         Geom1    Geom2   Geom3  Geom4  Barrels');
  for (let c = 0; c < conduits.count; c += 1) {
    const circular = conduits.shape[c] === SHAPE_CIRCULAR;
    const shape = circular ? 'CIRCULAR' : 'RECT_CLOSED';
    // Circular carries the diameter in Geom1; a box carries height then width.
    const g1 = circular ? conduits.widthM[c] : conduits.heightM[c];
    const g2 = circular ? 0 : conduits.widthM[c];
    push(`${`C${c}`.padEnd(15)} ${shape.padEnd(13)} ${String(round(g1)).padEnd(8)} ` +
      `${String(round(g2)).padEnd(7)} 0      0      1`);
  }
  for (const c of extraConduits) {
    push(`${c.id.padEnd(15)} ${'CIRCULAR'.padEnd(13)} ${String(c.width).padEnd(8)} 0       0      0      1`);
  }

  section('CURVES');
  push(';;Name          Type     X-Value  Y-Value');
  for (const { curve, rated } of pumpCurves) {
    // Two points, same flow: a station that runs at its rated rate whatever
    // the sump is doing, which is the rule our model applies.
    push(`${curve.padEnd(15)} PUMP4    0        ${round(rated)}`);
    push(`${curve.padEnd(15)}          100      ${round(rated)}`);
  }

  if (inflows) {
    section('INFLOWS');
    push(';;Node          Constituent  TimeSeries      Type     Mfactor  Sfactor');
    for (const node of inflows.series.keys()) {
      push(`${name(node).padEnd(15)} FLOW         ${`TS${node}`.padEnd(15)} FLOW     1.0      1.0`);
    }

    section('TIMESERIES');
    push(';;Name          Time       Value');
    for (const [node, values] of inflows.series) {
      for (let i = 0; i < values.length; i += 1) {
        push(`${`TS${node}`.padEnd(15)} ${clock(i * inflows.stepSeconds).padEnd(10)} ${round(values[i], 5)}`);
      }
    }
  }

  section('REPORT');
  push('INPUT               NO');
  push('CONTROLS            NO');
  push('SUBCATCHMENTS       NONE');
  push('NODES               ALL');
  push('LINKS               ALL');

  section('COORDINATES');
  push(';;Node          X-Coord     Y-Coord');
  // Longitude and latitude straight through. The map is only for the GUI -
  // every length the model routes on comes from the survey, not from these.
  for (const j of junctions) {
    push(`${name(j.n).padEnd(15)} ${nodes.lng[j.n].toFixed(6)}  ${nodes.lat[j.n].toFixed(6)}`);
  }
  for (const o of outfalls) {
    const base = Number(o.id.replace(/^N/, '').replace(/_.*$/, ''));
    if (Number.isInteger(base)) {
      push(`${o.id.padEnd(15)} ${nodes.lng[base].toFixed(6)}  ${nodes.lat[base].toFixed(6)}`);
    }
  }

  push('');
  return {
    text: lines.join('\n'),
    counts: {
      junctions: junctions.length,
      outfalls: outfalls.length,
      conduits: conduits.count + extraConduits.length,
      pumps: pumpLinks.length,
      dropped: dropped.length,
      reversed,
      inflowNodes: inflows ? inflows.series.size : 0
    }
  };
}

const options = parseArgs(process.argv.slice(2));
const model = JSON.parse(readFileSync(MODEL_PATH, 'utf8'));
const { text, counts } = build(model, options);

const out = resolve(options.out);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text, 'utf8');

console.log(`wrote ${options.out}`);
console.log(`  junctions   ${counts.junctions}`);
console.log(`  outfalls    ${counts.outfalls}  (incl. one per pump)`);
console.log(`  conduits    ${counts.conduits}`);
console.log(`  pumps       ${counts.pumps}`);
console.log(`  dropped     ${counts.dropped} unconnected nodes`);
console.log(`  reversed    ${counts.reversed} conduits, to point into their outfall`);
console.log(`  inflows     ${counts.inflowNodes} nodes`);
