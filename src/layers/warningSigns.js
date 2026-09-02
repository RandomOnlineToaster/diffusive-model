import L from 'leaflet';
import { MARKER_OPTIONS, POPUP_OPTIONS, bindHoverTip, detailPopup, escapeHtml } from './detailCard.js';
import { placeholderLabel } from './labels.js';
import { loadJsonOrNull } from '../lib/loadJson.js';

// Flood warning signs (ป้ายแจ้งเตือนภัยน้ำท่วม), from PAT-DB's DSM_station
// table. Each sign watches ONE sensor station and switches its message as
// that station's water level crosses min, mid and max thresholds.
//
// Positions are the DSM table's own surveyed roadside coordinates; the
// linked station supplies the level being watched, not the location.

const SIGNS_URL = '/data/dsm-stations.json';
const STATIONS_URL = '/data/pattaya-stations.geojson';

const SIGN_ICON = L.icon({
  iconUrl: '/icons/display.png',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
  popupAnchor: [0, -10]
});

export async function createWarningSignLayer() {
  const [data, stations] = await Promise.all([
    loadJsonOrNull(SIGNS_URL),
    loadJsonOrNull(STATIONS_URL)
  ]);
  const signs = data?.signs ?? [];
  if (signs.length === 0 || !stations?.features) {
    return { layer: L.layerGroup([]), label: placeholderLabel('Warning Sign'), available: false };
  }

  const stationById = new Map();
  for (const feature of stations.features) {
    stationById.set(feature.properties?.stationId, feature);
  }

  const layer = L.layerGroup();
  let placed = 0;
  for (const sign of signs) {
    if (!Number.isFinite(sign.latitude) || !Number.isFinite(sign.longitude)) {
      continue;
    }
    const watched = stationById.get(sign.stationId)?.properties?.name || null;
    const name = sign.name || 'Flood warning sign';

    const marker = L.marker([sign.latitude, sign.longitude], { ...MARKER_OPTIONS, icon: SIGN_ICON });
    bindHoverTip(marker, escapeHtml(name), { offsetY: -12 });
    marker.bindPopup(
      () =>
        detailPopup({
          title: escapeHtml(name),
          subtitle: watched ? `Watches ${escapeHtml(watched)}` : null,
          rows: [
            ['Warn from', `${sign.minLevel.toFixed(2)} m`],
            ['Escalate at', `${sign.midLevel.toFixed(2)} m`],
            ['Full alert at', `${sign.maxLevel.toFixed(2)} m`],
            ['Device', sign.deviceId ? escapeHtml(sign.deviceId) : null]
          ],
          source: 'Pattaya SMART GIS sensor network'
        }),
      POPUP_OPTIONS
    );
    layer.addLayer(marker);
    placed += 1;
  }

  return { layer, label: 'Warning Sign', available: placed > 0, count: placed };
}
