import L from 'leaflet';
import { getElevationAt } from '../terrain/terrain.js';
import { NODE_SEA_OUTFALL } from '../hydro/pipeNetwork.js';

// The sample-point popup: click anywhere for the height, the rain falling
// there, the water on the ground, the nearest flooded street and the nearest
// manhole. It keeps its position and terrain readings; the water figures are
// recomputed on every tick, so an open popup reads live instead of freezing
// at whatever the values were when it was clicked.

export function createSamplePopup({ map, rainfall, roadFlow, pipeNet, isForecastActive }) {
  let samplePoint = null;

  function content() {
    const { lat, lng, elevationText, flowText } = samplePoint;
    const lines = ['<strong>Sample point</strong>', `Elevation: ${elevationText}`, `Flow: ${flowText}`];

    // Water here right now: rain falling, surface water on the ground grid,
    // and the deepest flooded street within ~60 m - so nobody has to hover a
    // thin line to read a depth.
    const intensity = rainfall.intensityAt(lat, lng);
    const surfaceMm = rainfall.depthAt(lat, lng);
    lines.push(`Rain here: ${intensity.toFixed(1)} mm/h`);
    lines.push(`Water on ground: ${surfaceMm.toFixed(1)} mm`);

    // Forecast rain is routed along the streets, not ponded, so there is no
    // standing depth to read.
    const forecastHolds = isForecastActive();
    const street = forecastHolds ? null : roadFlow.dynamic?.depthNear(lat, lng, 60);
    if (street) {
      const here = Math.round(street.distanceM) <= 20 ? '' : ` (${Math.round(street.distanceM)} m away)`;
      lines.push(`Street water: ~${(street.depthM * 100).toFixed(0)} cm, ${street.severity}${here}`);

      // Only worth a second line when it is a different, meaningfully worse
      // spot - otherwise it just repeats the line above.
      const worst = street.deepest;
      if (worst && worst.depthM > street.depthM + 0.05) {
        lines.push(
          `Deepest within 60 m: ~${(worst.depthM * 100).toFixed(0)} cm, ${Math.round(worst.distanceM)} m away`
        );
      }

      if (street.flowM3s > 0.05) {
        lines.push(`Street flow: ~${street.flowM3s.toFixed(1)} m³/s`);
      }
    } else if (forecastHolds) {
      lines.push('Street water: forecast rain runs along the streets (see Street Flow)');
    } else {
      lines.push('Street water: none within 60 m');
    }

    // The nearest manhole of the surveyed network, and how full it stands.
    const drain = pipeNet?.nearestNode(lat, lng, 80);
    if (drain) {
      const what = drain.pump ? 'pump station' : drain.kind === NODE_SEA_OUTFALL ? 'sea outfall' : 'drain';
      const state = drain.surcharged
        ? 'surcharged'
        : drain.fill > 0.005
          ? `${Math.round(drain.fill * 100)}% full`
          : 'dry';
      lines.push(
        `Nearest ${what}: ${drain.sizeText ? `${drain.sizeText}, ` : ''}${state}` +
          `${drain.pumpRunning ? ', pumping' : ''} (${Math.round(drain.distanceM)} m away)`
      );
    }

    return lines.join('<br />');
  }

  function refresh() {
    if (samplePoint?.popup && map.hasLayer(samplePoint.popup)) {
      samplePoint.popup.setContent(content());
    }
  }

  map.on('popupclose', (event) => {
    if (samplePoint?.popup === event.popup) {
      samplePoint = null;
    }
  });

  map.on('click', async (event) => {
    // Clicking to drop a storm cell must not also open the sample popup, and
    // neither must a click that just opened a drainage cover's popup.
    if (rainfall.isPlacingStorm() || event.originalEvent?.featurePopupOpened) {
      return;
    }

    const { lat, lng } = event.latlng;
    const elevationMeters = await getElevationAt(lat, lng);
    // The covers layer's handler runs after this one but before the await
    // resolves, so its flag has to be checked again here.
    if (event.originalEvent?.featurePopupOpened) {
      return;
    }

    samplePoint = {
      lat,
      lng,
      elevationText: Number.isFinite(elevationMeters) ? `${elevationMeters} m` : 'N/A',
      flowText: regionalDrainageTendency(lat, lng),
      popup: L.popup()
    };

    samplePoint.popup.setLatLng(event.latlng).setContent(content()).openOn(map);
  });

  return { refresh };
}

// A coarse, hand-set note on which way the province drains around the
// point - a placeholder until the flow field is read here instead.
function regionalDrainageTendency(lat, lng) {
  if (lat > 13.25 && lng > 101.3) {
    return 'Southwest drainage tendency';
  }
  if (lat > 13.05) {
    return 'Southward drainage tendency';
  }
  return 'Southeast drainage tendency';
}
