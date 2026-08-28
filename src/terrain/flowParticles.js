import L from 'leaflet';
import { config } from '../config.js';

// Flow direction drawn the way wind maps draw wind: particles ride the
// terrain's flow field for a short life, each leaving a fading trail, and are
// reseeded somewhere else when they die. The trails show which way water
// goes; their pace hints at slope, steeper ground running faster.
//
// The field is the D8 flow direction on the analysis grid turned into unit
// vectors and averaged over a neighbourhood, so a particle curves between
// cells instead of snapping through eight headings. How wide a neighbourhood
// follows the zoom: at province scale one cell is under a pixel and every
// particle would pile into the same valley lines, so the field is averaged
// over more cells there and the trails read as broad streams; zoomed in, the
// averaging narrows and the trails follow individual valleys.
//
// Particles live in lat/lng and are stepped at a pace fixed in screen pixels,
// so the motion looks the same at every zoom. Only the trails are in pixels,
// on one canvas over the map. The canvas is drawn in device pixels with
// one-pixel lines on purpose: that is the renderer's hairline fast path, and
// it is several times cheaper than any wider stroke.
//
// The same recipe - one-pixel trails, the same speed, the same tail - is
// used by the street and flow-path streams further down, so all three flow
// layers read as one style; only the colouring differs.

// Steps per second, whatever the display refresh. Thirty is what wind maps
// run at; the trails hide the cadence, and it halves the drawing work.
const STEP_MS = 30;
// CSS pixels per step for ground at the reference slope; the pace follows the
// square root of slope either side of it, within [MIN_PACE, MAX_PACE].
const BASE_SPEED_PX = 1.3;
// Per-step multiplier on trail alpha. 0.9 fades a trail out over ~28 steps,
// which at BASE_SPEED_PX is a tail of about 37 CSS pixels.
const TRAIL_FADE = 0.9;
const REFERENCE_SLOPE = 0.03;
const MIN_PACE = 0.45;
const MAX_PACE = 1.6;
// Lifetimes in steps, spread so respawns never pulse together.
const MIN_LIFE = 30;
const LIFE_SPAN = 60;
// Random draws per spawn before giving up until the next step; the view can
// be mostly sea, where nothing flows.
const SPAWN_TRIES = 8;
// Below this the interpolated field is the fringe of a still cell, and a
// particle would just crawl: reseed it instead.
const MIN_FLOW_SQ = 0.01;
// Canvas pixels per particle; the count is cut for small viewports.
const PX_PER_PARTICLE = 400;
// Averaging radius in cells is about this many cells per screen pixel a cell
// spans: 6 at province zoom, 3 one zoom in, 1 (the 3x3 box) from town zoom
// inwards.
const SMOOTH_CELLS_PER_PX = 5;
const MAX_SMOOTH_RADIUS = 8;
// Where neighbours disagree this much (a divide), the averaged direction is
// meaningless; the cell is left still so particles reseed rather than wander.
const MIN_AGREEMENT = 0.15;

const BEARINGS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const DEG = Math.PI / 180;
const METERS_PER_DEG_LAT = 110574;

/**
 * The vector field on the analysis grid. `smoothed(radius)` returns an
 * east/north pair per cell averaged over a (2 radius + 1)-cell box, zero
 * where nothing flows (flat, masked out of the drawn area, or no cell).
 */
export function buildFlowField(flowDirection, grid) {
  const { rows, columns, bounds } = grid;
  const count = rows * columns;
  const cellLat = (bounds.north - bounds.south) / rows;
  const cellLng = (bounds.east - bounds.west) / columns;
  const cellMeters = cellLat * METERS_PER_DEG_LAT;

  // Unit direction, pace, and whether the cell flows at all, kept apart so the
  // averaging can renormalise: averaging paced vectors would slow every
  // valley, where flows converge from both sides.
  const dirU = new Float32Array(count);
  const dirV = new Float32Array(count);
  const pace = new Float32Array(count);
  const flowing = new Float32Array(count);

  for (const item of flowDirection) {
    const bearing = BEARINGS[item.direction];
    if (bearing === undefined || !Number.isFinite(item.index)) {
      continue;
    }

    // Height lost to the downstream cell over the distance to it.
    const distance = cellMeters * (bearing % 90 === 0 ? 1 : Math.SQRT2);
    const slope = (item.drop || 0) / distance;
    dirU[item.index] = Math.sin(bearing * DEG);
    dirV[item.index] = Math.cos(bearing * DEG);
    pace[item.index] = Math.min(MAX_PACE, Math.max(MIN_PACE, Math.sqrt(slope / REFERENCE_SLOPE)));
    flowing[item.index] = 1;
  }

  // Box sums over flowing cells only, as two running-sum passes.
  function boxSum(source, radius) {
    const across = new Float32Array(count);
    const prefix = new Float64Array(Math.max(rows, columns) + 1);

    for (let row = 0; row < rows; row += 1) {
      const base = row * columns;
      prefix[0] = 0;
      for (let column = 0; column < columns; column += 1) {
        prefix[column + 1] = prefix[column] + source[base + column];
      }
      for (let column = 0; column < columns; column += 1) {
        const low = Math.max(0, column - radius);
        const high = Math.min(columns - 1, column + radius);
        across[base + column] = prefix[high + 1] - prefix[low];
      }
    }

    const out = new Float32Array(count);
    for (let column = 0; column < columns; column += 1) {
      prefix[0] = 0;
      for (let row = 0; row < rows; row += 1) {
        prefix[row + 1] = prefix[row] + across[row * columns + column];
      }
      for (let row = 0; row < rows; row += 1) {
        const low = Math.max(0, row - radius);
        const high = Math.min(rows - 1, row + radius);
        out[row * columns + column] = prefix[high + 1] - prefix[low];
      }
    }

    return out;
  }

  const cache = new Map();

  function smoothed(radius) {
    if (cache.has(radius)) {
      return cache.get(radius);
    }

    const sumU = boxSum(dirU, radius);
    const sumV = boxSum(dirV, radius);
    const sumPace = boxSum(pace, radius);
    const n = boxSum(flowing, radius);
    const u = new Float32Array(count);
    const v = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      // Still cells stay still, so the field never grows past the drawn area.
      if (flowing[index] === 0 || n[index] === 0) {
        continue;
      }

      const meanU = sumU[index] / n[index];
      const meanV = sumV[index] / n[index];
      const agreement = Math.hypot(meanU, meanV);
      if (agreement < MIN_AGREEMENT) {
        continue;
      }

      const meanPace = sumPace[index] / n[index];
      u[index] = (meanU / agreement) * meanPace;
      v[index] = (meanV / agreement) * meanPace;
    }

    const result = { u, v };
    cache.set(radius, result);
    return result;
  }

  return { rows, columns, bounds, cellLat, cellLng, smoothed };
}

