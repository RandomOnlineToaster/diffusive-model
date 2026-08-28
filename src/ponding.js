// Standing water as pools. Street Flow draws a wet street as a coloured line
// with particles running along it; this layer paints the WATER itself: a
// translucent blue band along every street link with water at either end,
// as wide as the ground the water has spread to - the street itself below
// the kerb, the whole catchment strip either side above it - and darker the
// deeper it stands. Bands of neighbouring wet links join, so a flooded block
// reads as a flooded block and a pool in a low street takes the street's
// shape rather than a dot's. (An earlier version painted half-links from
// each wet junction with round caps; at 60 m wide and 10 m long those were
// circles, however many of them touched.)
//
// It sits in its own pane UNDER the overlay pane, so the street lines, flow
// particles and the storm's rain field all draw on top of it; toggling it
// adds or removes the blue ground beneath them.
//
// One canvas, redrawn on each pan/zoom and on every update: wet junctions
// are collected once per update, then projected and culled to the view.
// Deep water is drawn last so it stays on top.

import L from 'leaflet';

const PANE = 'ponding';
const PANE_Z_INDEX = 390; // tiles are 200, overlays 400
// Light to deep water, one colour per depth class (the same class stops as
// Street Flow: 0.5, 5, 15, 30, 50 cm).
const WATER_COLORS = ['#7dd3fc', '#38bdf8', '#2563eb', '#1d4ed8', '#172554'];
const WATER_ALPHA = [0.5, 0.58, 0.66, 0.74, 0.82];
// A band is never thinner than this on screen: a street line with its
// particle trail is 2-4 px wide, and a band no wider than that hides under
// it, which read as ponding "arriving late".
const MIN_WIDTH_PX = 10;
const MAX_WIDTH_PX = 160;

