// Rains a forecast onto the simulator, along a continuous time axis.
//
//   forecast grid (hourly cells) -> rain-grid intensity -> surface water
//                                -> Flow Paths, Flow Accumulation, Street Flow
//
// Driven from the forecast timeline: Shift + drag marks a span, and on
// release the span plays - the clock runs from its start to its end, each
// forecast hour raining as a steady rate over that hour (the data arrives as
// "so many mm between T and T + 1 h"), the rain grid integrating it exactly
// and the flow layers re-weighted by the surface water as it goes.
//
// Storms placed on the map rain into the same water: the forecast's field is
// the base and each storm is laid over it, so a "what if a cell parks over
// Pattaya during this front" scenario is one map. A storm rains from the
// moment it was placed, and its track is anchored there.
//
// What is on screen is a function of the span's start, the moment shown and
// the storms as they now stand, and nothing else: no water is carried in from
// before the span, and no street ponding is stepped through time (that model
// drains anything short of a cloudburst before it can move, and showed
// nothing for a real forecast). So any moment inside the span can be shown on
// demand: clicking back into hours already played re-rains them from the
// start, at a couple of milliseconds per forecast hour.

import { config } from './config.js';
import { toLattice } from './forecast.js';

const HOUR_MS = 3600 * 1000;
// The flow layers are rebuilt from the surface water on this cadence while
// the clock runs or the span is being scrubbed, and once more when it
// settles: a rebuild costs far more than a frame, and the readouts and the
// heatmap are live every frame anyway.
const LAYER_REFRESH_MS = 350;
// A pointer that moved this recently is still scrubbing.
const SETTLE_MS = 150;
// A moving storm may not cross more than this share of its own rain radius
// within one slice, or it lays a row of separate blobs instead of a track.
const STORM_SLICE_RADII = 0.5;
// However fast the storm, a re-rain is capped at this many slices: a long span
// would otherwise be thousands of them, and a backwards scrub would hang. Past
// the cap the track beads rather than the map freezing.
const MAX_REPLAY_SLICES = 600;

/**
 * @param playHoursPerSecond  Called every frame for the current playback
 *   rate, in forecast hours per real second, so the simulator's speed slider
 *   scales a span the way it scales the storm clock.
 */
