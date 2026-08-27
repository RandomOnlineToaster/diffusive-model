import L from 'leaflet';

// Surveyed drainage network for Pattaya, from the city's GIS geodatabase
// (Data_Pattaya.gdb, feature datasets `drain` -> drainage_line / drainage_point),
// reprojected to WGS84 by scripts/extract-drainage.py.
//
//   drainage-pipes.geojson   gravity drains and box culverts (4.5k lines)
//   drainage-covers.geojson  manholes and inlet covers (80k points)
//
// Two layers, one menu. Pipes carry a click-through of bore, material and
// length; covers a click-through of cover size, manhole depth and use. The
// covers are far too many to draw at once, so that layer loads on first use
// and only paints what is in view once zoomed in past the point where a
// 0.8 m cover is worth seeing.

const PIPE_URL = '/data/drainage-pipes.geojson';
const COVER_URL = '/data/drainage-covers.geojson';

// Below this zoom the covers layer paints nothing: at a whole-city view a
// manhole is a sub-pixel dot, 80k of them are a smear, and rebuilding them on
// every pan would be the heaviest thing on the map. The scale bar reads about
// 200 m here, close enough to walk a street and pick a cover out.
const COVER_MIN_ZOOM = 15;
// Never paint more than this many covers in one view, however far out the gate
// lets you go: a runaway count is what a cap is for.
const COVER_MAX_DRAWN = 8000;

// One canvas for both drainage layers, created on first use and kept. Two
// stacked canvas renderers swallow each other's clicks (the topmost canvas
// hit-tests only its own paths), so pipes and covers share this one - the same
// rule the flow layers follow with flowLineRenderer.
let drainageRenderer = null;
function renderer() {
  if (!drainageRenderer) {
    drainageRenderer = L.canvas({ padding: 0.4, tolerance: 6 });
  }
  return drainageRenderer;
}

// --- Thai attribute values -> an English gloss -----------------------------
// The data is the city's own, in Thai; the map is labelled in English. Each
// popup shows the gloss with the original Thai in brackets, so both a local
// user and an English reader get it, and an unknown value still shows raw.
const PIPE_TYPE = {
  'ท่อกลม': 'Round pipe',
  'Box Culvert': 'Box culvert',
  'ท่อแรงดัน': 'Pressure main',
  'ท่อแรงดัน PE': 'Pressure main (PE)'
};

const PIPE_MATERIAL = {
  'คสล': 'Reinforced concrete',
  'ค.ส.ล.': 'Reinforced concrete',
  HDPE: 'HDPE',
  'HDPE.': 'HDPE',
  'HDPE ท่อเหลี่ยม': 'HDPE (box)',
  'PVC ฟ้า': 'PVC (blue)',
  PVC: 'PVC'
};

const COVER_MATERIAL = {
  'เหล็กหล่อ': 'Cast iron',
  'เหล็ก': 'Steel',
  'คสล': 'Reinforced concrete',
  'เหล็กตะแกรง': 'Steel grating',
  'ฝาตะแกรงรับน้ำ': 'Grated inlet',
  'คอนกรีต': 'Concrete',
  'กระเบื้อง': 'Tile',
  'ไม้': 'Wood'
};

const COVER_USE = {
  'ฝาบ่อพักมีท่อชู๊ต': 'Manhole with chute pipe'
};

const SOURCE = {
  'แปลภาพ': 'Photo-interpreted',
  'สำรวจ': 'Field survey'
};

// A grated cover is where surface water enters the network; it reads as the
// live part of the system, so it gets the accent colour while sealed covers
// stay a neutral slate.
const INLET_MATERIALS = new Set(['เหล็กตะแกรง', 'ฝาตะแกรงรับน้ำ']);