const Ponding = L.Layer.extend({
  /**
   * @param source { lat, lng, edges, depths, curbDepthM, streetWidthM,
   *   stripWidthM, stops } - live views onto the street model's arrays;
   *   `depths` is read afresh on every update. `edges` is the flat [a, b,
   *   a, b, ...] link list of the street graph.
   */
  initialize(source, options) {
    L.setOptions(this, options);
    this._source = source;
    this._wetCount = 0;
    this._wetEdges = null; // link indices with water at either end
    this._wetEdgeCount = 0;
    // Each junction's position in unit Web Mercator, built once. Leaflet's
    // latLngToContainerPoint allocates a Point and redoes the projection per
    // call - tens of thousands of them per repaint.
    this._unitX = null;
    this._unitY = null;
    this._redraw = this._redraw.bind(this);
  },

  /** Unit Mercator (0..1 across the world) per junction, cached. */
  _project() {
    if (this._unitX) {
      return;
    }
    const { lat, lng } = this._source;
    const count = lat.length;
    const unitX = new Float64Array(count);
    const unitY = new Float64Array(count);
    const DEG = Math.PI / 180;
    for (let n = 0; n < count; n += 1) {
      unitX[n] = lng[n] / 360 + 0.5;
      const sin = Math.sin(lat[n] * DEG);
      unitY[n] = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    }
    this._unitX = unitX;
    this._unitY = unitY;
  },

  onAdd(map) {
    this._map = map;
    if (!map.getPane(PANE)) {
      map.createPane(PANE).style.zIndex = String(PANE_Z_INDEX);
    }
    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer leaflet-zoom-hide ponding-layer');
    this._ctx = this._canvas.getContext('2d');
    map.getPane(PANE).appendChild(this._canvas);
    this.update();
  },

  onRemove() {
    this._canvas.remove();
    this._canvas = null;
    this._ctx = null;
    this._map = null;
  },

  getEvents() {
    return {
      moveend: this._redraw,
      zoomend: this._redraw,
      resize: this._redraw
    };
  },

  /** Re-read the depths, then repaint. Call after every model render. */
  update() {
    const { depths, edges, stops } = this._source;
    const threshold = stops[0];
    const edgeCount = edges ? edges.length / 2 : 0;
    if (!this._wetEdges || this._wetEdges.length < edgeCount) {
      this._wetEdges = new Int32Array(Math.max(1, edgeCount));
    }

    let wetJunctions = 0;
    for (let n = 0; n < depths.length; n += 1) {
      if (depths[n] >= threshold) {
        wetJunctions += 1;
      }
    }
    let wet = 0;
    for (let e = 0; e < edgeCount; e += 1) {
      if (depths[edges[2 * e]] >= threshold || depths[edges[2 * e + 1]] >= threshold) {
        this._wetEdges[wet] = e;
        wet += 1;
      }
    }
    this._wetCount = wetJunctions;
    this._wetEdgeCount = wet;
    this._redraw();
  },

  /**
   * How many junctions are drawn wet, for readouts and tests. A method, not
   * a getter: Leaflet's extend() copies property values, so a getter would
   * be evaluated once at class definition and frozen.
   */
  wetCount() {
    return this._wetCount;
  },

  _redraw() {
    const map = this._map;
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
    if (this._wetEdgeCount === 0) {
      return;
    }

    const { lat, lng, edges, depths, curbDepthM, streetWidthM, stripWidthM, stops } = this._source;
    this._project();
    const unitX = this._unitX;
    const unitY = this._unitY;
    // The canvas sits at container (0, 0), so a junction's canvas pixel is
    // its world pixel less this origin - two multiplies, no allocation.
    const worldScale = map.options.crs.scale(map.getZoom());
    const canvasAt = map.containerPointToLayerPoint([0, 0]);
    const pixelOrigin = map.getPixelOrigin();
    const offsetX = pixelOrigin.x + canvasAt.x;
    const offsetY = pixelOrigin.y + canvasAt.y;
    const bounds = map.getBounds().pad(0.1);
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();

    // Metres per CSS pixel across the middle of the view, to size the bands.
    const midY = size.y / 2;
    const metersPerPx =
      map.containerPointToLatLng([0, midY]).distanceTo(map.containerPointToLatLng([size.x, midY])) / size.x;
    const widthPx = (metres) => Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, metres / metersPerPx));
    const streetPx = widthPx(streetWidthM);
    const stripPx = widthPx(stripWidthM);

    const classOf = (value) => {
      let cls = 0;
      for (let index = 1; index < stops.length; index += 1) {
        if (value >= stops[index]) {
          cls = index;
        }
      }
      return cls;
    };

    // Each wet link goes into one of ten buckets: its depth class (the
    // deeper end) and whether that water is still on the street or has
    // spread past the kerb. One stroke per bucket - a stroke has one width -
    // shallow classes first so the deep water is painted on top. Overlaps
    // inside a bucket are one stroke, so bands join without darkening.
    const classCount = stops.length;
    const buckets = [];
    for (let i = 0; i < classCount * 2; i += 1) {
      buckets.push([]);
    }

    for (let i = 0; i < this._wetEdgeCount; i += 1) {
      const e = this._wetEdges[i];
      const a = edges[2 * e];
      const b = edges[2 * e + 1];
      const la = lat[a];
      const ln = lng[a];
      const lb = lat[b];
      const lnb = lng[b];
      if (
        (la < south || la > north || ln < west || ln > east) &&
        (lb < south || lb > north || lnb < west || lnb > east)
      ) {
        continue;
      }
      const depth = depths[a] > depths[b] ? depths[a] : depths[b];
      const bucket = classOf(depth) * 2 + (depth > curbDepthM ? 1 : 0);
      buckets[bucket].push(
        unitX[a] * worldScale - offsetX,
        unitY[a] * worldScale - offsetY,
        unitX[b] * worldScale - offsetX,
        unitY[b] * worldScale - offsetY
      );
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let bucket = 0; bucket < buckets.length; bucket += 1) {
      const segments = buckets[bucket];
      if (segments.length === 0) {
        continue;
      }
      const cls = bucket >> 1;
      ctx.strokeStyle = WATER_COLORS[cls];
      ctx.globalAlpha = WATER_ALPHA[cls];
      ctx.lineWidth = bucket & 1 ? stripPx : streetPx;
      ctx.beginPath();
      for (let i = 0; i < segments.length; i += 4) {
        ctx.moveTo(segments[i], segments[i + 1]);
        ctx.lineTo(segments[i + 2], segments[i + 3]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
});

export function createPondingLayer(source, options = {}) {
  return new Ponding(source, options);
}
