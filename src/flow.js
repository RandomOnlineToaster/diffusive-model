import L from 'leaflet';
import { config } from './config.js';
import { createChainParticleLayer } from './flowParticles.js';

// Flow layers are derived from the analysis grid, which is far denser than the
// map can draw one marker per cell. Both layers therefore reduce the data
// before rendering: arrows are thinned spatially, and accumulation is cut to
// the high-flow cells that actually form the drainage network.

const MAX_NETWORK_MARKERS = 4000;

// Bearing per D8 direction, measured clockwise from north.
const DIRECTION_ANGLES = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315
};

// Arrows are drawn on canvas rather than as one DOM marker each. As markers,
// 351 arrows cost more than half the frame budget while zooming; on canvas the
// whole layer is a single element.
//
// Each arrow is one polyline: tail -> tip -> barb -> tip -> barb. Size is set in
// degrees rather than pixels, so an arrow keeps covering the grid cells it
// represents at every zoom level.
function arrowPoints(center, direction, length) {
  const angle = DIRECTION_ANGLES[direction];
  if (angle === undefined) {
    return null;
  }

  const offset = (bearing, distance) => {
    const radians = (bearing * Math.PI) / 180;
    return [Math.cos(radians) * distance, Math.sin(radians) * distance];
  };

  const [lat, lng] = center;
  const [headLat, headLng] = offset(angle, length / 2);
  const tip = [lat + headLat, lng + headLng];
  const tail = [lat - headLat, lng - headLng];
  const [leftLat, leftLng] = offset(angle + 150, length * 0.42);
  const [rightLat, rightLng] = offset(angle - 150, length * 0.42);

  return [
    tail,
    tip,
    [tip[0] + leftLat, tip[1] + leftLng],
    tip,
    [tip[0] + rightLat, tip[1] + rightLng]
  ];
}

export function createFlowDirectionLayer(flowDirection, { cellSizeDegrees = 0 } = {}) {
  const arrows = thinBySpacing(flowDirection, config.flowArrowCount);
  const step = thinningStep(flowDirection.length, config.flowArrowCount);
  // Fill most of the gap between sampled cells without arrows touching.
  const length = (cellSizeDegrees || 0.002) * step * 0.7;
  const renderer = L.canvas({ padding: 0.3 });

  const shapes = arrows
    .filter((item) => item.direction !== 'Flat')
    .map((item) => {
      const points = arrowPoints(item.center, item.direction, length);
      if (!points) {
        return null;
      }

      return L.polyline(points, {
        renderer,
        color: '#1d4ed8',
        weight: 1.4,
        opacity: 0.85
      }).bindTooltip(`Flow direction: ${item.direction}`, { sticky: true });
    })
    .filter(Boolean);

  return L.layerGroup(shapes);
}

function thinningStep(total, targetCount) {
  if (targetCount <= 0 || total <= targetCount) {
    return 1;
  }

  return Math.max(1, Math.round(Math.sqrt(total / targetCount)));
}

export function createFlowAccumulationLayer(flowAccumulation) {
  const group = L.layerGroup();
  populateFlowAccumulationLayer(group, flowAccumulation);
  return group;
}