function gloss(value, table) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const english = table[value];
  // The value verbatim when it is already Latin (HDPE, PVC, Box Culvert), or
  // when there is no gloss for it; "English (ไทย)" when both exist and differ.
  if (!english) {
    return escapeHtml(String(value));
  }
  if (english === value) {
    return escapeHtml(english);
  }
  return `${escapeHtml(english)} <span class="drain-th">(${escapeHtml(String(value))})</span>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A pipe's bore as a label: box culverts carry W x H, round pipes a diameter. */
function pipeSize(size) {
  if (!size) {
    return null;
  }
  const text = String(size).trim();
  if (text.includes('x') || text.includes('X') || text.includes('×')) {
    return `${text.replace(/[xX]/g, '×')} m`;
  }
  return `Ø${text} m`;
}

/** Leading number of a size string, for weighting a line by its bore. */
function boreMeters(size) {
  const match = String(size ?? '').match(/[\d.]+/);
  return match ? Number(match[0]) : 0;
}

function pipeColor(type) {
  if (type === 'Box Culvert') {
    return '#1d4ed8';
  }
  if (String(type ?? '').includes('แรงดัน')) {
    return '#ea580c';
  }
  return '#0891b2';
}

function row(label, value) {
  return value === null || value === undefined ? '' : `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function pipePopup(props) {
  const p = props || {};
  const title = p.road ? escapeHtml(String(p.road)) : 'Drain pipe';
  const rows =
    row('Type', gloss(p.type, PIPE_TYPE)) +
    row('Size', p.size ? escapeHtml(pipeSize(p.size)) : null) +
    row('Material', gloss(p.material, PIPE_MATERIAL)) +
    row('Length', p.length_m != null ? `${Number(p.length_m).toLocaleString()} m` : null);
  return (
    `<strong>${title}</strong>` +
    '<table class="drain-detail"><tbody>' +
    rows +
    '</tbody></table>' +
    '<small>Pattaya drainage survey</small>'
  );
}

function coverSizeText(p) {
  if (p.cover_dia) {
    return `Ø${p.cover_dia} m`;
  }
  if (p.cover_w && p.cover_l) {
    return `${p.cover_w}×${p.cover_l} m`;
  }
  if (p.cover_w || p.cover_l) {
    return `${p.cover_w || p.cover_l} m`;
  }
  return null;
}

function manholeSizeText(p) {
  if (p.mh_w && p.mh_l) {
    return `${p.mh_w}×${p.mh_l} m`;
  }
  return null;
}

function coverPopup(props) {
  const p = props || {};
  const title = p.road ? escapeHtml(String(p.road)) : 'Drainage cover';
  const rows =
    row('Cover', gloss(p.cover, COVER_MATERIAL)) +
    row('Cover size', coverSizeText(p) ? escapeHtml(coverSizeText(p)) : null) +
    row('Manhole depth', p.depth_m != null ? `${p.depth_m} m` : null) +
    row('Manhole size', manholeSizeText(p) ? escapeHtml(manholeSizeText(p)) : null) +
    row('Use', gloss(p.use, COVER_USE)) +
    row('Source', gloss(p.source, SOURCE));
  return (
    `<strong>${title}</strong>` +
    '<table class="drain-detail"><tbody>' +
    rows +
    '</tbody></table>' +
    '<small>Pattaya drainage survey</small>'
  );
}

async function loadJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response.json();
}

/**
 * The pipes: one canvas polyline per drain run, coloured by type and weighted
 * by bore, each with a click-through of its survey attributes.
 */
export async function createDrainagePipeLayer({ isInside } = {}) {
  let data;
  try {
    data = await loadJSON(PIPE_URL);
  } catch (error) {
    console.warn('Drainage pipes unavailable:', error.message);
    return { layer: L.layerGroup([]), label: 'Drainage Pipes (no data)', available: false };
  }

  // Each run keeps its position in the file as its id: that is how the pipe
  // model (built from the same file) refers back to it when recolouring.
  (data.features || []).forEach((feature, index) => {
    feature.id = index;
  });
  const features = (data.features || []).filter((feature) => {
    if (!isInside) {
      return true;
    }
    // A line is in if any vertex is: catchments cross the study edge.
    return feature.geometry.coordinates.some(([lng, lat]) => isInside(lat, lng));
  });

  const baseStyle = (feature) => {
    const p = feature.properties || {};
    return {
      color: pipeColor(p.type),
      weight: 1.5 + Math.min(3, boreMeters(p.size)) * 1.1,
      opacity: 0.9
    };
  };

  // Sub-layers by feature id, so the simulation can recolour each run by how
  // full it is and restore the base style afterwards.
  const featureLayers = new Map();
  const layer = L.geoJSON(
    { type: 'FeatureCollection', features },
    {
      renderer: renderer(),
      style: baseStyle,
      onEachFeature: (feature, featureLayer) => {
        featureLayers.set(feature.id, featureLayer);
        featureLayer.bindPopup(() => pipePopup(feature.properties), { maxWidth: 280 });
      }
    }
  );

  return {
    layer,
    label: 'Drainage Pipes',
    available: true,
    count: features.length,
    featureLayers,
    baseStyle
  };
}

