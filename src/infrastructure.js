import L from 'leaflet';
import { PIPE_SENSOR_ICON, ROAD_SENSOR_ICON, WATER_GATE_ICON } from './mapIcons.js';
import { MARKER_OPTIONS, POPUP_OPTIONS, bindHoverTip, detailPopup, escapeHtml } from './mapPopup.js';

// Water infrastructure layers.
//
// Rivers come from real OpenStreetMap data when public/data/chonburi-rivers.geojson
// exists (produced by `npm run fetch:rivers`), and fall back to demo geometry
// otherwise. Water gates and underground pipes are still placeholders: no open
// dataset covers them for Chon Buri, so they mark where real data plugs in.

const placeholder = (text) => `<span class="layer-placeholder">${text}</span>`;
const PLACEHOLDER_RIVERS_LABEL = placeholder('Rivers & Canals');
const PLACEHOLDER_GATES_LABEL = placeholder('Water Gates');
const PLACEHOLDER_BODIES_LABEL = placeholder('Lakes & Reservoirs');

const RIVER_DATA_URL = '/data/chonburi-rivers.geojson';
const PATTAYA_PIPE_URL = '/data/pattaya-pipes.geojson';
const PATTAYA_STATION_URL = '/data/pattaya-stations.geojson';
const WATER_GATE_DATA_URL = '/data/chonburi-water-gates.geojson';
const WATER_BODY_DATA_URL = '/data/chonburi-water-bodies.geojson';

// Thinner, paler lines for the smaller channels so the main rivers stay readable.
const WATERWAY_STYLES = {
  river: { color: '#0369a1', weight: 2.2, opacity: 0.9 },
  canal: { color: '#0891b2', weight: 1.8, opacity: 0.85 },
  stream: { color: '#38bdf8', weight: 1.1, opacity: 0.75 },
  drain: { color: '#94a3b8', weight: 1, opacity: 0.7, dashArray: '4 4' }
};

const DEFAULT_WATERWAY_STYLE = { color: '#0284c7', weight: 1.4, opacity: 0.8 };

const DEMO_RIVERS = [
  {
    name: 'Demo tributary (no OSM data downloaded)',
    points: [
      [13.53, 101.08],
      [13.44, 101.02],
      [13.35, 100.99],
      [13.27, 100.97]
    ]
  }
];

const DEMO_WATER_GATES = [
  { name: 'Khlong Yai water gate (demo)', position: [13.28, 100.98] },
  { name: 'Nong Mai Daeng gate (demo)', position: [13.38, 101.02] },
  { name: 'Ban Bueng regulator (demo)', position: [13.31, 101.11] }
];

export async function createRiverLayer({ isInside } = {}) {
  const raw = await loadRiverData();
  const data = isInside ? clipToBoundary(raw, isInside) : raw;

  if (!data || !Array.isArray(data.features) || data.features.length === 0) {
    return {
      layer: L.layerGroup(
        DEMO_RIVERS.map((river) =>
          L.polyline(river.points, DEFAULT_WATERWAY_STYLE).bindTooltip(river.name)
        )
      ),
      label: PLACEHOLDER_RIVERS_LABEL
    };
  }

  // Nearly 2,000 lines and 85k vertices: canvas keeps panning smooth where
  // one SVG path per line would not.
  const renderer = L.canvas({ padding: 0.3 });

  const layer = L.geoJSON(data, {
    renderer,
    style: (feature) => ({
      renderer,
      ...(WATERWAY_STYLES[feature.properties?.waterway] || DEFAULT_WATERWAY_STYLE)
    }),
    onEachFeature: (feature, featureLayer) => {
      featureLayer.bindTooltip(describeWaterway(feature.properties), { sticky: true });
    }
  });

  return {
    layer,
    label: 'Rivers & Canals'
  };
}

export async function createWaterGateLayer({ isInside } = {}) {
  const data = await loadJSON(WATER_GATE_DATA_URL);
  const features = (data?.features || []).filter(
    (feature) =>
      !isInside || isInside(feature.geometry.coordinates[1], feature.geometry.coordinates[0])
  );

  if (features.length === 0) {
    return {
      layer: L.layerGroup(
        DEMO_WATER_GATES.map((gate) => waterGateMarker(gate.position, gate.name, 'demo', 'placeholder'))
      ),
      label: PLACEHOLDER_GATES_LABEL
    };
  }

  return {
    layer: L.layerGroup(
      features.map((feature) =>
        waterGateMarker(
          [feature.geometry.coordinates[1], feature.geometry.coordinates[0]],
          feature.properties.name || 'Unnamed water gate',
          feature.properties.gateType,
          'OpenStreetMap',
          feature.properties.operator
        )
      )
    ),
    label: 'Water Gates'
  };
}