// Rebuilds the markers inside an existing group, so the layer-control
// checkbox keeps pointing at the same layer while its content switches
// between uniform terrain accumulation and rainfall-weighted accumulation -
// the same arrangement the flow-path layer uses.
export function populateFlowAccumulationLayer(group, flowAccumulation, options = {}) {
  const { rainMode = false, cellAreaM2 = 0, minValue = 0 } = options;

  group.clearLayers();

  // Uniform mode keeps the percentile cut; rain mode uses the absolute
  // threshold shared with the flow paths, so the network visibly thins as
  // the storm's water drains away.
  const network = rainMode
    ? selectAboveThreshold(flowAccumulation, minValue)
    : selectDrainageNetwork(flowAccumulation, config.flowNetworkPercentile);

  if (network.length === 0) {
    return group;
  }

  const maxAccumulation = network[0].accumulationIndex;
  const minAccumulation = network[network.length - 1].accumulationIndex;

  for (const item of network) {
    group.addLayer(
      L.circleMarker(item.center, {
        // Radius tracks how much upstream area drains through the cell. It
        // used to track the array index, which made later cells absurdly big.
        radius: scaleRadius(item.accumulationIndex, minAccumulation, maxAccumulation),
        color: rainMode ? '#1e3a8a' : '#134e4a',
        weight: 1,
        fillColor: rainMode ? '#3b82f6' : '#14b8a6',
        fillOpacity: 0.35
      }).bindTooltip(
        rainMode && cellAreaM2 > 0
          ? `Storm water: ~${Math.round(
              (item.accumulationIndex * cellAreaM2) / 1000
            ).toLocaleString()} m\u00b3 through here`
          : `Upstream cells: ${Math.round(item.accumulationIndex).toLocaleString()}`
      )
    );
  }

  return group;
}

// Every cell carrying at least the threshold, largest first, capped the same
// way the percentile cut is.
function selectAboveThreshold(flowAccumulation, minValue) {
  return flowAccumulation
    .filter((item) => Number.isFinite(item.accumulationIndex) && item.accumulationIndex >= minValue)
    .sort((a, b) => b.accumulationIndex - a.accumulationIndex)
    .slice(0, MAX_NETWORK_MARKERS);
}

// Keep an evenly spread subset rather than the first N, so arrows still cover
// the whole province.
function thinBySpacing(items, targetCount) {
  if (targetCount <= 0) {
    return [];
  }

  if (items.length <= targetCount) {
    return items;
  }

  const positioned = items.filter(
    (item) => Number.isFinite(item.row) && Number.isFinite(item.column)
  );

  if (positioned.length === 0) {
    const step = Math.ceil(items.length / targetCount);
    return items.filter((_, index) => index % step === 0);
  }

  const step = thinningStep(positioned.length, targetCount);
  // Offset to the middle of each sampling block, so arrows sit centred in the
  // area they represent rather than hugging its top-left corner.
  const offset = Math.floor(step / 2);
  return positioned.filter(
    (item) => item.row % step === offset && item.column % step === offset
  );
}

// The drainage network is the small fraction of cells with the most upstream
// area. Everything below the cutoff is hillslope and would just be noise.
function selectDrainageNetwork(flowAccumulation, percentile) {
  const usable = flowAccumulation.filter((item) =>
    Number.isFinite(item.accumulationIndex)
  );

  if (usable.length === 0) {
    return [];
  }

  const sorted = [...usable].sort((a, b) => b.accumulationIndex - a.accumulationIndex);
  const keepCount = Math.max(
    1,
    Math.min(MAX_NETWORK_MARKERS, Math.round(sorted.length * (1 - percentile)))
  );

  return sorted.slice(0, keepCount);
}

/**
 * The accumulation a cell needs to make the drainage network: the value of
 * the last cell the percentile cut keeps. Lets a rain-weighted view keep the
 * uniform view's density while the rain shapes which cells make it.
 */
export function drainageCutoff(flowAccumulation, percentile) {
  const network = selectDrainageNetwork(flowAccumulation, percentile);
  return network.length > 0 ? network[network.length - 1].accumulationIndex : 0;
}

function scaleRadius(value, minValue, maxValue) {
  if (!(maxValue > minValue)) {
    return 4;
  }

  // Accumulation spans orders of magnitude, so compare on a log scale.
  const ratio =
    (Math.log(value + 1) - Math.log(minValue + 1)) /
    (Math.log(maxValue + 1) - Math.log(minValue + 1));

  return 2.5 + ratio * 6.5;
}

