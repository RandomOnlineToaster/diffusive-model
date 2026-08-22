import L from 'leaflet';
import { config } from './config.js';

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
export function populateFlowPathLayer(group, flowDirection, flowAccumulation, options = {}) {
  const {
    minUpstream = config.flowPathMinUpstream,
    maxSteps = config.flowPathSteps,
    animate = config.flowPathAnimate,
    cellAreaM2 = 0,
    // Set when the accumulation carries surface water in mm rather than cell
    // counts; tooltips then report real volumes.
    rainMode = false
  } = options;

  group.clearLayers();

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
    return L.layerGroup([]);
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

  const renderer = animate ? L.svg({ padding: 0.3 }) : L.canvas({ padding: 0.3 });

  for (const line of lines) {
    group.addLayer(
      L.polyline(line.points, {
        renderer,
        className: animate ? 'flow-path flow-path--animated' : 'flow-path',
        color: ACCUMULATION_COLORS[line.colorClass],
        weight: 1.1 + line.colorClass * 0.5,
        opacity: 0.9
      }).bindTooltip(describeFlow(line.value, cellAreaM2, rainMode), { sticky: true })
    );
  }

  return group;
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
