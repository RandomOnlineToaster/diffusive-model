import L from 'leaflet';
import { MARKER_OPTIONS, POPUP_OPTIONS, aside, bindHoverTip, detailPopup } from './mapPopup.js';

// The pump stations as markers: the 64 the survey places plus the ones the
// city's flood plan describes but the survey does not carry (Khao Noi), each
// with its rated flow from the plan where the plan gives one, and - while the
// drainage model runs - whether it is pumping, how deep its sump stands and
// how much it has lifted so far. The stations come from drainage-model.json
// (build-drainage-model.py), so the marker and the node the physics pumps
// from are the same thing.

// The pump icon in purple: gauge on the head, motor with fins, base plate.
const PUMP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 28" width="26" height="23">' +
  '<g stroke="#3b0764" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">' +
  '<rect x="2" y="24" width="28" height="2.8" fill="#6b21a8"/>' +
  '<rect x="18" y="9.5" width="7" height="3" fill="#7e22ce"/>' +
  '<rect x="15" y="12" width="14" height="11" rx="2.5" fill="#a855f7"/>' +
  '<path d="M17.5 15h9M17.5 18h9M17.5 21h9" fill="none"/>' +
  '<rect x="1" y="14.5" width="2.5" height="3" fill="#7e22ce"/>' +
  '<rect x="3" y="12" width="9" height="11" rx="1" fill="#a855f7"/>' +
  '<rect x="12" y="13" width="3" height="9" fill="#c084fc"/>' +
  '<path d="M6.5 8v4M12 4.5h7v5" fill="none"/>' +
  '<rect x="1" y="1" width="11" height="7" rx="1" fill="#a855f7"/>' +
  '<rect x="3" y="2.6" width="5" height="3.8" fill="#f3e8ff"/>' +
  '</g>' +
  '<g fill="#3b0764"><circle cx="5" cy="14.5" r="0.9"/><circle cx="10" cy="14.5" r="0.9"/>' +
  '<circle cx="5" cy="20.5" r="0.9"/><circle cx="10" cy="20.5" r="0.9"/></g>' +
  '</svg>';

function pumpIcon() {
  return L.divIcon({
    className: 'pump-station-icon',
    html: PUMP_SVG,
    iconSize: [26, 23],
    iconAnchor: [13, 22],
    popupAnchor: [0, -20]
  });
}

function cubic(m3) {
  return m3 >= 10000 ? `${(m3 / 1000).toFixed(1)}k m³` : `${Math.round(m3).toLocaleString()} m³`;
}

/**
 * @param model    drainage-model.json, for the station list
 * @param pipeNet  the running pipe network (pipeNetwork.js), for live state;
 *                 optional - without it the markers are static
 * @param isInside optional (lat, lng) => boolean study-area test
 */
export function createPumpStationLayer({ model, pipeNet = null, isInside = null } = {}) {
  const pumps = model?.pumps;
  if (!pumps || !pumps.count) {
    return { layer: L.layerGroup([]), label: 'Pump Stations (no data)', available: false, count: 0, update() {} };
  }

  const nodes = model.nodes;
  const markers = [];
  const group = L.layerGroup();
  for (let i = 0; i < pumps.count; i += 1) {
    const node = pumps.node[i];
    const lat = pumps.lat?.[i] ?? nodes.lat[node];
    const lng = pumps.lng?.[i] ?? nodes.lng[node];
    if (isInside && !isInside(lat, lng)) {
      continue;
    }
    const name = pumps.name?.[i] || 'Pump station';
    const marker = L.marker([lat, lng], { ...MARKER_OPTIONS, icon: pumpIcon() });
    marker.pumpIndex = i;
    marker.pumpNode = node;
    bindHoverTip(marker, name, { offsetY: -20 });
    marker.bindPopup(() => popupHtml(i, node), POPUP_OPTIONS);
    markers.push(marker);
    group.addLayer(marker);
  }

  function popupHtml(i, node) {
    const name = pumps.name?.[i] || 'Pump station';
    const plan = pumps.ratedM3s?.[i];
    const live = pipeNet?.pumpState ? pipeNet.pumpState(node) : null;
    const rated = plan ?? live?.ratedM3s ?? null;
    const status = !live
      ? null
      : live.running
        ? `<span class="pump-on">pumping</span>, sump ${(live.depthM * 100).toFixed(0)} cm`
        : live.depthM > 0.005
          ? `idle, sump ${(live.depthM * 100).toFixed(0)} cm`
          : 'idle, sump dry';
    const approx = Boolean(pumps.approx?.[i]);
    return detailPopup({
      title: name,
      rows: [
        ['Rated flow', rated === null ? null : `${rated.toFixed(2)} m³/s ${aside(plan ? 'city plan' : 'default')}`],
        ['Now', status],
        ['Pumped this run', live ? cubic(live.pumpedM3) : null],
        ['Position', approx ? "from the plan's description, not surveyed" : null]
      ],
      source: approx ? 'Pattaya flood-response plan' : 'Pattaya drainage survey'
    });
  }

  return {
    layer: group,
    label: 'Pump Stations',
    available: true,
    count: markers.length,

    /**
     * Refresh from the live model: a running pump's icon lights up, and an
     * open popup follows the state. Cheap - one class toggle per station.
     */
    update() {
      if (!pipeNet?.pumpState) {
        return;
      }
      for (const marker of markers) {
        const element = marker.getElement();
        if (!element) {
          continue; // the layer is off
        }
        const state = pipeNet.pumpState(marker.pumpNode);
        element.classList.toggle('pumping', state.running);
        if (marker.isPopupOpen()) {
          marker.getPopup().setContent(popupHtml(marker.pumpIndex, marker.pumpNode));
        }
      }
    }
  };
}