// Flow as a drainage network instead of per-cell arrows.
//
// Tracing a full path from every seed redraws shared channels once per
// tributary, so the main stems pile up into solid blocks and the dash phases
// cancel out. Instead each cell is drawn at most once: lines run from a
// headwater to the first cell already covered, so the result is a tree with no
// overdraw. Lines also break where the accumulation class changes, which is
// what lets each piece carry its own colour.

export const ACCUMULATION_COLORS = ['#16a34a', '#84cc16', '#eab308', '#f97316', '#dc2626'];

// Accumulation spans orders of magnitude, so classify on a log scale. Shared
// with the street-flow layer so both read on the same colour scale.
export function accumulationClassifier(minimum, peak) {
  const logMin = Math.log(minimum + 1);
  const logMax = Math.log(peak + 1);

  return (value) => {
    if (!(logMax > logMin)) {
      return 0;
    }

    const ratio = (Math.log((value || 0) + 1) - logMin) / (logMax - logMin);
    return Math.max(
      0,
      Math.min(ACCUMULATION_COLORS.length - 1, Math.floor(ratio * ACCUMULATION_COLORS.length))
    );
  };
}

export function createFlowPathLayer(flowDirection, flowAccumulation, options = {}) {
  const group = L.layerGroup();
  populateFlowPathLayer(group, flowDirection, flowAccumulation, options);
  return group;
}

// Rebuilds the lines inside an existing group, so the layer-control checkbox
// keeps pointing at the same layer while its content switches between uniform
// terrain accumulation and rainfall-weighted accumulation.
// ONE canvas renderer for every flow line on the map, created on first use
// and kept for the session.
//
// One, for two reasons. Creating a renderer per populate call leaked one per
// call - Leaflet adds a renderer to the map the first time a path uses it and
// removing the paths later does not remove it, so an hour of rain stranded
// hundreds of them, each still re-projecting itself on every pan and zoom.
// And one per LAYER is not enough either: stacked canvas renderers swallow
// each other's pointer events - the topmost canvas receives the DOM event and
// hit-tests only its own paths - so whichever flow layer was added later left
// the other's tooltips dead. On a single canvas every flow line shares one
// hit test.
let sharedFlowRenderer = null;

export function flowLineRenderer() {
  if (!sharedFlowRenderer) {
    // tolerance widens the hover hit area (px): the strokes are thin, and on
    // canvas an exact hover was needed to read a tooltip.
    sharedFlowRenderer = L.canvas({ padding: 0.3, tolerance: 8 });
  }

  return sharedFlowRenderer;
}

// And one stream layer per group, likewise for its lifetime: the particles
// that ride the drawn lines downstream. Same visual language as Street Flow -
// solid colour for how much water, moving trails for which way.
const groupStreams = new WeakMap();

function streamsFor(group, animate) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (!animate || reduced) {
    return null;
  }

  let streams = groupStreams.get(group);
  if (!streams) {
    streams = createChainParticleLayer({ isDark: (name) => name === 'Satellite' });
    groupStreams.set(group, streams);
  }
  if (!group.hasLayer(streams)) {
    group.addLayer(streams);
  }

  return streams;
}