export function createForecastRainDriver({ rainfall, playHoursPerSecond, refreshLayers, onState }) {
  const grid = rainfall.grid;
  const cellCount = grid.columns * grid.rows;

  let session = null;
  let frameHandle = 0;
  let lastFrameAt = 0;
  let lastInteraction = 0;
  let lastLayerRefresh = 0;
  let layersDirty = false;
  // A moment asked for since the last frame; shown once per frame at most.
  let pendingShow = null;
  // Storms were placed, edited or removed since the last frame. Coalesced the
  // same way: dragging a storm's slider fires far faster than the span can be
  // re-rained, and only the last state of it matters.
  let stormsDirty = false;

  // What the simulator holds while a session owns its grid: its Play button
  // runs or pauses the span, Reset takes it back to the span's first hour,
  // and placing a storm ends it.
  const handle = {
    end: () => end(),
    togglePlay: () => togglePlay(),
    rewind: () => rewind(),
    stormsChanged: () => stormsChanged(),
    get playing() {
      return Boolean(session?.playing);
    },
    /** The moment on screen, Unix ms - the tide and wind are read at it. */
    get shownMs() {
      return session ? session.shownMs : null;
    }
  };

  /**
   * Which forecast cell each rain-grid cell reads. Nearest cell, not
   * interpolated: the figure is the forecast for that patch of ground, and
   * the heatmap's smoothing is for the eye. -1 where the forecast has no cell.
   */
  function mapCells(lattice, forecastGrid) {
    const cellMap = new Int32Array(cellCount);
    const { bounds } = grid;
    const latStep = (bounds.north - bounds.south) / grid.rows;
    const lngStep = (bounds.east - bounds.west) / grid.columns;
    const lat0 = lattice.lats[0];
    const lng0 = lattice.lngs[0];

    for (let row = 0; row < grid.rows; row += 1) {
      // Row 0 is the north edge, matching the grid's own layout.
      const lat = bounds.north - (row + 0.5) * latStep;
      const latticeRow = Math.round((lat - lat0) / forecastGrid.cellLat);
      const rowInside = latticeRow >= 0 && latticeRow < lattice.rows;

      for (let column = 0; column < grid.columns; column += 1) {
        let index = -1;
        if (rowInside) {
          const lng = bounds.west + (column + 0.5) * lngStep;
          const latticeColumn = Math.round((lng - lng0) / forecastGrid.cellLng);
          if (latticeColumn >= 0 && latticeColumn < lattice.columns) {
            const k = latticeRow * lattice.columns + latticeColumn;
            if (lattice.cells[k]) {
              index = k;
            }
          }
        }
        cellMap[row * grid.columns + column] = index;
      }
    }

    return cellMap;
  }

  // Hour buckets: bucket i runs from stamp i to stamp i + 1, at the rain
  // figure published for stamp i - the same pairing the heatmap shows.
  function endOfBucket(bucket) {
    const { stamps } = session;
    const count = stamps.length;
    if (bucket + 1 < count) {
      return stamps[bucket + 1];
    }
    return stamps[bucket] + (count > 1 ? stamps[count - 1] - stamps[count - 2] : HOUR_MS);
  }

  function bucketAt(ms) {
    const { stamps } = session;
    let bucket = 0;
    for (let index = 1; index < stamps.length && stamps[index] <= ms; index += 1) {
      bucket = index;
    }
    return bucket;
  }

  /** Load one forecast hour into the base field as a steady rate in mm/h. */
  function applyBucket(bucket) {
    const { lattice, cellMap, stamps, base } = session;
    const hours = (endOfBucket(bucket) - stamps[bucket]) / HOUR_MS;
    const rates = new Float32Array(lattice.cells.length);

    for (let k = 0; k < lattice.cells.length; k += 1) {
      const cell = lattice.cells[k];
      if (cell) {
        const mm = Number(cell.rain[bucket] ?? 0);
        rates[k] = mm > 0 && hours > 0 ? mm / hours : 0;
      }
    }

    for (let index = 0; index < cellCount; index += 1) {
      const k = cellMap[index];
      base[index] = k >= 0 ? rates[k] : 0;
    }

    session.bucket = bucket;
  }

  /** The leg of a track that covers ms, or null before the track starts. */
  function legAt(legs, ms) {
    let found = null;
    for (const leg of legs) {
      if (leg.startMs > ms) {
        break;
      }
      found = leg;
    }
    return found;
  }

  /**
   * Each storm's track through the span, kept as legs: from this moment it
   * was here, going this way. A storm placed during the span starts from the
   * moment on screen; one that predates the span has been there since it
   * began.
   *
   * Moving a storm or turning it adds a leg from the moment on screen rather
   * than re-anchoring the whole track, so what it has already laid down
   * stands: a cell that sits over Pattaya for six hours and then drifts off
   * is two legs, and no single anchor could describe it. Its other settings -
   * how hard it rains, how wide - are not legged, so tuning one re-runs the
   * whole scenario with it.
   */
  function trackStorms() {
    const { tracks, shownMs } = session;
    const live = new Set();

    for (const storm of rainfall.stormSystem.storms) {
      live.add(storm.id);
      const legs = tracks.get(storm.id);
      if (!legs) {
        tracks.set(storm.id, [legOf(storm, shownMs, storm.x, storm.y)]);
        continue;
      }

      const leg = legAt(legs, shownMs) || legs[0];
      const seconds = Math.max(0, (shownMs - leg.startMs) / 1000);
      const atX = leg.x + leg.east * seconds;
      const atY = leg.y + leg.north * seconds;
      // A metre of slack: this runs after every edit, and a new leg on
      // floating-point dust would walk a parked storm across the map.
      const moved = Math.abs(storm.x - atX) > 1 || Math.abs(storm.y - atY) > 1;
      // Against the last leg, not the one covering this moment: scrubbing
      // back and editing something else must not read as a turn.
      const last = legs[legs.length - 1];
      const turned = storm.velocityEastMs !== last.east || storm.velocityNorthMs !== last.north;
      if (!moved && !turned) {
        continue;
      }

      // Edited after scrubbing back: the track from here on is being
      // rewritten, so whatever it used to do after this moment goes.
      while (legs.length > 0 && legs[legs.length - 1].startMs >= shownMs) {
        legs.pop();
      }
      legs.push(legOf(storm, shownMs, moved ? storm.x : atX, moved ? storm.y : atY));
    }

    for (const id of [...tracks.keys()]) {
      if (!live.has(id)) {
        tracks.delete(id);
      }
    }
  }

  function legOf(storm, startMs, x, y) {
    return { startMs, x, y, east: storm.velocityEastMs, north: storm.velocityNorthMs };
  }

  /** Put every storm where it stands at ms; the ones raining by then. */
  function placeStormsAt(ms) {
    const raining = [];

    for (const storm of rainfall.stormSystem.storms) {
      const legs = session.tracks.get(storm.id);
      if (!legs?.length) {
        continue;
      }

      const leg = legAt(legs, ms);
      if (!leg) {
        // Scrubbed back before it was placed: it waits at its starting point
        // and stays dry. Its rings stay on the map, as they do before Play.
        storm.x = legs[0].x;
        storm.y = legs[0].y;
        storm.ageSeconds = 0;
        continue;
      }

      storm.x = leg.x + leg.east * ((ms - leg.startMs) / 1000);
      storm.y = leg.y + leg.north * ((ms - leg.startMs) / 1000);
      storm.ageSeconds = (ms - legs[0].startMs) / 1000;
      raining.push(storm);
    }

    return raining;
  }

  /** Rebuild the rain field for one moment: the forecast, plus the storms. */
  function composeAt(ms) {
    grid.compose(placeStormsAt(ms), {
      noiseAmplitude: config.rainNoiseAmplitude,
      base: session.base
    });
  }

  /** How long a slice may run before a moving storm skips over ground. */
  function sliceMsFor(spanMs) {
    let shortest = Infinity;

    for (const storm of rainfall.stormSystem.storms) {
      const speed = Math.hypot(storm.velocityEastMs, storm.velocityNorthMs);
      if (speed > 0) {
        shortest = Math.min(shortest, ((storm.rainRadiusMeters * STORM_SLICE_RADII) / speed) * 1000);
      }
    }

    // Every storm parked (the default, and the only case with no storms at
    // all): the rate is constant through a forecast hour, so one slice per
    // hour is not an approximation.
    return shortest === Infinity ? Infinity : Math.max(shortest, spanMs / MAX_REPLAY_SLICES);
  }

  /** Rain forward from the moment shown to ms, a slice at a time. */
  function advanceTo(ms) {
    const sliceMs = sliceMsFor(ms - session.shownMs);

    while (session.shownMs < ms) {
      const bucket = bucketAt(session.shownMs);
      if (bucket !== session.bucket) {
        applyBucket(bucket);
      }

      // A slice ends at the target or at the end of the hour, so the
      // forecast's rate never changes mid-slice; with a storm on the move it
      // is cut shorter still.
      let sliceEnd = Math.min(ms, endOfBucket(bucket));
      if (sliceMs < Infinity) {
        sliceEnd = Math.min(sliceEnd, session.shownMs + sliceMs);
      }

      // Storms are placed at the middle of the slice, so a moving one lays an
      // even track instead of leading or lagging it by half a step.
      composeAt((session.shownMs + sliceEnd) / 2);
      grid.integrate((sliceEnd - session.shownMs) / 1000);
      session.shownMs = sliceEnd;
    }

    const bucket = bucketAt(session.shownMs);
    if (bucket !== session.bucket) {
      applyBucket(bucket);
    }

    // The field left on screen is the field at the moment shown, not at the
    // middle of whichever slice ended there: a storm placed at this very
    // moment has to appear now, not once time moves on. The slices above are
    // what laid the water down; this is what is being looked at.
    composeAt(session.shownMs);
  }

  /** Re-rain the span from its start up to ms, on dry ground. */
  function replayTo(ms) {
    grid.reset();
    session.shownMs = session.fromMs;
    session.bucket = -1;
    advanceTo(ms);
  }

  /** Put the moment ms on screen: onward from here, or again from the start. */
  function showMoment(ms) {
    const target = Math.max(session.fromMs, Math.min(session.endMs, ms));
    if (target < session.shownMs) {
      replayTo(target);
    } else {
      advanceTo(target);
    }
    rainfall.render();
    layersDirty = true;
  }

  function refreshLayersNow() {
    refreshLayers();
    lastLayerRefresh = performance.now();
    layersDirty = false;
  }

  function report() {
    onState?.(
      session
        ? {
            fromMs: session.fromMs,
            endMs: session.endMs,
            shownMs: session.shownMs,
            playing: session.playing
          }
        : null
    );
  }

  function schedule() {
    if (!frameHandle) {
      frameHandle = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    frameHandle = 0;
    if (!session) {
      return;
    }

    if (stormsDirty) {
      stormsDirty = false;
      trackStorms();
      // From the start: a storm placed at hour 30 of the span must not leave
      // the hours before it holding water it never rained, and one just
      // removed must take its water with it.
      replayTo(session.shownMs);
      rainfall.render();
      layersDirty = true;
    }

    if (pendingShow !== null) {
      const ms = pendingShow;
      pendingShow = null;
      showMoment(ms);
    }

    if (session.playing) {
      // Capped, so a tab that was in the background does not leap.
      const dt = lastFrameAt ? Math.min(0.25, (now - lastFrameAt) / 1000) : 0;
      lastFrameAt = now;
      if (dt > 0) {
        // Read every frame, so moving the speed slider mid-play changes the
        // pace there and then.
        const rate = playHoursPerSecond();
        showMoment(Math.min(session.endMs, session.shownMs + dt * rate * HOUR_MS));
      }
      if (session.shownMs >= session.endMs) {
        session.playing = false;
        rainfall.render();
      }
    }

    // While the clock runs or the pointer is still scrubbing, the layers
    // follow on their cadence; once things settle they catch up at once.
    const busy = session.playing || now - lastInteraction < SETTLE_MS;
    if (layersDirty && (!busy || now - lastLayerRefresh >= LAYER_REFRESH_MS)) {
      refreshLayersNow();
    }

    report();

    if (session.playing || pendingShow !== null || layersDirty || stormsDirty) {
      schedule();
    }
  }

  /**
   * Start a span at fromMs on dry ground. The simulator's own clock stops -
   * this one drives it - and any storms already placed join the span from its
   * first hour.
   */
  function begin({ forecastGrid, fromMs }) {
    end();

    const stamps = (forecastGrid?.times || []).map((time) => Date.parse(time));
    if (
      stamps.length === 0 ||
      stamps.some((value) => !Number.isFinite(value)) ||
      !forecastGrid.points?.length
    ) {
      return false;
    }

    const lattice = toLattice(forecastGrid.points);
    const start = Math.max(stamps[0], Math.min(stamps[stamps.length - 1], fromMs));
    session = {
      forecastGrid,
      lattice,
      stamps,
      cellMap: mapCells(lattice, forecastGrid),
      base: new Float32Array(cellCount),
      tracks: new Map(),
      bucket: -1,
      fromMs: start,
      endMs: start,
      shownMs: start,
      playing: false
    };

    rainfall.setExternalRain(handle);
    rainfall.clearWater();
    trackStorms();
    advanceTo(start);
    rainfall.render();
    // The layers may still be showing a storm's water.
    refreshLayersNow();
    report();
    return true;
  }

  /** Move the span's end. The moment shown never lies beyond it. */
  function setEnd(ms) {
    if (!session) {
      return;
    }

    const { stamps } = session;
    session.endMs = Math.max(session.fromMs, Math.min(stamps[stamps.length - 1], ms));
    lastInteraction = performance.now();
    if (session.shownMs > session.endMs) {
      pendingShow = session.endMs;
    }
    schedule();
  }

  /** Run the clock on from the moment shown to the span's end. */
  function play() {
    if (!session || session.shownMs >= session.endMs) {
      return;
    }

    session.playing = true;
    lastFrameAt = 0;
    rainfall.render();
    schedule();
  }

  function pause() {
    if (!session) {
      return;
    }

    session.playing = false;
    rainfall.render();
    schedule();
  }

  /** Back to the span's first hour, on dry ground, paused. */
  function rewind() {
    if (!session) {
      return;
    }

    session.playing = false;
    pendingShow = null;
    stormsDirty = false;
    replayTo(session.fromMs);
    rainfall.render();
    refreshLayersNow();
    report();
  }

  /**
   * A storm was placed, edited or removed. Handled on the next frame rather
   * than here: a slider drag fires far faster than the span can be re-rained.
   */
  function stormsChanged() {
    if (!session) {
      return;
    }

    stormsDirty = true;
    lastInteraction = performance.now();
    schedule();
  }

  /** The Play button: pause, resume, or - once the span has played - replay. */
  function togglePlay() {
    if (!session) {
      return;
    }

    if (session.playing) {
      pause();
      return;
    }

    if (session.shownMs >= session.endMs && session.endMs > session.fromMs) {
      pendingShow = session.fromMs;
      session.playing = true;
      lastFrameAt = 0;
      rainfall.render();
      schedule();
      return;
    }

    play();
  }

  /** Show one moment inside the span, and hold there. */
  function showAt(ms) {
    if (!session) {
      return;
    }

    session.playing = false;
    pendingShow = ms;
    lastInteraction = performance.now();
    schedule();
  }

  /** Drop the span and its water, and hand the grid back to the storms. */
  function end() {
    if (!session) {
      return;
    }

    if (frameHandle) {
      cancelAnimationFrame(frameHandle);
      frameHandle = 0;
    }
    session = null;
    pendingShow = null;
    stormsDirty = false;
    layersDirty = false;
    rainfall.clearWater();
    rainfall.setExternalRain(null);
    refreshLayers();
    onState?.(null);
  }

  return {
    begin,
    setEnd,
    play,
    showAt,
    rewind,
    stormsChanged,
    end,

    get active() {
      return Boolean(session);
    },

    get playing() {
      return Boolean(session?.playing);
    }
  };
}