export async function createWaterBodyLayer({ isInside } = {}) {
  const data = await loadJSON(WATER_BODY_DATA_URL);
  const features = (data?.features || []).filter((feature) => {
    if (!isInside) {
      return true;
    }

    // Kept or dropped whole rather than split, because cutting a lake at the
    // border would misreport its area. A water body straddling the boundary
    // still counts, so the test is centroid OR any part of the outline: on
    // centroid alone, anything half outside vanished entirely.
    const ring = feature.geometry.coordinates[0];
    const [lat, lng] = ringCentroid(ring);
    return isInside(lat, lng) || ringTouchesInside(ring, isInside);
  });

  if (features.length === 0) {
    return { layer: L.layerGroup([]), label: PLACEHOLDER_BODIES_LABEL };
  }

  const renderer = L.canvas({ padding: 0.3 });

  return {
    layer: L.geoJSON({ type: 'FeatureCollection', features }, {
      renderer,
      style: () => ({
        renderer,
        color: '#0369a1',
        weight: 1,
        fillColor: '#38bdf8',
        fillOpacity: 0.45
      }),
      onEachFeature: (feature, featureLayer) => {
        const { name, waterType, areaM2 } = feature.properties;
        featureLayer.bindTooltip(
          `${name || 'Unnamed ' + waterType}<br>Type: ${waterType}<br>Area: ${(areaM2 / 10000).toFixed(1)} ha`,
          { sticky: true }
        );
      }
    }),
    label: 'Lakes & Reservoirs'
  };
}

function waterGateMarker(position, name, gateType, source, operator = null) {
  const marker = L.marker(position, { ...MARKER_OPTIONS, icon: WATER_GATE_ICON });
  bindHoverTip(marker, escapeHtml(name), { offsetY: -12 });
  marker.bindPopup(
    () =>
      detailPopup({
        title: name,
        rows: [
          ['Type', gateType ? escapeHtml(gateType) : null],
          ['Operator', operator ? escapeHtml(operator) : null]
        ],
        source: escapeHtml(source)
      }),
    POPUP_OPTIONS
  );
  return marker;
}

// Sampled rather than exhaustive: big reservoirs carry thousands of vertices
// and only need enough coverage to notice they reach across the line.
function ringTouchesInside(ring, isInside) {
  const step = Math.max(1, Math.floor(ring.length / 64));

  for (let index = 0; index < ring.length; index += step) {
    const [lng, lat] = ring[index];
    if (isInside(lat, lng)) {
      return true;
    }
  }

  return false;
}

function ringCentroid(ring) {
  let lat = 0;
  let lng = 0;
  for (const [pointLng, pointLat] of ring) {
    lat += pointLat;
    lng += pointLng;
  }
  return [lat / ring.length, lng / ring.length];
}

// Pattaya municipal drainage network, exported from the SMART GIS database.
// Real engineered pipes and the sensor stations on them, unlike the OSM layers
// which only cover open waterways.
export async function createPipeNetworkLayer() {
  const data = await loadJSON(PATTAYA_PIPE_URL);
  const features = data?.features || [];

  if (features.length === 0) {
    return { layer: L.layerGroup([]), label: 'Drainage Pipes (no data)' };
  }

  // Sub-layers keyed by segment, so the rain simulation can recolour each
  // pipe by how full it is and restore the base style afterwards.
  const featureLayers = new Map();
  const baseStyle = (feature) => ({
    color: '#6d28d9',
    // Thicker line = bigger bore. Capped so the 6 m and 10 m outfalls do not
    // swamp the 0.7 m branches.
    weight: 2 + Math.min(meanHeight(feature.properties), 3) * 0.8,
    opacity: 0.95
  });

  return {
    layer: L.geoJSON(data, {
      style: baseStyle,
      onEachFeature: (feature, featureLayer) => {
        featureLayers.set(feature.properties.routeStationId, featureLayer);
        const { startStation, endStation, distanceM, segmentIndex } = feature.properties;
        featureLayer.bindTooltip(
          `Segment ${segmentIndex}: ${startStation || '?'} &rarr; ${endStation || '?'}` +
            `<br>Length: ${Math.round(distanceM).toLocaleString()} m` +
            `<br>${describeBore(feature.properties)}`,
          { sticky: true }
        );
      }
    }),
    label: 'Drainage Pipes',
    features,
    featureLayers,
    baseStyle
  };
}

let stationDataPromise = null;