// The covers layer paints only what is on screen, and only once zoomed in far
// enough for a cover to mean something - and it paints on ONE canvas. The
// first version built a Leaflet circle marker per cover in view: up to 8k
// layer objects, each with a popup, rebuilt on every pan, which is what made
// the toggle lag. Now the 80k covers are held as typed arrays with a grid
// index; a pan looks up the cells in view, draws dots straight onto the
// canvas, and a click finds the nearest drawn dot for its popup. The data is
// fetched the first time the layer is switched on.
const COVER_CELL_DEG = 0.002; // ~220 m cells for the viewport lookup
const COVER_RADIUS_PX = 4;
const COVER_HIT_PX = 9;

/** The covers as typed arrays plus a grid index over them. */
function buildCoverIndex(features, isInside) {
  const kept = [];
  for (const feature of features) {
    const [lng, lat] = feature.geometry.coordinates;
    if (!isInside || isInside(lat, lng)) {
      kept.push(feature);
    }
  }

  const count = kept.length;
  const lat = new Float64Array(count);
  const lng = new Float64Array(count);
  const inlet = new Uint8Array(count);
  const props = new Array(count);
  const cells = new Map();
  for (let i = 0; i < count; i += 1) {
    const feature = kept[i];
    lng[i] = feature.geometry.coordinates[0];
    lat[i] = feature.geometry.coordinates[1];
    inlet[i] = INLET_MATERIALS.has(feature.properties?.cover) ? 1 : 0;
    props[i] = feature.properties || {};
    const key = Math.floor(lat[i] / COVER_CELL_DEG) * 200000 + Math.floor(lng[i] / COVER_CELL_DEG);
    const bucket = cells.get(key);
    if (bucket) {
      bucket.push(i);
    } else {
      cells.set(key, [i]);
    }
  }

  return { count, lat, lng, inlet, props, cells };
}