export function populateFlowPathLayer(group, flowDirection, flowAccumulation, options = {}) {
  const {
    minUpstream = config.flowPathMinUpstream,
    maxSteps = config.flowPathSteps,
    animate = config.flowPathAnimate,
    cellAreaM2 = 0,
    // Set when the accumulation carries surface water in mm rather than cell
    // counts; tooltips then report real volumes.
    rainMode = false,
    // Shift + tick: the original dashed-line rendering instead of particles.
    classic = false
  } = options;

  // Drop the drawn lines but keep the stream layer between refreshes, the
  // way the street layer does: removing it too would tear down and rebuild
  // its canvas on every storm refresh.
  const streams = streamsFor(group, animate);
  // Shift + tick: the classic marching dashes, drawn by the same layer.
  streams?.setMode(classic ? 'dash' : 'trail');
  const stale = [];
  group.eachLayer((layer) => {
    if (layer !== streams) {
      stale.push(layer);
    }
  });
  for (const layer of stale) {
    group.removeLayer(layer);
  }
  streams?.setLines([]);

  if (flowDirection.length === 0 || flowAccumulation.length === 0) {
    return group;
  }

  const byIndex = new Map(flowDirection.map((item) => [item.index, item]));
  const accumulation = new Map(
    flowAccumulation.map((item) => [item.index, item.accumulationIndex])
  );

  // Only cells carrying real upstream area are channels; the rest is hillslope
  // noise, which is what made the layer unreadable.
  const channel = flowDirection.filter((item) => (accumulation.get(item.index) || 0) >= minUpstream);

  if (channel.length === 0) {
    return group;
  }

  let peak = 0;
  for (const item of channel) {
    peak = Math.max(peak, accumulation.get(item.index) || 0);
  }

  const classOf = accumulationClassifier(minUpstream, peak);

  // Headwaters first, so downstream trunks are already covered when tributaries
  // reach them and each line stops cleanly at a junction.
  channel.sort((a, b) => (accumulation.get(a.index) || 0) - (accumulation.get(b.index) || 0));

  const drawn = new Set();
  const lines = [];

  for (const seed of channel) {
    if (drawn.has(seed.index)) {
      continue;
    }

    let current = seed;
    let currentClass = classOf(accumulation.get(seed.index));
    let points = [seed.center];
    let peakHere = accumulation.get(seed.index) || 0;
    drawn.add(seed.index);

    for (let step = 0; step < maxSteps; step += 1) {
      const next = byIndex.get(current.downstreamIndex);
      if (!next) {
        break;
      }

      const nextValue = accumulation.get(next.index) || 0;
      points.push(next.center);
      peakHere = Math.max(peakHere, nextValue);

      const nextClass = classOf(nextValue);
      const alreadyDrawn = drawn.has(next.index);

      if (nextClass !== currentClass && !alreadyDrawn) {
        // Close this piece and start the next one at the same point, so the
        // colours change without leaving a gap.
        lines.push({ points, value: peakHere, colorClass: currentClass });
        points = [next.center];
        peakHere = nextValue;
        currentClass = nextClass;
      }

      if (alreadyDrawn) {
        break;
      }

      drawn.add(next.index);
      current = next;
    }

    if (points.length > 1) {
      lines.push({ points, value: peakHere, colorClass: currentClass });
    }
  }

  addLinesByClass(group, lines, {
    renderer: flowLineRenderer(),
    className: 'flow-path',
    weightFor: (colorClass) => 1.1 + colorClass * 0.5,
    describe: (line) => describeFlow(line.value, cellAreaM2, rainMode),
    // With the particle layer running it IS the layer - trails, or the
    // classic dashes - as it is for Flow Direction; the lines stay only as
    // hover targets. Without it (animation off, reduced motion) the solid
    // colour-classed lines are drawn instead.
    drawn: !streams
  });

  // Lines run headwater -> downstream, so the streams flow downhill.
  streams?.setLines(lines);

  return group;
}

