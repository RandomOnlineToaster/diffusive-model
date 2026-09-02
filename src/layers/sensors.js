import L from 'leaflet';
import { PIPE_SENSOR_ICON, ROAD_SENSOR_ICON } from './icons.js';
import { MARKER_OPTIONS, POPUP_OPTIONS, bindHoverTip, detailPopup, escapeHtml } from './detailCard.js';
import { loadJsonOrNull } from '../lib/loadJson.js';

// The city's level sensors (SMART GIS): in-pipe "tunnel" stations and
// pole-mounted road stations, one layer each because they measure different
// things - depth inside the drain against depth on the road surface.

const PATTAYA_STATION_URL = '/data/pattaya-stations.geojson';

let stationDataPromise = null;

// Both sensor layers read the same file, so it is fetched once.
function loadStationData() {
  if (!stationDataPromise) {
    stationDataPromise = loadJsonOrNull(PATTAYA_STATION_URL);
  }
  return stationDataPromise;
}

// The column exists in the database but is zero everywhere, so say so rather
// than printing a misleading 0 m².
function describeArea(value) {
  return Number.isFinite(value) && value > 0 ? `${value} m²` : 'not recorded';
}

export async function createSensorStationLayer({ sensorType = 'TUNNEL' } = {}) {
  const inPipe = sensorType === 'TUNNEL';
  const label = inPipe ? 'Tunnel Sensors' : 'Road Sensor';
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
    layer: L.geoJSON(
      { type: 'FeatureCollection', features },
      {
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
      }
    ),
    label
  };
}
