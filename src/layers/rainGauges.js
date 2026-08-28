import L from 'leaflet';
import { config } from '../config.js';
import { POPUP_OPTIONS, aside, bindHoverTip, detailPopup, escapeHtml } from './detailCard.js';

// Observed rainfall, from TMD's own gauges: one circle per station inside the
// study area, sized and coloured by the 24 h total it reported. TMD only
// allows its own origin in CORS, so its JSON is fetched through the
// dev-server proxy declared in vite.config.js.
//
// The forecast endpoints publish a chance of rain per province; this one
// publishes what actually fell, in millimetres, at real stations. It is the
// only measured ground truth available without registering, and there are 14
// gauges inside the study area - Pattaya sits almost exactly on the
// simulation centre.

// Daily totals, not rates: these stops are what a rain gauge reads over a day.
const GAUGE_STOPS = [
  { mm: 0, color: '#cbd5e1', text: 'dry' },
  { mm: 0.1, color: '#93c5fd', text: 'a trace' },
  { mm: 1, color: '#3b82f6', text: 'light' },
  { mm: 10, color: '#16a34a', text: 'moderate' },
  { mm: 35, color: '#eab308', text: 'heavy' },
  { mm: 90, color: '#f97316', text: 'very heavy' },
  { mm: 150, color: '#dc2626', text: 'extreme' }
];

function gaugeStyleFor(mm) {
  let picked = GAUGE_STOPS[0];
  for (const stop of GAUGE_STOPS) {
    if (mm >= stop.mm) {
      picked = stop;
    }
  }
  return picked;
}

function gaugeRadius(mm) {
  // Square-root so a 180 mm downpour does not swamp the map, while the
  // difference between 1 mm and 10 mm stays visible. The floor is a target a
  // fingertip or a hurried mouse can hit: at 4 px a dry gauge was 8 px
  // across. Pixel radius, so the dot keeps its size at every zoom.
  return 7 + Math.min(9, Math.sqrt(Math.max(0, mm)) * 1.3);
}

export async function createRainGaugeLayer({ isInside } = {}) {
  const group = L.layerGroup();

  let stations = [];
  try {
    stations = await loadStations();
  } catch (error) {
    console.warn('TMD gauges unavailable:', error.message);
    return { layer: group, label: 'Rain Gauges (no TMD data)', available: false, count: 0 };
  }

  // TMD publishes the whole national network; only the handful inside the
  // study area are reference data for this map, and the rest just clutter it.
  //
  // The test is "inside or just offshore", not strictly inside: coastal gauges
  // sit on piers and reclaimed land outside the land polygon. Laem Chabang,
  // on its deep-sea port, is a couple of kilometres out and would otherwise
  // be dropped.
  const COASTAL_TOLERANCE_DEG = 0.03;
  const nearProvince = (lat, lng) => {
    if (isInside(lat, lng)) {
      return true;
    }

    const d = COASTAL_TOLERANCE_DEG;
    return [
      [d, 0], [-d, 0], [0, d], [0, -d],
      [d, d], [d, -d], [-d, d], [-d, -d]
    ].some(([dy, dx]) => isInside(lat + dy, lng + dx));
  };

  const local = isInside ? stations.filter((s) => nearProvince(s.lat, s.lng)) : stations;

  for (const station of local) {
    const style = gaugeStyleFor(station.rainMm);

    const marker = L.circleMarker([station.lat, station.lng], {
      // markerPane sits above the overlay pane, so a gauge stays hoverable
      // with the forecast heatmap drawn over the same ground.
      pane: 'markerPane',
      radius: gaugeRadius(station.rainMm),
      color: '#ff69b4',
      weight: 2,
      fillColor: style.color,
      fillOpacity: 0.9
    });

    bindHoverTip(
      marker,
      `${escapeHtml(station.name)} · ${station.rainMm.toFixed(1)} mm (${style.text})`,
      { offsetY: -gaugeRadius(station.rainMm) }
    );

    marker.bindPopup(
      detailPopup({
        title: station.name,
        subtitle: `${escapeHtml(station.province)} · WMO ${escapeHtml(station.wmo)}`,
        rows: [
          ['Rain, 24 h to 07:00', `${station.rainMm.toFixed(1)} mm ${aside(style.text)}`],
          ['Temperature', station.temperature ? `${station.temperature} °C` : null],
          ['Humidity', station.humidity ? `${station.humidity} %` : null],
          ['Wind', station.windSpeed ? `${station.windSpeed} km/h from ${station.windDirection}°` : null],
          ['Pressure', station.pressure ? `${station.pressure} hPa` : null]
        ],
        source:
          `Observed ${escapeHtml(station.observedAt)} (TMD reports once a day: the 24 h total to 07:00)` +
          '<br>Thai Meteorological Department'
      }),
      POPUP_OPTIONS
    );

    group.addLayer(marker);
  }

  return {
    layer: group,
    label: 'Rain Gauges (TMD)',
    available: true,
    count: local.length,
    totalCount: stations.length,
    stations: local
  };
}

async function loadStations() {
  const url =
    `${config.tmdProxyPath}/api/WeatherToday/V2/` +
    `?uid=${encodeURIComponent(config.tmdUid)}&ukey=${encodeURIComponent(config.tmdUkey)}&format=json`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TMD responded ${response.status}`);
  }

  const payload = await response.json();
  const raw = payload?.Stations?.Station || [];

  return raw
    .map((entry) => {
      const observation = entry.Observation || {};
      return {
        wmo: entry.WmoStationNumber,
        // English names are plain ASCII; the Thai ones are kept for the label
        // where they exist, since that is what local users read.
        name: entry.StationNameThai || entry.StationNameEnglish,
        province: entry.Province || '',
        lat: Number(entry.Latitude),
        lng: Number(entry.Longitude),
        rainMm: Number(observation.Rainfall ?? 0),
        temperature: observation.Temperature,
        humidity: observation.RelativeHumidity,
        windSpeed: observation.WindSpeed,
        windDirection: observation.WindDirection,
        pressure: observation.MeanSeaLevelPressure,
        observedAt: observation.DateTime || 'unknown'
      };
    })
    .filter(
      (station) =>
        Number.isFinite(station.lat) &&
        Number.isFinite(station.lng) &&
        Number.isFinite(station.rainMm)
    );
}

/** Colour key for the gauge layer, for the map legend. */
export const GAUGE_LEGEND = GAUGE_STOPS;