// Both sensor layers read the same file, so it is fetched once.
function loadStationData() {
  if (!stationDataPromise) {
    stationDataPromise = loadJSON(PATTAYA_STATION_URL);
  }

  return stationDataPromise;
}

// One layer per sensor type. They measure different things -- depth inside the
// pipe versus depth on the road surface -- so they are worth toggling apart.
export async function createSensorStationLayer({ sensorType = 'TUNNEL' } = {}) {
  const inPipe = sensorType === 'TUNNEL';
  const label = inPipe ? 'Tunnel Sensors' : 'Pole Sensors';
  const data = await loadStationData();
  const features = (data?.features || []).filter(
    (feature) => feature.properties.sensorType === sensorType
  );

  if (features.length === 0) {
    return { layer: L.layerGroup([]), label: `${label} (no data)` };
  }

  return {
    // Render the filtered set, not the whole collection: passing `data` here
    // drew all 58 stations in both layers, at identical positions.
    layer: L.geoJSON({ type: 'FeatureCollection', features }, {
      pointToLayer: (feature, latlng) =>
        L.marker(latlng, {
          ...MARKER_OPTIONS,
          icon: inPipe ? PIPE_SENSOR_ICON : ROAD_SENSOR_ICON
        }),
      onEachFeature: (feature, featureLayer) => {
        const { name, heightRef, crossSectionArea, stationId } = feature.properties;
        bindHoverTip(featureLayer, escapeHtml(name), { offsetY: -12 });
        featureLayer.bindPopup(
          () =>
            detailPopup({
              title: name,
              rows: [
                ['Type', inPipe ? 'In-pipe level sensor' : 'Pole-mounted road level sensor'],
                [inPipe ? 'Pipe height' : 'Road reference', heightRef != null ? `${heightRef} m` : null],
                ['Cross-section', inPipe ? escapeHtml(describeArea(crossSectionArea)) : null],
                ['Station', stationId ? escapeHtml(String(stationId).slice(0, 8)) : null]
              ],
              source: 'Pattaya SMART GIS sensor network'
            }),
          POPUP_OPTIONS
        );
      }
    }),
    label
  };
}

// The Overpass query covers the whole bounding box, which reaches into
// Chachoengsao, Rayong and Samut Prakan. Keep only the parts of each line that
// fall inside Chon Buri, splitting lines that cross the border rather than
// dropping them whole.
function clipToBoundary(data, isInside) {
  if (!data || !Array.isArray(data.features)) {
    return data;
  }

  const features = [];

  for (const feature of data.features) {
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates)) {
      continue;
    }

    let run = [];

    for (const position of coordinates) {
      if (isInside(position[1], position[0])) {
        run.push(position);
        continue;
      }

      if (run.length >= 2) {
        features.push({ ...feature, geometry: { type: 'LineString', coordinates: run } });
      }

      run = [];
    }

    if (run.length >= 2) {
      features.push({ ...feature, geometry: { type: 'LineString', coordinates: run } });
    }
  }

  return { ...data, features };
}

// heightRef is the only bore figure the database records. A segment carries the
// value from the station at each of its ends, which usually differ.
function meanHeight({ startHeightRef, endHeightRef }) {
  const values = [startHeightRef, endHeightRef].filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) {
    return 1;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function describeBore({ startHeightRef, endHeightRef, startCrossSectionArea, endCrossSectionArea }) {
  const start = Number.isFinite(startHeightRef) ? `${startHeightRef} m` : '?';
  const end = Number.isFinite(endHeightRef) ? `${endHeightRef} m` : '?';
  const area = describeArea(startCrossSectionArea ?? endCrossSectionArea);
  return `Pipe height: ${start} &rarr; ${end}<br>Cross-section: ${area}`;
}

// The column exists in the database but is zero everywhere, so say so rather
// than printing a misleading 0 m2.
function describeArea(value) {
  return Number.isFinite(value) && value > 0 ? `${value} m²` : 'not recorded';
}

let riverDataPromise = null;

// Shared by the river and culvert layers, so the 2 MB file is fetched once.
function loadRiverData() {
  if (!riverDataPromise) {
    riverDataPromise = loadJSON(RIVER_DATA_URL);
  }

  return riverDataPromise;
}

async function loadJSON(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn(`Optional dataset unavailable (${url}):`, error);
    return null;
  }
}

function describeWaterway(properties = {}) {
  const type = properties.waterway || 'waterway';
  const name = properties.name || properties.nameEn;
  const label = name ? `${name}` : `Unnamed ${type}`;
  return `${label}<br>Type: ${type}${properties.tunnel ? ' (tunnel)' : ''}`;
}
