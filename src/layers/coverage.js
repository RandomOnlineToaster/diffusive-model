import L from 'leaflet';
import { POPUP_OPTIONS, bindHoverTip, detailPopup, escapeHtml } from './detailCard.js';
import { placeholderLabel } from './labels.js';
import { loadJsonOrNull } from '../lib/loadJson.js';

// Coverage: every drawn pipe run coloured by whether the data behind it is
// good enough to compute on - for this model's formulas and for EPA SWMM,
// which need the same things (see docs/formulas.md, C1-C3).
//
//   green   ready: inverts measured at both ends of every conduit, size and
//           material surveyed, nothing contradicting
//   yellow  missing something: an assumed invert end, or no surveyed size
//   orange  contradiction: the survey's own flow arrow points against the
//           slope its inverts imply
//   red     no data where it counts: every invert end on the run is assumed
//
// The click card lists each datum in green (have) or red (missing), so the
// survey office can read a run's punch-list straight off the map.

const PLAYGROUND_URL = '/data/playground.geojson';

const CLASS_COLOR = {
  green: '#16a34a',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#dc2626'
};

// The same visual language as the Drainage Pipes layer: a run's width comes
// from its bore, so a trunk reads heavier than a lane drain and the layer
// stops being a uniform carpet. Readiness only recolours it.
function runWeight(props) {
  const bore = Number(String(props?.size ?? '').match(/[\d.]+/)?.[0] ?? 0);
  return 1.2 + Math.min(3, bore) * 1.1;
}

function runStyle(feature, byFeature, zoomFactor = 1) {
  const { cls } = classify(feature, byFeature);
  return {
    color: CLASS_COLOR[cls],
    weight: runWeight(feature.properties) * zoomFactor,
    opacity: 0.85
  };
}

const VERDICT = {
  green: 'Ready to compute',
  yellow: 'Missing some data',
  orange: 'Survey contradicts itself here',
  red: 'No measured data on this run'
};

const ok = (text) => `<span class="cov-ok">${text}</span>`;
const miss = (text) => `<span class="cov-miss">${text}</span>`;
const meh = (text) => `<span class="cov-meh">${text}</span>`;

export async function createCoverageLayer({ model, pipeFeatures }) {
  if (!model || !pipeFeatures?.length) {
    return { layer: L.layerGroup([]), label: placeholderLabel('Coverage Data'), available: false };
  }

  const playground = await loadJsonOrNull(PLAYGROUND_URL);
  const contradicted = markContradictions(model, playground);

  // Every conduit folded up into the drawn run it came from.
  const N = model.nodes;
  const C = model.conduits;
  const byFeature = new Map();
  for (let c = 0; c < C.count; c += 1) {
    const f = C.feature[c];
    let agg = byFeature.get(f);
    if (!agg) {
      agg = { conduits: 0, ends: 0, measured: 0, contradictions: 0 };
      byFeature.set(f, agg);
    }
    agg.conduits += 1;
    agg.ends += 2;
    agg.measured += (N.invertSource[C.from[c]] !== 0 ? 1 : 0) + (N.invertSource[C.to[c]] !== 0 ? 1 : 0);
    agg.contradictions += contradicted.has(c) ? 1 : 0;
  }

  // Zoomed out, a 3 px line per run turns the city into a solid carpet, so
  // the weight follows the zoom: full width at street level, half of it at
  // the city view.
  const weightScale = (zoom) => (zoom >= 15 ? 1 : zoom >= 13 ? 0.7 : 0.5);

  const counts = { green: 0, yellow: 0, orange: 0, red: 0 };
  const layer = L.geoJSON(
    { type: 'FeatureCollection', features: pipeFeatures },
    {
      style: (feature) => runStyle(feature, byFeature),
      onEachFeature: (feature, run) => {
        const { cls } = classify(feature, byFeature);
        counts[cls] += 1;
        bindHoverTip(run, `${escapeHtml(VERDICT[cls])}`, { sticky: true });
        run.bindPopup(() => card(feature, byFeature), POPUP_OPTIONS);
      }
    }
  );

  layer.on('add', () => {
    const map = layer._map;
    const restyle = () => {
      const f = weightScale(map.getZoom());
      layer.eachLayer((run) => {
        run.setStyle({ weight: runWeight(run.feature?.properties) * f });
      });
    };
    restyle();
    map.on('zoomend', restyle);
    layer.once('remove', () => map.off('zoomend', restyle));
  });

  return { layer, label: 'Coverage Data', available: true, counts };
}

/** The run's readiness class and the aggregate behind it. */
function classify(feature, byFeature) {
  const agg = byFeature.get(feature.id) ?? null;
  const props = feature.properties || {};
  const hasSize = props.size != null && props.size !== '';
  const hasMaterial = props.material != null && props.material !== '';

  let cls;
  if (agg && agg.contradictions > 0) {
    cls = 'orange';
  } else if (!agg || agg.measured === 0) {
    cls = 'red';
  } else if (agg.measured < agg.ends || !hasSize) {
    cls = 'yellow';
  } else if (!hasMaterial) {
    cls = 'yellow';
  } else {
    cls = 'green';
  }
  return { cls, agg, hasSize, hasMaterial };
}

