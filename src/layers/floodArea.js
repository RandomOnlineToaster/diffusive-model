import L from 'leaflet';
import { POPUP_OPTIONS, bindHoverTip, detailPopup, escapeHtml } from './detailCard.js';
import { placeholderLabel } from './labels.js';
import { loadJsonOrNull } from '../lib/loadJson.js';

// The 17 areas the city's own survey marks as flood-prone
// (พื้นที่เสี่ยงต่อการเกิดน้ำท่วม), drawn so they can be laid straight over
// the simulation's ponding: where the two agree the model is confirmed, and
// where the model floods a spot the survey does not, one of them has
// something to explain.
//
// Data from playground.geojson (scripts/extract-playground.py), which also
// carries the chamber outlines and flow directions the Drainage Pipes layer
// draws.

const DATA_URL = '/data/playground.geojson';

const STYLE = { color: '#dc2626', weight: 1.6, opacity: 0.9, dashArray: '6 4', fillColor: '#dc2626', fillOpacity: 0.12 };

export async function createFloodAreaLayer({ isInside = null } = {}) {
  const data = await loadJsonOrNull(DATA_URL);
  const areas = (data?.features ?? []).filter((feature) => feature.properties?.kind === 'flood-risk');

  if (areas.length === 0) {
    return { layer: L.layerGroup([]), label: placeholderLabel('Flood Area'), available: false };
  }

  const layer = L.geoJSON(
    { type: 'FeatureCollection', features: areas },
    {
      style: () => STYLE,
      filter: (feature) => !isInside || anyVertexInside(feature.geometry, isInside),
      onEachFeature: (feature, areaLayer) => {
        const props = feature.properties || {};
        bindHoverTip(areaLayer, 'Flood risk area', { sticky: true });
        areaLayer.bindPopup(
          () =>
            detailPopup({
              title: 'Flood risk area',
              subtitle: 'Where the city says it floods',
              rows: [['Area', props.area ? escapeHtml(String(props.area)) : null]],
              source: 'Pattaya drainage survey'
            }),
          POPUP_OPTIONS
        );
      }
    }
  );

  return { layer, label: 'Flood Area', available: true, count: areas.length };
}

function anyVertexInside(geometry, isInside) {
  const stack = [geometry?.coordinates];
  while (stack.length) {
    const node = stack.pop();
    if (!Array.isArray(node)) {
      continue;
    }
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      if (isInside(node[1], node[0])) {
        return true;
      }
      continue;
    }
    for (const child of node) {
      stack.push(child);
    }
  }
  return false;
}