// --- shared canvas plumbing --------------------------------------------------
//
// Both particle layers draw on one canvas anchored to the viewport. What
// happens to that canvas when the map moves decides whether the animation
// feels continuous: clearing it and reseeding on every pan made the flow
// restart from scratch each time the map was dragged. Instead the existing
// trails are carried across the pan (the canvas content is shifted by the
// pan distance) and particles keep their geographic positions; only a zoom
// change, which invalidates the pixels, clears the canvas - and even then the
// particles carry on from where they were.

/** Size the canvas to the map, anchor it, and return the projection origin. */
function anchorCanvas(layer, map) {
  const size = map.getSize();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(size.x * ratio);
  const height = Math.round(size.y * ratio);
  const resized = layer._canvas.width !== width || layer._canvas.height !== height;
  if (resized) {
    layer._canvas.width = width;
    layer._canvas.height = height;
    layer._canvas.style.width = `${size.x}px`;
    layer._canvas.style.height = `${size.y}px`;
  }
  layer._ratio = ratio;

  // Canvas pixels are layer pixels minus where the canvas sits, so drawing
  // stays put while the map pane is dragged underneath the next reset.
  const position = map.containerPointToLayerPoint([0, 0]);
  L.DomUtil.setPosition(layer._canvas, position);
  const origin = map.getPixelOrigin().add(position);
  const scale = map.options.crs.scale(map.getZoom());

  const previous = { x: layer._originX, y: layer._originY, scale: layer._scale };
  layer._originX = origin.x;
  layer._originY = origin.y;
  layer._scale = scale;
  layer._ctx.setTransform(1, 0, 0, 1, 0, 0);

  return { resized, previous };
}

/**
 * Carry the drawn trails across a pan: the canvas content is redrawn shifted
 * by the pan distance. Any pixels needed beyond the old edge are simply
 * blank and fill in as particles arrive. Returns false when the picture
 * cannot be carried (zoom changed, canvas resized, or nothing yet) and the
 * canvas has been cleared instead.
 */
function carryCanvas(layer, { resized, previous }) {
  const { _canvas: canvas, _ctx: ctx } = layer;
  const canCarry =
    !resized && Number.isFinite(previous.x) && previous.scale === layer._scale;

  if (!canCarry) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return false;
  }

  const dx = Math.round((previous.x - layer._originX) * layer._ratio);
  const dy = Math.round((previous.y - layer._originY) * layer._ratio);
  if (dx === 0 && dy === 0) {
    return true;
  }

  // Through a scratch copy: drawing a canvas onto itself with overlap is
  // undefined by the spec.
  if (!layer._scratch) {
    layer._scratch = document.createElement('canvas');
  }
  const scratch = layer._scratch;
  if (scratch.width !== canvas.width || scratch.height !== canvas.height) {
    scratch.width = canvas.width;
    scratch.height = canvas.height;
  }
  const scratchCtx = scratch.getContext('2d');
  scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
  scratchCtx.drawImage(canvas, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(scratch, dx, dy);
  return true;
}