// Draw the traced lines as ONE polyline per colour class rather than one per
// channel.
//
// Every line in a class already shares its colour and its weight, so a class
// can be a single path holding many subpaths - the picture is identical. What
// changes is the cost of animating it: `stroke-dashoffset` is not a
// compositable property, so the browser recalculates style and repaints once
// per animated ELEMENT on every frame. Measured on this map, 410 separate
// paths spent 23% of the main thread on style recalculation alone and dropped
// the page to 44 fps; the same geometry as five paths does not. It also makes
// a rebuild far cheaper, which is what the street layer does every couple of
// seconds while the rainfall simulator runs.
//
// The per-channel readout survives the merge by finding the nearest drawn
// vertex to the pointer, instead of relying on one element per channel.
export function addLinesByClass(
  group,
  lines,
  { renderer, className, weightFor, describe, drawn = true }
) {
  const byClass = new Map();

  for (const line of lines) {
    const bucket = byClass.get(line.colorClass);
    if (bucket) {
      bucket.push(line);
    } else {
      byClass.set(line.colorClass, [line]);
    }
  }

  // Ascending, so the busiest channels are drawn last and stay on top - the
  // stacking one-line-per-channel used to get from the traversal order.
  const classes = [...byClass.keys()].sort((a, b) => a - b);

  for (const colorClass of classes) {
    const bucket = byClass.get(colorClass);
    const polyline = L.polyline(
      bucket.map((line) => line.points),
      {
        renderer,
        className,
        color: ACCUMULATION_COLORS[colorClass],
        weight: weightFor(colorClass),
        // When the stream particles carry the layer, the lines are not drawn
        // at all: stroke:false skips rasterising them rather than painting
        // them invisibly. They stay on the map as hover targets, so the
        // per-channel tooltips keep working.
        stroke: drawn,
        opacity: 0.9
      }
    );

    // Built on the first hover rather than here: while a storm runs, this
    // layer is rebuilt far more often than anyone hovers it.
    let findNearest = null;
    let shownLine = null;
    const retarget = (event) => {
      if (!findNearest) {
        findNearest = createNearestLineFinder(bucket);
      }

      // Rewrite the tooltip only when the nearest channel actually changes;
      // mousemove fires continuously and the DOM write is the expensive part.
      const line = findNearest(event.latlng.lat, event.latlng.lng);
      if (line && line !== shownLine) {
        shownLine = line;
        polyline.setTooltipContent(describe(line));
      }
    };

    polyline.bindTooltip(describe(bucket[0]), { sticky: true });
    polyline.on('mouseover', retarget);
    polyline.on('mousemove', retarget);
    group.addLayer(polyline);
  }

  return group;
}

// Nearest line to a point, by vertex, over a flat copy of the geometry: a
// typed-array scan beats walking the line objects, and the whole layer is only
// a few tens of thousands of vertices.
function createNearestLineFinder(lines) {
  let total = 0;
  for (const line of lines) {
    total += line.points.length;
  }

  const lats = new Float64Array(total);
  const lngs = new Float64Array(total);
  const owner = new Int32Array(total);
  let at = 0;

  for (let index = 0; index < lines.length; index += 1) {
    for (const point of lines[index].points) {
      lats[at] = point[0];
      lngs[at] = point[1];
      owner[at] = index;
      at += 1;
    }
  }

  return (lat, lng) => {
    // Degrees of longitude shrink towards the poles; without this the search
    // is biased east-west. Squared distance is enough to rank.
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let best = -1;
    let bestDistance = Infinity;

    for (let i = 0; i < total; i += 1) {
      const dy = lats[i] - lat;
      const dx = (lngs[i] - lng) * cosLat;
      const distance = dy * dy + dx * dx;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = owner[i];
      }
    }

    return best < 0 ? null : lines[best];
  };
}

function describeFlow(upstreamCells, cellAreaM2, rainMode) {
  // Rain mode: accumulation is surface water in mm summed over cells, so
  // depth/1000 x cell area is the volume passing through.
  if (rainMode && cellAreaM2 > 0) {
    const volumeM3 = (upstreamCells * cellAreaM2) / 1000;
    return `Storm water: ~${Math.round(volumeM3).toLocaleString()} m³ through here`;
  }

  const cells = `${Math.round(upstreamCells).toLocaleString()} upstream cells`;
  if (!cellAreaM2) {
    return cells;
  }

  const areaKm2 = (upstreamCells * cellAreaM2) / 1e6;
  return `${cells}<br>Drains ~${areaKm2.toFixed(areaKm2 < 10 ? 1 : 0)} km²`;
}