const DrainageCovers = L.Layer.extend({
  options: {
    pane: 'overlayPane',
    isInside: null
  },

  initialize(options) {
    L.setOptions(this, options);
    this._index = null;
    this._loading = null;
    // What is drawn right now: junction ids and their screen positions, for
    // the click hit-test.
    this._drawnIds = null;
    this._drawnPx = null;
    this._drawnCount = 0;
    this._redraw = this._redraw.bind(this);
    this._onClick = this._onClick.bind(this);
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer leaflet-zoom-hide drainage-covers');
    this._ctx = this._canvas.getContext('2d');
    this.getPane().appendChild(this._canvas);
    map.on('click', this._onClick);
    this._ensureData().then(() => this._redraw());
    this._redraw();
  },

  onRemove(map) {
    map.off('click', this._onClick);
    this._canvas.remove();
    this._canvas = null;
    this._ctx = null;
    this._map = null;
    this._drawnCount = 0;
  },

  getEvents() {
    return {
      moveend: this._redraw,
      zoomend: this._redraw,
      resize: this._redraw
    };
  },

  _ensureData() {
    if (this._index) {
      return Promise.resolve(this._index);
    }
    if (!this._loading) {
      this._loading = loadJSON(COVER_URL)
        .then((data) => {
          this._index = buildCoverIndex(data.features || [], this.options.isInside);
          return this._index;
        })
        .catch((error) => {
          console.warn('Drainage covers unavailable:', error.message);
          this._index = buildCoverIndex([], null);
          return this._index;
        });
    }
    return this._loading;
  },

  // Paint the covers in view, or nothing when zoomed out past the point
  // where they are legible.
  _redraw() {
    const map = this._map;
    const index = this._index;
    if (!map || !this._canvas) {
      return;
    }

    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(size.x * ratio);
    const height = Math.round(size.y * ratio);
    if (this._canvas.width !== width || this._canvas.height !== height) {
      this._canvas.width = width;
      this._canvas.height = height;
      this._canvas.style.width = `${size.x}px`;
      this._canvas.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));

    const ctx = this._ctx;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    this._drawnCount = 0;

    if (!index || map.getZoom() < COVER_MIN_ZOOM) {
      return;
    }

    // Everything in the (slightly padded) view, from the grid cells it spans.
    const bounds = map.getBounds().pad(0.05);
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const inView = [];
    for (let ci = Math.floor(south / COVER_CELL_DEG); ci <= Math.floor(north / COVER_CELL_DEG); ci += 1) {
      for (let cj = Math.floor(west / COVER_CELL_DEG); cj <= Math.floor(east / COVER_CELL_DEG); cj += 1) {
        const bucket = index.cells.get(ci * 200000 + cj);
        if (!bucket) {
          continue;
        }
        for (const i of bucket) {
          if (index.lat[i] >= south && index.lat[i] <= north && index.lng[i] >= west && index.lng[i] <= east) {
            inView.push(i);
          }
        }
      }
    }

    // Thinned by an even stride past the cap, so a dense view still shows
    // covers everywhere rather than only in one corner.
    const step = inView.length > COVER_MAX_DRAWN ? Math.ceil(inView.length / COVER_MAX_DRAWN) : 1;
    const drawn = Math.ceil(inView.length / step);
    if (!this._drawnIds || this._drawnIds.length < drawn) {
      this._drawnIds = new Int32Array(Math.max(drawn, 1024));
      this._drawnPx = new Float32Array(Math.max(drawn, 1024) * 2);
    }

    let at = 0;
    for (let k = 0; k < inView.length; k += step) {
      const i = inView[k];
      const point = map.latLngToContainerPoint([index.lat[i], index.lng[i]]);
      this._drawnIds[at] = i;
      this._drawnPx[at * 2] = point.x;
      this._drawnPx[at * 2 + 1] = point.y;
      at += 1;
    }
    this._drawnCount = at;

    // Two passes, one per colour: sealed covers a neutral slate, grated
    // inlets the accent blue, each with a white rim.
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    for (const wantInlet of [0, 1]) {
      ctx.fillStyle = wantInlet ? '#0ea5e9' : '#64748b';
      ctx.beginPath();
      for (let k = 0; k < at; k += 1) {
        const i = this._drawnIds[k];
        if (index.inlet[i] !== wantInlet) {
          continue;
        }
        const x = this._drawnPx[k * 2];
        const y = this._drawnPx[k * 2 + 1];
        ctx.moveTo(x + COVER_RADIUS_PX, y);
        ctx.arc(x, y, COVER_RADIUS_PX, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    }
  },

  // A click near a drawn cover opens its survey popup, and flags the event so
  // the map's own sample-point popup leaves it alone.
  _onClick(event) {
    if (this._drawnCount === 0 || !this._index) {
      return;
    }
    const { x, y } = event.containerPoint;
    let best = -1;
    let bestDistance = COVER_HIT_PX;
    for (let k = 0; k < this._drawnCount; k += 1) {
      const dx = this._drawnPx[k * 2] - x;
      const dy = this._drawnPx[k * 2 + 1] - y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = this._drawnIds[k];
      }
    }
    if (best < 0) {
      return;
    }

    if (event.originalEvent) {
      event.originalEvent.coverPopupOpened = true;
    }
    L.popup({ maxWidth: 280 })
      .setLatLng([this._index.lat[best], this._index.lng[best]])
      .setContent(coverPopup(this._index.props[best]))
      .openOn(this._map);
  }
});

/**
 * The covers layer. Returns the same { layer, label } shape as the others, so
 * map.js drops it into the control the same way; the layer manages its own
 * lazy load and viewport rendering.
 */
export function createDrainageCoverLayer({ isInside } = {}) {
  return {
    layer: new DrainageCovers({ isInside }),
    label: 'Drainage Covers',
    available: true,
    minZoom: COVER_MIN_ZOOM
  };
}
