// Standing water as pools. Street Flow draws a wet street as a coloured line
// with particles running along it; this layer paints the WATER itself - a
// translucent blue sheet over the ground each wet junction's water has spread
// to (the 120 m² street patch below the kerb, the whole catchment strip above
// it), darker the deeper it stands. Neighbouring wet junctions are 20 m
// apart, so their pools overlap into one sheet and a flooded block reads as a
// flooded block.
//
// It sits in its own pane UNDER the overlay pane, so the street lines, flow
// particles and the storm's rain field all draw on top of it; toggling it
// adds or removes the blue ground beneath them.
//
// One canvas, redrawn on each pan/zoom and on every street-model render: wet
// junctions are collected once per update, then projected and culled to the
// view. Deep water is drawn last so it stays on top.

import L from 'leaflet';

const PANE = 'ponding';
const PANE_Z_INDEX = 390; // tiles are 200, overlays 400
// Light to deep water, one colour per depth class (the same class stops as
// Street Flow: 0.5, 5, 15, 30, 50 cm).
const WATER_COLORS = ['#bae6fd', '#60a5fa', '#2563eb', '#1d4ed8', '#172554'];
const WATER_ALPHA = [0.4, 0.5, 0.58, 0.66, 0.74];
// A pool is never drawn smaller than this on the ground, so junctions 20 m
// apart join up, nor smaller than this on screen, so it shows zoomed out.
const MIN_RADIUS_M = 12;
const MIN_RADIUS_PX = 3;
const MAX_RADIUS_PX = 80;

const Ponding = L.Layer.extend({
  /**
   * @param source { lat, lng, depths, floodAreaM2, patchAreaM2, curbDepthM,
   *   stops } - live views onto the street model's arrays; `depths` is read
   *   afresh on every update.
   */
  initialize(source, options) {
    L.setOptions(this, options);
    this._source = source;
    this._wet = null; // junction indices with standing water, shallow first
    this._wetCount = 0;
    this._redraw = this._redraw.bind(this);
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
    const { depths, stops } = this._source;
    const threshold = stops[0];
    const count = depths.length;
    if (!this._wet || this._wet.length < count) {
      this._wet = new Int32Array(count);
    }

    let wet = 0;
    for (let n = 0; n < count; n += 1) {
      if (depths[n] >= threshold) {
        this._wet[wet] = n;
        wet += 1;
      }
    }
    // Shallow first, so the deepest pools are painted on top.
    this._wet.subarray(0, wet).sort((a, b) => depths[a] - depths[b]);
    this._wetCount = wet;
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
    if (this._wetCount === 0) {
      return;
    }

    const { lat, lng, depths, floodAreaM2, patchAreaM2, curbDepthM, stops } = this._source;
    const bounds = map.getBounds().pad(0.1);
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();

    // Metres per CSS pixel across the middle of the view, to size the pools.
    const midY = size.y / 2;
    const metersPerPx =
      map.containerPointToLatLng([0, midY]).distanceTo(map.containerPointToLatLng([size.x, midY])) / size.x;

    const classOf = (value) => {
      let cls = 0;
      for (let index = 1; index < stops.length; index += 1) {
        if (value >= stops[index]) {
          cls = index;
        }
      }
      return cls;
    };

    // Junctions come shallow-first, so classes arrive in runs; one path per
    // run keeps the fill calls few.
    let currentClass = -1;
    let open = false;
    for (let i = 0; i < this._wetCount; i += 1) {
      const n = this._wet[i];
      const la = lat[n];
      const ln = lng[n];
      if (la < south || la > north || ln < west || ln > east) {
        continue;
      }

      const depth = depths[n];
      const cls = classOf(depth);
      if (cls !== currentClass) {
        if (open) {
          ctx.fill();
        }
        ctx.fillStyle = WATER_COLORS[cls];
        ctx.globalAlpha = WATER_ALPHA[cls];
        ctx.beginPath();
        open = true;
        currentClass = cls;
      }

      const areaM2 = depth <= curbDepthM ? patchAreaM2 : floodAreaM2[n];
      const radiusM = Math.max(MIN_RADIUS_M, Math.sqrt(areaM2 / Math.PI));
      const radiusPx = Math.min(MAX_RADIUS_PX, Math.max(MIN_RADIUS_PX, radiusM / metersPerPx));
      const point = map.latLngToContainerPoint([la, ln]);
      ctx.moveTo(point.x + radiusPx, point.y);
      ctx.arc(point.x, point.y, radiusPx, 0, Math.PI * 2);
    }
    if (open) {
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
});

export function createPondingLayer(source, options = {}) {
  return new Ponding(source, options);
}