const FlowParticles = L.Layer.extend({
  options: {
    pane: 'overlayPane',
    count: 2500,
    color: '#1d4ed8',
    // On imagery the blue vanishes; a pale trail reads instead.
    darkColor: '#dbeafe',
    isDark: () => false
  },

  initialize(field, options) {
    L.setOptions(this, options);
    this._field = field;
    this._dark = false;
    this._raf = 0;
    this._lastStep = 0;
    this._originX = Number.NaN;
    this._originY = Number.NaN;
    this._scale = 0;
    this._frame = this._frame.bind(this);
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer leaflet-zoom-hide flow-particles');
    this._ctx = this._canvas.getContext('2d');
    this.getPane().appendChild(this._canvas);
    this._originX = Number.NaN;
    this._reset();
    this._raf = requestAnimationFrame(this._frame);
  },

  onRemove() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._canvas.remove();
    this._canvas = null;
    this._ctx = null;
    this._map = null;
  },

  getEvents() {
    return {
      moveend: this._reset,
      zoomend: this._reset,
      resize: this._reset,
      baselayerchange: this._onBaseLayer
    };
  },

  _onBaseLayer(event) {
    this._dark = Boolean(this.options.isDark(event.name));
  },

  /**
   * Re-anchor the canvas and the projection to the current view. Particles
   * keep their positions; the trails are carried across a pan and cleared
   * only when the zoom changes. Reseeding happens only when the fleet is
   * first allocated or its size changes.
   */
  _reset() {
    const map = this._map;
    if (!map || !this._canvas) {
      return;
    }

    const anchored = anchorCanvas(this, map);
    const size = map.getSize();

    // CSS pixels per degree at the view's latitude: Web Mercator is linear in
    // longitude and stretches latitude by 1/cos. The province spans a degree,
    // over which the difference is under half a percent.
    this._pxPerDegLng = this._scale / 360;
    this._pxPerDegLat = this._pxPerDegLng / Math.cos(map.getCenter().lat * DEG);

    // Average the field more widely the less of the screen a cell covers.
    const field = this._field;
    const pxPerCell = field.cellLat * this._pxPerDegLat;
    const radius = Math.max(
      1,
      Math.min(MAX_SMOOTH_RADIUS, Math.round(SMOOTH_CELLS_PER_PX / pxPerCell))
    );
    const smoothed = field.smoothed(radius);
    this._u = smoothed.u;
    this._v = smoothed.v;

    // Seed only where the view and the field overlap.
    const view = map.getBounds();
    const { bounds } = field;
    this._spawnBox = {
      south: Math.max(view.getSouth(), bounds.south),
      north: Math.min(view.getNorth(), bounds.north),
      west: Math.max(view.getWest(), bounds.west),
      east: Math.min(view.getEast(), bounds.east)
    };
    this._canSpawn =
      this._spawnBox.north > this._spawnBox.south && this._spawnBox.east > this._spawnBox.west;

    const count = Math.max(
      0,
      Math.min(this.options.count, Math.round((size.x * size.y) / PX_PER_PARTICLE))
    );
    const fresh = !this._lat || this._lat.length !== count;
    if (fresh) {
      this._lat = new Float64Array(count);
      this._lng = new Float64Array(count);
      this._px = new Float32Array(count);
      this._py = new Float32Array(count);
      this._age = new Uint16Array(count);
      this._life = new Uint16Array(count);
      this._alive = new Uint8Array(count);
    }

    carryCanvas(this, anchored);

    if (fresh) {
      for (let i = 0; i < count; i += 1) {
        this._spawn(i);
        // Stagger ages so the first generation does not die all at once.
        this._age[i] = Math.floor(Math.random() * this._life[i]);
      }
      return;
    }

    // Same fleet, new projection: re-plot every live particle where it is.
    // Any now off screen will reseed on their next step.
    for (let i = 0; i < count; i += 1) {
      if (this._alive[i]) {
        this._project(this._lat[i], this._lng[i], i);
      }
    }
  },

  _project(lat, lng, i) {
    const sin = Math.sin(lat * DEG);
    this._px[i] = ((lng / 360 + 0.5) * this._scale - this._originX) * this._ratio;
    this._py[i] =
      ((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * this._scale - this._originY) *
      this._ratio;
  },

  /** Drop particle i somewhere in view that flows; dead until one is found. */
  _spawn(i) {
    this._alive[i] = 0;
    if (!this._canSpawn) {
      return;
    }

    const box = this._spawnBox;
    const field = this._field;
    for (let attempt = 0; attempt < SPAWN_TRIES; attempt += 1) {
      const lat = box.south + Math.random() * (box.north - box.south);
      const lng = box.west + Math.random() * (box.east - box.west);
      const row = Math.floor((field.bounds.north - lat) / field.cellLat);
      const column = Math.floor((lng - field.bounds.west) / field.cellLng);
      if (row < 0 || column < 0 || row >= field.rows || column >= field.columns) {
        continue;
      }

      const index = row * field.columns + column;
      if (this._u[index] === 0 && this._v[index] === 0) {
        continue;
      }

      this._lat[i] = lat;
      this._lng[i] = lng;
      this._age[i] = 0;
      this._life[i] = MIN_LIFE + Math.floor(Math.random() * LIFE_SPAN);
      this._alive[i] = 1;
      this._project(lat, lng, i);
      return;
    }
  },

  _frame(now) {
    this._raf = requestAnimationFrame(this._frame);

    // Hold the step rate whatever the display refresh: every other frame at
    // 60 Hz, every fourth at 120 Hz.
    if (now - this._lastStep < STEP_MS - 1) {
      return;
    }
    this._lastStep = now;

    const ctx = this._ctx;
    const canvas = this._canvas;
    if (!ctx || canvas.width === 0 || canvas.height === 0) {
      return;
    }

    // Age what is on the canvas: destination-in keeps the colour and scales
    // every pixel's alpha, which is what makes the tails.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    ctx.strokeStyle = this._dark ? this.options.darkColor : this.options.color;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.beginPath();

    const { rows, columns, bounds, cellLat, cellLng } = this._field;
    const fieldU = this._u;
    const fieldV = this._v;
    const lats = this._lat;
    const lngs = this._lng;
    const px = this._px;
    const py = this._py;
    const age = this._age;
    const life = this._life;
    const alive = this._alive;
    const stepLat = BASE_SPEED_PX / this._pxPerDegLat;
    const stepLng = BASE_SPEED_PX / this._pxPerDegLng;
    const scale = this._scale;
    const originX = this._originX;
    const originY = this._originY;
    const ratio = this._ratio;
    const width = canvas.width;
    const height = canvas.height;
    const margin = 8;

    for (let i = 0; i < lats.length; i += 1) {
      if (!alive[i]) {
        this._spawn(i);
        continue;
      }

      age[i] += 1;
      if (age[i] > life[i]) {
        this._spawn(i);
        continue;
      }

      // Bilinear sample of the field, cell centres at (row + 0.5, col + 0.5).
      const gx = (lngs[i] - bounds.west) / cellLng - 0.5;
      const gy = (bounds.north - lats[i]) / cellLat - 0.5;
      const c0 = Math.floor(gx);
      const r0 = Math.floor(gy);
      const fx = gx - c0;
      const fy = gy - r0;
      let u = 0;
      let v = 0;

      for (let corner = 0; corner < 4; corner += 1) {
        const r = r0 + (corner >> 1);
        const c = c0 + (corner & 1);
        if (r < 0 || c < 0 || r >= rows || c >= columns) {
          continue;
        }
        const weight = (corner & 1 ? fx : 1 - fx) * (corner >> 1 ? fy : 1 - fy);
        const index = r * columns + c;
        u += fieldU[index] * weight;
        v += fieldV[index] * weight;
      }

      if (u * u + v * v < MIN_FLOW_SQ) {
        this._spawn(i);
        continue;
      }

      const lat = lats[i] + v * stepLat;
      const lng = lngs[i] + u * stepLng;
      const sin = Math.sin(lat * DEG);
      const x = ((lng / 360 + 0.5) * scale - originX) * ratio;
      const y =
        ((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale - originY) * ratio;

      if (x < -margin || y < -margin || x > width + margin || y > height + margin) {
        this._spawn(i);
        continue;
      }

      ctx.moveTo(px[i], py[i]);
      ctx.lineTo(x, y);
      px[i] = x;
      py[i] = y;
      lats[i] = lat;
      lngs[i] = lng;
    }

    ctx.stroke();
  }
});

/**
 * Flow Direction as animated particles over the analysis grid.
 * `flowDirection` is the (already clipped) per-cell list; `grid` supplies its
 * shape and bounds.
 */
export function createFlowParticleLayer(flowDirection, grid, options = {}) {
  const field = buildFlowField(flowDirection, grid);
  return new FlowParticles(field, { count: config.flowParticleCount, ...options });
}

// --- street streams ---------------------------------------------------------
//
// Street Flow and Flow Paths are drawn by particles that ride their traced
// chains downstream - the same trail recipe as the field particles above,
// with advection following the polylines rather than a grid, so a particle
// traces the exact line its water is on. The Leaflet polylines underneath are
// never painted (they stay as hover targets for the tooltips); the trails are
// the layer.
//
// The layer has a second, "classic" rendering - marching dashes, drawn solid
// when zoomed far out - chosen with Shift held while ticking the layer. It
// used to be an SVG stroke animation, which re-rasterised thousands of dashed
// subpaths every frame and lagged the map; here the dashes are placed along
// the chains by arithmetic from a clock phase and stroked on this canvas,
// which costs about what the trails do.

// Long lives: chains are linked end-to-downstream, so one particle can run a
// whole stem, and the run length is set by the lifetime.
const STREAM_MIN_LIFE = 60;
const STREAM_LIFE_SPAN = 180;
// Runners are spaced along the DRAWN NETWORK rather than sprinkled over the
// viewport, so their density does not change with how much network happens to
// be on screen. With ~37 px tails, 40 px spacing inks most of a line while
// leaving a moving gap behind every runner - which is what reads as flow.
//
// Spacing across the whole network is not enough to make it read, though. The
// chains are wildly uneven - a few trunks carry most of the metres, while
// thousands of side streets are a dozen pixels each - and runners flow
// downstream, so they gathered on the trunks and left the rest of the map
// blank beside the classic dashes, which ink every chain there is.
//
// So the spacing is applied PER CHAIN: each one in view is due a runner every
// 40 px of itself, and never fewer than one. The fleet is the sum of those
// dues, a runner that flows into a chain already carrying its share is sent
// to refill one that is short instead, and a spawn looks for the short ones.
// Every street is inked, and the trunks still carry the thickest flow.
const TARGET_SPACING_PX = 40;
const STREAM_MAX_COUNT = 12000;
// How many chains a spawn will look at before settling for one by length. A
// full sweep would be thousands of steps for the last few runners of a full
// network, every one of them a dead end.
const UNCOVERED_TRIES = 96;

/**
 * How much of the network the chain layers draw, as a share of the chains in
 * view, longest first. 1 is every one of them - a street at a time, the way
 * the classic dashes have always been drawn. Lower keeps only the longer
 * chains, so the picture generalises to the main channels and both renderings
 * get cheaper with it.
 *
 * One value for every chain layer on the map: Flow Paths and Street Flow are
 * read together, and a detail control that left them disagreeing would be
 * worse than none.
 */
let chainDetail = 1;
const chainLayers = new Set();

export function setChainDetail(value) {
  const next = Math.max(0.02, Math.min(1, Number(value) || 0));
  if (next === chainDetail) {
    return;
  }

  chainDetail = next;
  for (const layer of chainLayers) {
    layer._applyDetail();
  }
}

export function chainDetailValue() {
  return chainDetail;
}

/**
 * The length a chain must reach to be drawn: the (1 - detail) quantile of the
 * lengths on screen, so the share kept is the share asked for whatever the
 * network and the zoom. Sorting a few thousand floats happens on a view
 * change, not on a frame.
 */
function detailCutoff(lengths, count) {
  if (chainDetail >= 1 || count === 0) {
    return 0;
  }

  const sorted = lengths.subarray(0, count).slice().sort();
  const at = Math.min(count - 1, Math.floor((1 - chainDetail) * count));
  return sorted[at];
}

// Classic dashes: the SVG stroke was `stroke-dasharray: 5 9` marching one
// period every 1.1 s.
const DASH_PX = 5;
const DASH_PERIOD_PX = 14;
const DASH_PERIOD_MS = 1100;

// Trail palettes per colour class. The trails carry the layer's colours
// themselves - green to red for how much water - matching ACCUMULATION_COLORS
// (hardcoded: importing flow.js here would be circular). Imagery gets
// brighter variants that survive a dark background.
const CHAIN_COLORS = ['#16a34a', '#84cc16', '#eab308', '#f97316', '#dc2626'];
const CHAIN_COLORS_DARK = ['#4ade80', '#a3e635', '#facc15', '#fb923c', '#f87171'];

/**
 * Chains flattened to typed arrays: positions, cumulative metres along each
 * chain, and a running total of chain lengths so spawning can pick a chain
 * with probability proportional to its length.
 */
function flattenChains(lines) {
  const kept = [];
  let vertexTotal = 0;
  for (const line of lines) {
    if (line.points && line.points.length >= 2) {
      kept.push(line);
      vertexTotal += line.points.length;
    }
  }

  if (kept.length === 0) {
    return null;
  }

  const lat = new Float64Array(vertexTotal);
  const lng = new Float64Array(vertexTotal);
  const along = new Float64Array(vertexTotal); // metres from the chain start
  const first = new Int32Array(kept.length);
  const last = new Int32Array(kept.length); // index of the chain's final vertex
  const pace = new Float32Array(kept.length);
  const shade = new Uint8Array(kept.length); // colour class, for the trail hue
  const lengthPrefix = new Float64Array(kept.length + 1);

  let at = 0;
  for (let index = 0; index < kept.length; index += 1) {
    const points = kept[index].points;
    first[index] = at;
    last[index] = at + points.length - 1;
    // Busier classes carry more water; let their particles run a bit faster.
    pace[index] = 1 + (kept[index].colorClass || 0) * 0.2;
    shade[index] = Math.max(0, Math.min(CHAIN_COLORS.length - 1, kept[index].colorClass || 0));

    let travelled = 0;
    for (let i = 0; i < points.length; i += 1) {
      lat[at] = points[i][0];
      lng[at] = points[i][1];
      if (i > 0) {
        const dy = (lat[at] - lat[at - 1]) * METERS_PER_DEG_LAT;
        const dx = (lng[at] - lng[at - 1]) * 111320 * Math.cos(lat[at] * DEG);
        travelled += Math.hypot(dx, dy);
      }
      along[at] = travelled;
      at += 1;
    }

    lengthPrefix[index + 1] = lengthPrefix[index] + travelled;
  }

  // Link each chain's end to the downstream chain it merges into. Chains are
  // drawn each-edge-once, so a tributary STOPS where it meets an already-drawn
  // trunk, and a trunk is split wherever its colour class changes - but the
  // water does not stop there. The link lets a particle ride on through, so
  // its trail runs the length of the stem instead of one short piece, which
  // is what makes the layer read as flow rather than as a static stipple.
  const nextLine = new Int32Array(kept.length).fill(-1);
  const nextSeg = new Int32Array(kept.length);
  const nextAlong = new Float64Array(kept.length);

  // Every vertex, keyed by an integer hash of its coordinates. Ends match
  // interior vertices of their continuation exactly, because both were copied
  // from the same source arrays, so the hash only has to bucket them - an
  // exact comparison settles it. Building a STRING key per vertex here was
  // measured at ~59 ms of every storm rebuild, by far the most expensive
  // thing this layer did.
  const hashAt = (index) =>
    (Math.imul(Math.round(lat[index] * 1e6), 73856093) ^
      Math.imul(Math.round(lng[index] * 1e6), 19349663)) >>> 0;

  const vertexIndex = new Map();
  for (let index = 0; index < kept.length; index += 1) {
    for (let v = first[index]; v <= last[index]; v += 1) {
      const key = hashAt(v);
      const bucket = vertexIndex.get(key);
      if (bucket) {
        bucket.push(v);
      } else {
        vertexIndex.set(key, [v]);
      }
    }
  }

  // first[] is ascending, so a vertex's owning line is a binary search away.
  const lineOfVertex = (v) => {
    let low = 0;
    let high = kept.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (first[mid] <= v) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  };

  for (let index = 0; index < kept.length; index += 1) {
    const end = last[index];
    const matches = vertexIndex.get(hashAt(end)) || [];
    // Of the chains passing through this junction, continue into the one with
    // the most length still downstream - the main stem.
    let bestRemaining = 0;
    for (const v of matches) {
      // Hashes can collide; the join has to be the very same point.
      if (lat[v] !== lat[end] || lng[v] !== lng[end]) {
        continue;
      }
      const owner = lineOfVertex(v);
      if (owner === index || v >= last[owner]) {
        continue;
      }
      const remaining = along[last[owner]] - along[v];
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        nextLine[index] = owner;
        nextSeg[index] = v;
        nextAlong[index] = along[v];
      }
    }
  }

  return {
    lat,
    lng,
    along,
    first,
    last,
    pace,
    shade,
    nextLine,
    nextSeg,
    nextAlong,
    lengthPrefix,
    lineCount: kept.length,
    totalMeters: lengthPrefix[kept.length]
  };
}