function card(feature, byFeature) {
  const { cls, agg, hasSize, hasMaterial } = classify(feature, byFeature);
  const props = feature.properties || {};

  const invertRow = !agg
    ? miss('not in the pipe graph (no conduit built from this run)')
    : agg.measured === agg.ends
      ? ok(`measured at all ${agg.ends} ends (${agg.conduits} conduit${agg.conduits > 1 ? 's' : ''})`)
      : agg.measured === 0
        ? miss(`assumed at all ${agg.ends} ends`)
        : meh(`${agg.measured} of ${agg.ends} ends measured, rest assumed`);

  const rows = [
    ['Inverts', invertRow],
    ['Size', hasSize ? ok(escapeHtml(String(props.size)) + ' m') : miss('not surveyed')],
    ['Material', hasMaterial ? ok(escapeHtml(String(props.material))) : miss('not surveyed')],
    ['Type', props.type ? ok(escapeHtml(String(props.type))) : miss('not recorded')],
    ['Length', props.length_m ? meh(`${props.length_m} m`) : null],
    [
      'Direction check',
      agg && agg.contradictions > 0
        ? miss(`surveyed arrow CONTRADICTS the invert slope (${agg.contradictions}×)`)
        : agg
          ? meh('no conflicting arrow on this run')
          : null
    ]
  ];

  return detailPopup({
    title: props.road ? String(props.road) : 'Drain run',
    subtitle: `<span class="cov-${cls === 'green' ? 'ok' : cls === 'red' || cls === 'orange' ? 'miss' : 'meh'}">${VERDICT[cls]}</span>`,
    rows,
    source: 'data completeness for this model + EPA SWMM'
  });
}

/**
 * Conduits whose measured slope points against the survey's own flow arrow.
 * The same join the analysis ran: each on-drain arrow against the nearest
 * conduit within 25 m, compared only when the arrow runs along it and the
 * drop is past the 2 cm noise floor.
 */
function markContradictions(model, playground) {
  const flagged = new Set();
  const flows = (playground?.features ?? []).filter(
    (f) => f.properties?.kind === 'flow' && f.properties.onPipe !== false
  );
  if (!flows.length) {
    return flagged;
  }

  const N = model.nodes;
  const C = model.conduits;
  const mLat = 110574;
  const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
  const CELL = 0.0007;
  const grid = new Map();
  const mid = new Array(C.count);
  const dir = new Array(C.count);
  for (let c = 0; c < C.count; c += 1) {
    const a = C.from[c];
    const b = C.to[c];
    const lat = (N.lat[a] + N.lat[b]) / 2;
    const lng = (N.lng[a] + N.lng[b]) / 2;
    const dx = (N.lng[b] - N.lng[a]) * mLng(lat);
    const dy = (N.lat[b] - N.lat[a]) * mLat;
    const len = Math.hypot(dx, dy) || 1;
    mid[c] = [lat, lng];
    dir[c] = [dx / len, dy / len];
    const key = `${(lat / CELL) | 0}:${(lng / CELL) | 0}`;
    if (!grid.has(key)) {
      grid.set(key, []);
    }
    grid.get(key).push(c);
  }

  for (const flow of flows) {
    let coords = flow.geometry.coordinates;
    if (flow.geometry.type === 'MultiLineString') {
      coords = coords[0];
    }
    if (!coords || coords.length < 2) {
      continue;
    }
    const i = coords.length >> 1;
    const [lng1, lat1] = coords[Math.max(0, i - 1)];
    const [lng2, lat2] = coords[Math.min(coords.length - 1, i)];
    const lat = (lat1 + lat2) / 2;
    const lng = (lng1 + lng2) / 2;
    let ax = (lng2 - lng1) * mLng(lat);
    let ay = (lat2 - lat1) * mLat;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;

    let best = -1;
    let bestD = Infinity;
    const row = (lat / CELL) | 0;
    const col = (lng / CELL) | 0;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const bucket = grid.get(`${row + dr}:${col + dc}`);
        if (!bucket) {
          continue;
        }
        for (const c of bucket) {
          const d = Math.hypot((mid[c][0] - lat) * mLat, (mid[c][1] - lng) * mLng(lat));
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    if (best < 0 || bestD > 25) {
      continue;
    }
    const dot = ax * dir[best][0] + ay * dir[best][1];
    if (Math.abs(dot) < 0.5) {
      continue; // the arrow crosses this pipe rather than running along it
    }
    const drop = N.invert[C.from[best]] - N.invert[C.to[best]];
    if (Math.abs(drop) < 0.02) {
      continue;
    }
    if (Math.sign(drop) !== Math.sign(dot)) {
      flagged.add(best);
    }
  }
  return flagged;
}
