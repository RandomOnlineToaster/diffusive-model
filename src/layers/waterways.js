import L from 'leaflet';
import { placeholderLabel } from './labels.js';
import { loadJsonOrNull } from '../lib/loadJson.js';

// Open water from OpenStreetMap: rivers, canals and streams as lines
// (`npm run fetch:rivers`), lakes and reservoirs as polygons
// (`npm run fetch:water`). Demo geometry stands in until the files exist.

const RIVER_DATA_URL = '/data/chonburi-rivers.geojson';
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

export async function createRiverLayer({ isInside } = {}) {
  const raw = await loadJsonOrNull(RIVER_DATA_URL);
  const data = isInside ? clipToBoundary(raw, isInside) : raw;

  if (!data || !Array.isArray(data.features) || data.features.length === 0) {
    return {
      layer: L.layerGroup(
        DEMO_RIVERS.map((river) => L.polyline(river.points, DEFAULT_WATERWAY_STYLE).bindTooltip(river.name))
      ),
      label: placeholderLabel('Rivers & Canals')
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

  return { layer, label: 'Rivers & Canals' };
}

export async function createWaterBodyLayer({ isInside } = {}) {
  const data = await loadJsonOrNull(WATER_BODY_DATA_URL);
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
    return { layer: L.layerGroup([]), label: placeholderLabel('Lakes & Reservoirs') };
  }

  const renderer = L.canvas({ padding: 0.3 });

  return {
    layer: L.geoJSON(
      { type: 'FeatureCollection', features },
      {
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
      }
    ),
    label: 'Lakes & Reservoirs'
  };
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

function describeWaterway(properties = {}) {
  const type = properties.waterway || 'waterway';
  const name = properties.name || properties.nameEn;
  const label = name ? `${name}` : `Unnamed ${type}`;
  return `${label}<br>Type: ${type}${properties.tunnel ? ' (tunnel)' : ''}`;
}