const ChainParticles = L.Layer.extend({
  options: {
    pane: 'overlayPane',
    isDark: () => false
  },

  initialize(options) {
    L.setOptions(this, options);
    this._geometry = null;
    this._dark = false;
    this._raf = 0;
    // Chains in view, which of them carry a runner, and where the next spawn
    // starts looking for one that does not.
    this._lineDrawn = null;
    this._lineOnScreen = null;
    this._visibleLines = null;
    this._quota = null;
    this._load = null;
    this._chainPx = null;
    this._lengths = null;
    this._quotaTotal = 0;
    this._spawnCursor = 0;
    this._segBuf = null;
    this._segCount = null;
    this._visiblePx = 0;
    this._lastStep = 0;
    this._mode = 'trail';
    this._staticDrawn = false;
    this._originX = Number.NaN;
    this._originY = Number.NaN;
    this._scale = 0;
    this._frame = this._frame.bind(this);
  },

  /**
   * Feed the chains currently drawn: [{ points: [[lat, lng], ...],
   * colorClass }]. Called on every street-flow rebuild. The canvas is
   * deliberately not cleared here: old trails fade away over the next half
   * second while particles restart on the new geometry, instead of the layer
   * blinking blank on every storm refresh.
   */
  setLines(lines) {
    this._geometry = flattenChains(lines || []);
    this._staticDrawn = false;
    if (this._map) {
      this._projectVertices();
      // New geometry, so every particle's chain index is stale: reseed.
      this._resizeFleet({ keep: false });
    }
  },

  /** 'trail' (the default streams) or 'dash' (the classic marching dashes). */
  setMode(mode) {
    const next = mode === 'dash' ? 'dash' : 'trail';
    if (next === this._mode) {
      return;
    }

    this._mode = next;
    this._staticDrawn = false;
    if (this._ctx) {
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer leaflet-zoom-hide flow-particles');
    this._ctx = this._canvas.getContext('2d');
    this.getPane().appendChild(this._canvas);
    this._originX = Number.NaN;
    chainLayers.add(this);
    this._reset();
    this._raf = requestAnimationFrame(this._frame);
  },

  onRemove() {
    chainLayers.delete(this);
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._canvas.remove();
    this._canvas = null;
    this._ctx = null;
    this._map = null;
  },

  getEvents() {
    return {
      moveend: this._reset,
      zoomend: this._reset,
      resize: this._reset,
      baselayerchange: this._onBaseLayer
    };
  },

  _onBaseLayer(event) {
    this._dark = Boolean(this.options.isDark(event.name));
    this._staticDrawn = false;
  },

  /**
   * Re-anchor to the current view. Trails are carried across a pan and the
   * particles keep their places on their chains; the fleet is only resized
   * (and the newcomers seeded) to match the network now in view.
   */
  _reset() {
    const map = this._map;
    if (!map || !this._canvas) {
      return;
    }

    const anchored = anchorCanvas(this, map);

    // Metres per CSS pixel at this zoom, so the on-screen pace stays the
    // same whatever the scale.
    const centerLat = map.getCenter().lat * DEG;
    const pxPerDegLng = this._scale / 360;
    this._stepMeters = (BASE_SPEED_PX * 111320 * Math.cos(centerLat)) / pxPerDegLng;

    this._projectVertices();
    this._staticDrawn = false;
    carryCanvas(this, anchored);
    this._resizeFleet({ keep: true });
  },

  /**
   * Every chain vertex in device pixels for the current view, plus which
   * chains touch the view at all. Shared by the density figure, the dashes,
   * and the solid zoomed-out drawing, so the projection is done once per
   * view change rather than per use.
   */
  _projectVertices() {
    const geometry = this._geometry;
    if (!geometry || !this._canvas) {
      this._vx = null;
      this._vy = null;
      this._lineDrawn = null;
      this._lineOnScreen = null;
      this._visibleLines = null;
      this._quota = null;
      this._load = null;
      this._chainPx = null;
      this._lengths = null;
      this._quotaTotal = 0;
      this._visiblePx = 0;
      return;
    }

    const { lat, lng, first, last, lineCount } = geometry;
    const total = lat.length;
    if (!this._vx || this._vx.length !== total) {
      this._vx = new Float32Array(total);
      this._vy = new Float32Array(total);
    }
    if (!this._lineDrawn || this._lineDrawn.length !== lineCount) {
      this._lineDrawn = new Uint8Array(lineCount);
      this._lineOnScreen = new Uint8Array(lineCount);
      this._quota = new Uint16Array(lineCount);
      this._load = new Uint16Array(lineCount);
      this._chainPx = new Float32Array(lineCount);
      this._lengths = new Float32Array(lineCount);
    }

    const vx = this._vx;
    const vy = this._vy;
    const drawn = this._lineDrawn;
    const width = this._canvas.width;
    const height = this._canvas.height;
    const scale = this._scale;
    const originX = this._originX;
    const originY = this._originY;
    const ratio = this._ratio;
    // A generous margin so chains crossing the edge still get their dashes.
    const margin = 40 * ratio;
    let visible = 0;
    let visibleLines = 0;
    let quotaTotal = 0;
    const quota = this._quota;
    const chainPx = this._chainPx;
    const onScreen = this._lineOnScreen;
    let seen = 0;

    // First pass: project, and measure how much of each chain is on screen.
    for (let line = 0; line < lineCount; line += 1) {
      let touches = 0;
      let prevInside = false;
      let chainVisible = 0;
      for (let v = first[line]; v <= last[line]; v += 1) {
        const sin = Math.sin(lat[v] * DEG);
        const x = ((lng[v] / 360 + 0.5) * scale - originX) * ratio;
        const y =
          ((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale - originY) * ratio;
        vx[v] = x;
        vy[v] = y;
        const inside = x >= -margin && y >= -margin && x <= width + margin && y <= height + margin;
        if (inside) {
          touches = 1;
        }
        if (v > first[line] && (inside || prevInside)) {
          chainVisible += Math.hypot(x - vx[v - 1], y - vy[v - 1]);
        }
        prevInside = inside;
      }

      onScreen[line] = touches;
      chainPx[line] = chainVisible / ratio;
      if (touches) {
        this._lengths[seen] = chainPx[line];
        seen += 1;
      }
    }

    // Second pass: keep the share of them the detail control asks for,
    // longest first, and work out what each is due.
    const cutoff = detailCutoff(this._lengths, seen);
    for (let line = 0; line < lineCount; line += 1) {
      const keep = onScreen[line] && chainPx[line] >= cutoff ? 1 : 0;
      drawn[line] = keep;
      if (!keep) {
        quota[line] = 0;
        continue;
      }

      visible += chainPx[line];
      visibleLines += 1;
      // What this chain is due: one runner per 40 px of itself, and at least
      // one for any chain drawn at all, however short.
      quota[line] = Math.max(1, Math.round(chainPx[line] / TARGET_SPACING_PX));
      quotaTotal += quota[line];
    }

    this._quotaTotal = quotaTotal;

    // The chains being drawn, listed, so a spawn can walk them looking for one
    // that is short of its share instead of scanning the whole network.
    if (!this._visibleLines || this._visibleLines.length !== visibleLines) {
      this._visibleLines = new Int32Array(visibleLines);
    }
    let at = 0;
    for (let line = 0; line < lineCount; line += 1) {
      if (drawn[line]) {
        this._visibleLines[at] = line;
        at += 1;
      }
    }
    if (this._spawnCursor >= visibleLines) {
      this._spawnCursor = 0;
    }

    // Already in CSS pixels: the spacing target is a screen figure.
    this._visiblePx = visible;
  },

  /** The detail control moved: re-pick the chains and re-size the fleet. */
  _applyDetail() {
    if (!this._map || !this._geometry) {
      return;
    }

    this._projectVertices();
    this._resizeFleet({ keep: true });
    // The zoomed-out dash drawing is painted once and kept; it has to go.
    this._staticDrawn = false;
  },

  /**
   * Size the fleet to the network in view. With keep, existing particles
   * stay where they are on their chains (re-plotted for the new view) and
   * only the extra slots are seeded; without it everything is reseeded.
   */
  _resizeFleet({ keep }) {
    // Exactly what the chains in view are due between them, so every street
    // carries flow the way the classic dashes do and the long ones carry more.
    const count = Math.max(0, Math.min(STREAM_MAX_COUNT, this._quotaTotal || 0));

    const had = this._line ? this._line.length : 0;
    if (had !== count) {
      const grow = (Type, old) => {
        const next = new Type(count);
        if (old && keep) {
          next.set(old.subarray(0, Math.min(had, count)));
        }
        return next;
      };
      this._line = grow(Int32Array, this._line);
      this._seg = grow(Int32Array, this._seg);
      this._dist = grow(Float64Array, this._dist);
      this._px = grow(Float32Array, this._px);
      this._py = grow(Float32Array, this._py);
      this._age = grow(Uint16Array, this._age);
      this._life = grow(Uint16Array, this._life);
      this._alive = grow(Uint8Array, this._alive);
      // One segment per runner per step, gathered per colour class before
      // stroking. Typed and preallocated: growing five JS arrays by four
      // numbers per runner, every step, cost more than the drawing did.
      this._segBuf = CHAIN_COLORS.map(() => new Float32Array(count * 4));
      this._segCount = new Int32Array(CHAIN_COLORS.length);
    }

    if (!keep || had === 0) {
      this._respawnAll();
      return;
    }

    // Re-plot the survivors; newcomers (alive = 0) seed on their next step.
    for (let i = 0; i < Math.min(had, count); i += 1) {
      if (this._alive[i]) {
        this._replot(i);
      }
    }
  },

  _respawnAll() {
    if (!this._alive) {
      return;
    }

    for (let i = 0; i < this._alive.length; i += 1) {
      this._spawn(i);
      this._age[i] = Math.floor(Math.random() * this._life[i]);
    }
  },

  /** Pixel position of particle i from its chain place, for the current view. */
  _replot(i) {
    const geometry = this._geometry;
    const line = this._line[i];
    if (!geometry || line >= geometry.lineCount) {
      this._alive[i] = 0;
      return;
    }

    const { along, last } = geometry;
    const segment = this._seg[i];
    if (segment >= last[line]) {
      this._alive[i] = 0;
      return;
    }

    const span = along[segment + 1] - along[segment] || 1;
    const t = (this._dist[i] - along[segment]) / span;
    const vx = this._vx;
    const vy = this._vy;
    this._px[i] = vx[segment] + (vx[segment + 1] - vx[segment]) * t;
    this._py[i] = vy[segment] + (vy[segment + 1] - vy[segment]) * t;
  },

  /**
   * Put particle i at `distance` along `line`, if that point is on screen.
   * Returns whether it took.
   */
  _settle(i, line, distance) {
    const { first, last, along } = this._geometry;
    let segment = first[line];
    while (segment < last[line] && along[segment + 1] < distance) {
      segment += 1;
    }
    if (segment >= last[line]) {
      return false;
    }

    const span = along[segment + 1] - along[segment] || 1;
    const t = (distance - along[segment]) / span;
    const x = this._vx[segment] + (this._vx[segment + 1] - this._vx[segment]) * t;
    const y = this._vy[segment] + (this._vy[segment + 1] - this._vy[segment]) * t;
    if (x < -8 || y < -8 || x > this._canvas.width + 8 || y > this._canvas.height + 8) {
      return false;
    }

    this._line[i] = line;
    this._seg[i] = segment;
    this._dist[i] = distance;
    this._px[i] = x;
    this._py[i] = y;
    this._age[i] = 0;
    this._life[i] = STREAM_MIN_LIFE + Math.floor(Math.random() * STREAM_LIFE_SPAN);
    this._alive[i] = 1;
    return true;
  },

  /** Drop particle i on a chain that has nothing on it, or failing that, on
   * one picked by length. */
  _spawn(i) {
    this._alive[i] = 0;
    const geometry = this._geometry;
    if (!geometry || geometry.totalMeters <= 0 || !this._canvas) {
      return;
    }

    const { lengthPrefix, last, along } = geometry;

    // Runners flow downstream and gather on the trunks, and a spawn weighted
    // by length only sends them back to the same trunks. Refilling a chain
    // that is short of its due is what keeps the side streets inked.
    const visible = this._visibleLines;
    const load = this._load;
    const quota = this._quota;
    if (visible && visible.length > 0 && load) {
      for (let tries = 0; tries < UNCOVERED_TRIES; tries += 1) {
        const line = visible[this._spawnCursor];
        this._spawnCursor += 1;
        if (this._spawnCursor >= visible.length) {
          this._spawnCursor = 0;
        }

        const length = along[last[line]];
        if (load[line] >= quota[line] || !(length > 0)) {
          continue;
        }
        if (this._settle(i, line, Math.random() * length)) {
          load[line] += 1;
          return;
        }
      }
    }

    // Every chain in view is carrying its share: spread the rest by length, so
    // the busiest chains carry the thickest flow.
    for (let attempt = 0; attempt < SPAWN_TRIES; attempt += 1) {
      const target = Math.random() * geometry.totalMeters;

      // Which chain holds that running metre: binary search the prefix sums.
      let low = 0;
      let high = geometry.lineCount - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (lengthPrefix[mid + 1] <= target) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      const line = low;
      if (!this._lineDrawn[line]) {
        continue;
      }

      if (this._settle(i, line, target - lengthPrefix[line])) {
        if (load) {
          load[line] += 1;
        }
        return;
      }
    }
  },

  _frame(now) {
    this._raf = requestAnimationFrame(this._frame);

    if (now - this._lastStep < STEP_MS - 1) {
      return;
    }
    this._lastStep = now;

    const ctx = this._ctx;
    const canvas = this._canvas;
    if (!ctx || canvas.width === 0 || canvas.height === 0) {
      return;
    }

    if (this._mode === 'dash') {
      this._frameDash(now);
      return;
    }

    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    const geometry = this._geometry;
    if (!geometry || !this._alive) {
      return;
    }

    // What each chain is carrying as this frame starts, so the spawns below
    // can top up the ones that are short.
    const load = this._load;
    const quota = this._quota;
    if (load) {
      load.fill(0);
      for (let i = 0; i < this._alive.length; i += 1) {
        if (this._alive[i]) {
          load[this._line[i]] += 1;
        }
      }
    }

    ctx.lineWidth = 1;
    ctx.lineCap = 'round';

    const { along, last, pace, shade, nextLine, nextSeg, nextAlong } = geometry;
    const vx = this._vx;
    const vy = this._vy;
    const width = canvas.width;
    const height = canvas.height;

    // Segments gathered per colour class, then stroked class by class, so a
    // trail carries its own chain's hue. Flat [x0, y0, x1, y1] runs.
    const palette = this._dark ? CHAIN_COLORS_DARK : CHAIN_COLORS;
    const segBuf = this._segBuf;
    const segCount = this._segCount;
    if (!segBuf) {
      return;
    }
    segCount.fill(0);

    for (let i = 0; i < this._alive.length; i += 1) {
      if (!this._alive[i]) {
        this._spawn(i);
        continue;
      }

      this._age[i] += 1;
      if (this._age[i] > this._life[i]) {
        this._spawn(i);
        continue;
      }

      let line = this._line[i];
      const from = line;
      // Guard against geometry swapped out from under a live particle.
      if (line >= geometry.lineCount) {
        this._spawn(i);
        continue;
      }

      // Chains are built upstream -> downstream, so forward is downhill. On
      // reaching a chain's end the particle rides the link into the
      // downstream chain and keeps going; only a true outlet (or old age)
      // ends the run.
      let distance = this._dist[i] + this._stepMeters * pace[line];
      let segment = this._seg[i];
      let ended = false;
      for (let jumps = 0; jumps < 8; jumps += 1) {
        while (segment < last[line] && along[segment + 1] < distance) {
          segment += 1;
        }
        if (segment < last[line]) {
          break;
        }
        const next = nextLine[line];
        if (next < 0) {
          ended = true;
          break;
        }
        distance = nextAlong[line] + (distance - along[last[line]]);
        segment = nextSeg[line];
        line = next;
      }
      if (ended || segment >= last[line]) {
        if (load) {
          load[from] -= 1;
        }
        this._spawn(i);
        continue;
      }

      // Flowed on into another chain. If that one already carries its share,
      // this runner does more good refilling a chain that carries none - which
      // is what stops every runner ending up on the same few trunks.
      if (line !== from && load) {
        load[from] -= 1;
        if (load[line] >= quota[line]) {
          this._spawn(i);
          continue;
        }
        load[line] += 1;
      }

      this._line[i] = line;
      this._dist[i] = distance;
      this._seg[i] = segment;

      const span = along[segment + 1] - along[segment] || 1;
      const t = (distance - along[segment]) / span;
      const x = vx[segment] + (vx[segment + 1] - vx[segment]) * t;
      const y = vy[segment] + (vy[segment + 1] - vy[segment]) * t;

      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) {
        this._spawn(i);
        continue;
      }

      const colorClass = shade[line];
      const buffer = segBuf[colorClass];
      const at = segCount[colorClass] * 4;
      if (at + 3 < buffer.length) {
        buffer[at] = this._px[i];
        buffer[at + 1] = this._py[i];
        buffer[at + 2] = x;
        buffer[at + 3] = y;
        segCount[colorClass] += 1;
      }
      this._px[i] = x;
      this._py[i] = y;
    }

    for (let colorClass = 0; colorClass < segBuf.length; colorClass += 1) {
      const drawn = segCount[colorClass];
      if (drawn === 0) {
        continue;
      }

      const buffer = segBuf[colorClass];
      ctx.strokeStyle = palette[colorClass];
      ctx.beginPath();
      for (let k = 0; k < drawn * 4; k += 4) {
        ctx.moveTo(buffer[k], buffer[k + 1]);
        ctx.lineTo(buffer[k + 2], buffer[k + 3]);
      }
      ctx.stroke();
    }
  },

  /**
   * Classic rendering. Zoomed far out a whole chain can be shorter than one
   * dash period, and marching dashes then blink like an LED instead of
   * showing direction - so below the threshold the chains are drawn solid,
   * once per view. Zoomed in, the dash pattern is regenerated every step from
   * a clock phase: dash k of a chain covers [k*period + phase, +dash) along
   * it, with the phase advancing downstream over time.
   */
  _frameDash(now) {
    const ctx = this._ctx;
    const canvas = this._canvas;
    const geometry = this._geometry;
    const zoomedOut = this._map.getZoom() < config.flowDashMinZoom;

    if (zoomedOut) {
      if (!this._staticDrawn) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (geometry) {
          this._strokeChains(null);
        }
        this._staticDrawn = true;
      }
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!geometry) {
      return;
    }
    const phase = ((now % DASH_PERIOD_MS) / DASH_PERIOD_MS) * DASH_PERIOD_PX * this._ratio;
    this._strokeChains(phase);
  },

  /**
   * Stroke every chain in view, per colour class at the classic line weights:
   * solid when phase is null, otherwise as dashes at that phase.
   */
  _strokeChains(phase) {
    const ctx = this._ctx;
    const geometry = this._geometry;
    const { first, last, shade, lineCount } = geometry;
    const vx = this._vx;
    const vy = this._vy;
    const inView = this._lineDrawn;
    const ratio = this._ratio;
    const period = DASH_PERIOD_PX * ratio;
    const dash = DASH_PX * ratio;
    const palette = this._dark ? CHAIN_COLORS_DARK : CHAIN_COLORS;

    ctx.lineCap = 'butt';

    for (let colorClass = 0; colorClass < palette.length; colorClass += 1) {
      ctx.strokeStyle = palette[colorClass];
      // Class 0 stays one device pixel - the hairline fast path, and most of
      // the network; the busier classes take the weights the lines had.
      ctx.lineWidth = colorClass === 0 ? 1 : (1 + colorClass * 0.6) * ratio;
      ctx.beginPath();
      let any = false;

      for (let line = 0; line < lineCount; line += 1) {
        if (!inView[line] || shade[line] !== colorClass) {
          continue;
        }

        if (phase === null) {
          ctx.moveTo(vx[first[line]], vy[first[line]]);
          for (let v = first[line] + 1; v <= last[line]; v += 1) {
            ctx.lineTo(vx[v], vy[v]);
          }
          any = true;
          continue;
        }

        // Dashes by arithmetic along the chain's running pixel length.
        let run = 0;
        for (let v = first[line]; v < last[line]; v += 1) {
          const x0 = vx[v];
          const y0 = vy[v];
          const dx = vx[v + 1] - x0;
          const dy = vy[v + 1] - y0;
          const length = Math.hypot(dx, dy);
          if (length === 0) {
            continue;
          }

          const from = run;
          const to = run + length;
          let start = Math.floor((from - phase - dash) / period) * period + phase;
          for (; start < to; start += period) {
            const a = Math.max(from, start);
            const b = Math.min(to, start + dash);
            if (b <= a) {
              continue;
            }
            const ta = (a - from) / length;
            const tb = (b - from) / length;
            ctx.moveTo(x0 + dx * ta, y0 + dy * ta);
            ctx.lineTo(x0 + dx * tb, y0 + dy * tb);
            any = true;
          }
          run = to;
        }
      }

      if (any) {
        ctx.stroke();
      }
    }
  }
});

/**
 * Particles riding a set of drawn chains downstream. Feed the chains with
 * layer.setLines(lines); an empty list stills the layer. layer.setMode('dash')
 * switches to the classic marching dashes.
 */
export function createChainParticleLayer(options = {}) {
  return new ChainParticles(options);
}
