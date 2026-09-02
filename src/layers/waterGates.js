import L from 'leaflet';
import { WATER_GATE_ICON } from './icons.js';
import { MARKER_OPTIONS, POPUP_OPTIONS, bindHoverTip, detailPopup, escapeHtml } from './detailCard.js';
import { placeholderLabel } from './labels.js';
import { loadJsonOrNull } from '../lib/loadJson.js';

// Water gates, weirs and sluices from OpenStreetMap (`npm run fetch:water`),
// with demo markers when the file has not been downloaded.

const WATER_GATE_DATA_URL = '/data/chonburi-water-gates.geojson';

const DEMO_WATER_GATES = [
  { name: 'Khlong Yai water gate (demo)', position: [13.28, 100.98] },
  { name: 'Nong Mai Daeng gate (demo)', position: [13.38, 101.02] },
  { name: 'Ban Bueng regulator (demo)', position: [13.31, 101.11] }
];

export async function createWaterGateLayer({ isInside } = {}) {
  const data = await loadJsonOrNull(WATER_GATE_DATA_URL);
  const features = (data?.features || []).filter(
    (feature) =>
      !isInside || isInside(feature.geometry.coordinates[1], feature.geometry.coordinates[0])
  );

  if (features.length === 0) {
    return {
      layer: L.layerGroup(
        DEMO_WATER_GATES.map((gate) => waterGateMarker(gate.position, gate.name, 'demo', 'placeholder'))
      ),
      label: placeholderLabel('Sluice Gate')
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
    label: 'Sluice Gate'
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
