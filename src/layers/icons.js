// Map marker icons as data-URI images.
//
// These were inline <svg> inside L.divIcon, which meant ~8 DOM nodes per marker
// and 2,300+ extra nodes once the gate and sensor layers were both on. That cost
// ~30% of the frame budget while zooming. An L.icon backed by a data URI is a
// single <img> the browser decodes once and reuses for every marker.
//
// The white halo is baked in as a stroked copy underneath, so no CSS filter is
// needed either.

import L from 'leaflet';

const HALO = 'fill="none" stroke="#ffffff" stroke-width="3.6" stroke-linejoin="round" stroke-linecap="round"';

function svgIcon(shapes, color, size = 20) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">` +
    `<g ${HALO}>${shapes('none', '#ffffff')}</g>` +
    `<g>${shapes(color, color)}</g>` +
    `</svg>`;

  return L.icon({
    iconUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

// Sluice gate: valve handle and stem above a gate structure, water below.
const gateShapes = (fill, stroke) => `
  <path d="M7.5 3.5h9" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" />
  <path d="M12 3.5v4" fill="none" stroke="${stroke}" stroke-width="2.2" />
  <path d="M3.5 16.5V9.5h3l2-2h7l2 2h3v7z" fill="${fill}" stroke="${stroke}" stroke-width="0.6" />
  <path d="M2.5 19c1.6 0 1.6 1.6 3.2 1.6S7.3 19 8.9 19s1.6 1.6 3.2 1.6S13.7 19 15.3 19s1.6 1.6 3.2 1.6S20.1 19 21.7 19"
    fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" />`;

// In-pipe sensor: pressure gauge mounted on a pipe run.
const pipeSensorShapes = (fill, stroke) => `
  <circle cx="12" cy="6" r="4.2" fill="none" stroke="${stroke}" stroke-width="1.8" />
  <path d="M12 6L13.7 4.3" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" />
  <path d="M12 10.2V12" fill="none" stroke="${stroke}" stroke-width="1.8" />
  <path d="M6.5 12h11v7h-11z" fill="${fill}" stroke="${stroke}" stroke-width="0.6" />
  <path d="M2.5 13.5h4v4h-4z" fill="${fill}" stroke="${stroke}" stroke-width="0.6" />
  <path d="M17.5 13.5h4v4h-4z" fill="${fill}" stroke="${stroke}" stroke-width="0.6" />`;

// Pole-mounted road sensor: a mast carrying a sensor head that reads the water
// depth on the road below it.
// INTERIM ART -- to be replaced with the supplied icon.
const roadSensorShapes = (fill, stroke) => `
  <path d="M6.5 21h11" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" />
  <path d="M12 21V5.5" fill="none" stroke="${stroke}" stroke-width="1.8" />
  <path d="M8.5 3h7v4h-7z" fill="${fill}" stroke="${stroke}" stroke-width="0.6" />
  <path d="M12 9.5v2.5M10 11l2 2 2-2" fill="none" stroke="${stroke}" stroke-width="1.3"
    stroke-linecap="round" stroke-linejoin="round" />
  <path d="M4.5 17.5c1.5 0 1.5 1.3 3 1.3s1.5-1.3 3-1.3 1.5 1.3 3 1.3 1.5-1.3 3-1.3"
    fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" />`;

// Built once at module load, then shared by every marker of that type.
export const WATER_GATE_ICON = svgIcon(gateShapes, '#7c3aed');
// Blue = inside the pipe, slate = at road level. Both sit outside the
// green-to-red ramp reserved for flow status.
export const PIPE_SENSOR_ICON = svgIcon(pipeSensorShapes, '#1d4ed8');
export const ROAD_SENSOR_ICON = svgIcon(roadSensorShapes, '#475569');
