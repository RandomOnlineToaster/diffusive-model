// Rains a forecast onto the simulator, along a continuous time axis.
//
//   forecast grid (hourly cells) -> rain-grid intensity -> street water
//                                -> the drains -> ponding, outfalls, pumps
//
// Driven from the forecast timeline: Shift + drag marks a span, and on
// release the span plays - the clock runs from its start to its end, each
// forecast hour raining as a steady rate over that hour (the data arrives as
// "so many mm between T and T + 1 h"), the rain grid integrating it exactly
// and the street and drain models carrying it as it goes.
//
// Storms placed on the map rain into the same water: the forecast's field is
// the base and each storm is laid over it, so a "what if a cell parks over
// Pattaya during this front" scenario is one map. A storm rains from the
// moment it was placed, and its track is anchored there.
//
// Two clocks. The RAIN is stateless: what is on screen is a function of the
// span's start, the moment shown and the storms, and nothing else, so any
// moment can be shown on demand - scrubbing re-rains the grid from the span's
// start at a couple of milliseconds per forecast hour. The WATER is not: a
// forecast is the realistic input, so it runs the same physics a placed storm
// does - the streets and the surveyed drains, stepped through time - and the
// water at a moment exists because of the rain before it. It cannot be looked
// up, but it need not be run from the span's start either: a rain event is
// over in a few hours and the streets clear in minutes, so the water at a
// moment is run from dry ground a fixed window before it (three hours by
// default). Scrubbing shows the rain at once and the water follows a few
// seconds later, run through in the background a frame's worth at a time and
// snapshotted as it goes, so a moment inside the window already computed is
// a restore rather than a rerun; playing carries the water on continuously
// from wherever the clock stands.

import { config } from '../config.js';
import { toLattice } from '../sources/forecast.js';

const HOUR_MS = 3600 * 1000;
// The hydraulics need short steps to stay stable and conserve mass, so a
// slice that would rain for longer than this is split.
const HYDRAULIC_STEP_MS = 300 * 1000;
// How much computing may be done before handing the frame back, so the page
// keeps painting while the water is run through the hours before a moment.
const FRAME_BUDGET_MS = 24;
// Snapshots of the water models, every so often through the window, so a
// moment already computed is a restore rather than a rerun. About 0.85 MB
// each, so a long window takes them further apart rather than more of them:
// a week costs the same memory as three hours.
const SNAPSHOT_EVERY_MS = 15 * 60 * 1000;
const MAX_SNAPSHOTS = 16;
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
 * @param streets   the street water model, stepped with the forecast's rain
 * @param pipes     the drainage network under it, or null
 * @param seaLevelAt  (unixMs) => metres, the tide the outfalls meet
 */
export function createForecastRainDriver({
  rainfall,
  playHoursPerSecond,
  refreshLayers,
  onState,
  streets = null,
  pipes = null,
  seaLevelAt = null
}) {
  const grid = rainfall.grid;
  const cellCount = grid.columns * grid.rows;
  const intensityAt = (lat, lng) => rainfall.intensityAt(lat, lng);

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
   * How each rain-grid cell reads the forecast: the four forecast cells
   * around it and the bilinear weights between them, so the coarse lattice
   * lands on the ground as a continuous field. A forecast cell is one figure
   * for 10-35 km of country; reading the nearest cell drew a cliff along
   * every cell edge - one side of a street raining, the other dry - which is
   * the sampling, not the weather. Interpolating between cell centres is
   * what the heatmap already does for the eye.
   *
   * Cells the lattice lacks (a thinned grid, its outer edge) drop out and the
   * remaining weights are renormalised; a rain-grid cell with no forecast
   * cell around it at all reads 0.
   */
  function mapCells(lattice, forecastGrid) {
    const corner = new Int32Array(cellCount * 4).fill(-1);
    const weight = new Float32Array(cellCount * 4);
    const { bounds } = grid;
    const latStep = (bounds.north - bounds.south) / grid.rows;
    const lngStep = (bounds.east - bounds.west) / grid.columns;
    const lat0 = lattice.lats[0];
    const lng0 = lattice.lngs[0];

    for (let row = 0; row < grid.rows; row += 1) {
      // Row 0 is the north edge, matching the grid's own layout.
      const lat = bounds.north - (row + 0.5) * latStep;
      const fy = (lat - lat0) / forecastGrid.cellLat;
      const r0 = Math.floor(fy);
      const ty = fy - r0;

      for (let column = 0; column < grid.columns; column += 1) {
        const lng = bounds.west + (column + 0.5) * lngStep;
        const fx = (lng - lng0) / forecastGrid.cellLng;
        const c0 = Math.floor(fx);
        const tx = fx - c0;
        const at = (row * grid.columns + column) * 4;

        let sum = 0;
        for (let j = 0; j < 4; j += 1) {
          const r = r0 + (j >> 1);
          const c = c0 + (j & 1);
          const w = (j & 1 ? tx : 1 - tx) * (j >> 1 ? ty : 1 - ty);
          if (w <= 0 || r < 0 || c < 0 || r >= lattice.rows || c >= lattice.columns) {
            continue;
          }
          const k = r * lattice.columns + c;
          if (!lattice.cells[k]) {
            continue;
          }
          corner[at + j] = k;
          weight[at + j] = w;
          sum += w;
        }
        if (sum > 0 && sum < 1) {
          for (let j = 0; j < 4; j += 1) {
            weight[at + j] /= sum;
          }
        }
      }
    }

    return { corner, weight };
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

    const { corner, weight } = cellMap;
    for (let index = 0; index < cellCount; index += 1) {
      const at = index * 4;
      let value = 0;
      for (let j = 0; j < 4; j += 1) {
        const k = corner[at + j];
        if (k >= 0) {
          value += weight[at + j] * rates[k];
        }
      }
      base[index] = value;
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

  // --- the rain clock -------------------------------------------------------

  /**
   * Rain forward from the moment shown to ms, a slice at a time. The rain
   * grid alone: this is the picture, and it is cheap enough to redo from the
   * span's start whenever the moment shown goes backwards.
   */
  function advanceRainTo(ms) {
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

    showRainAt(session.shownMs);
  }

  /**
   * The field on screen is the field at the moment shown - not at the middle
   * of whichever slice ended there, and not wherever the water's clock has
   * got to: a storm placed at this very moment has to appear now.
   */
  function showRainAt(ms) {
    const bucket = bucketAt(ms);
    if (bucket !== session.bucket) {
      applyBucket(bucket);
    }
    composeAt(ms);
  }

  /** The rain grid at ms: onward from here, or again from the span's start. */
  function rainTo(ms) {
    if (ms < session.shownMs) {
      rewindGrid();
    }
    advanceRainTo(ms);
  }

  /** The rain grid back to the span's first hour, with nothing rained yet. */
  function rewindGrid() {
    grid.reset();
    session.shownMs = session.fromMs;
    session.bucket = -1;
  }

  // --- the water clock ------------------------------------------------------

  function windowMs() {
    return config.forecastWaterWindowHours * HOUR_MS;
  }

  /**
   * Whether a span runs the water at all. A window of zero says not: the
   * rain is drawn and routed along the streets, as it was before the models
   * were wired to a forecast, and nothing is stepped.
   */
  function waterEnabled() {
    return Boolean(streets) && config.forecastWaterWindowHours > 0;
  }

  /** Far enough apart that a window of any length holds the same few. */
  function snapshotEveryMs() {
    return Math.max(SNAPSHOT_EVERY_MS, windowMs() / MAX_SNAPSHOTS);
  }

  /**
   * Step the water models from their clock toward `target`, a slice at a
   * time, each slice rained with the field composed for it. The grid's own
   * accumulation is left alone - it belongs to the moment shown.
   *
   * @param budgetMs  give the frame back after this much computing
   * @returns whether it reached target
   */
  function stepWaterTo(target, budgetMs) {
    if (!waterEnabled()) {
      session.waterMs = target;
      return true;
    }
    const sliceMs = sliceMsFor(target - session.waterMs);
    const started = performance.now();

    while (session.waterMs < target) {
      const bucket = bucketAt(session.waterMs);
      if (bucket !== session.bucket) {
        applyBucket(bucket);
      }
      let sliceEnd = Math.min(target, endOfBucket(bucket), session.waterMs + HYDRAULIC_STEP_MS);
      if (sliceMs < Infinity) {
        sliceEnd = Math.min(sliceEnd, session.waterMs + sliceMs);
      }
      const dtSeconds = (sliceEnd - session.waterMs) / 1000;

      // This slice's rain, storms placed at its middle; the noise texture
      // drifts on the water's clock, not the display's.
      grid.compose(placeStormsAt((session.waterMs + sliceEnd) / 2), {
        noiseAmplitude: config.rainNoiseAmplitude,
        base: session.base,
        atSeconds: (sliceEnd - session.fromMs) / 1000
      });
      if (seaLevelAt) {
        const level = seaLevelAt(sliceEnd);
        streets.setSeaLevel(level);
        pipes?.setSeaLevel(level);
      }
      // The streets step the drains inside their own substeps.
      streets.step(intensityAt, dtSeconds);
      session.waterMs = sliceEnd;
      maybeSnapshot();

      if (performance.now() - started >= budgetMs) {
        break;
      }
    }

    // Whatever the water was just rained with, the screen shows the moment
    // shown.
    showRainAt(session.shownMs);
    return session.waterMs >= target;
  }

  // Snapshots: what makes a moment already computed cheap to go back to -
  // the state of both water models, every so often through the window. The
  // rain grid is not among them; it is re-rained from the span's first hour
  // on demand.

  function pushSnapshot() {
    if (!waterEnabled()) {
      return;
    }
    session.snapshots.push({
      ms: session.waterMs,
      streets: streets.snapshot(),
      pipes: pipes ? pipes.snapshot() : null
    });
  }

  function maybeSnapshot() {
    const last = session.snapshots[session.snapshots.length - 1];
    if (last && session.waterMs - last.ms < snapshotEveryMs()) {
      return;
    }
    pushSnapshot();
  }

  /** The latest snapshot at or before ms that is no older than the window. */
  function snapshotFor(ms) {
    let found = null;
    for (const snap of session.snapshots) {
      if (snap.ms > ms + 1) {
        break;
      }
      if (snap.ms >= ms - windowMs()) {
        found = snap;
      }
    }
    return found;
  }

  /** Snapshots a window before ms are never needed again. */
  function pruneSnapshots(ms) {
    const oldest = ms - windowMs();
    session.snapshots = session.snapshots.filter((snap) => snap.ms >= oldest);
  }

  /** The water models dry, with their clock at ms, and that as snapshot zero. */
  function dryWaterAt(ms) {
    session.snapshots = [];
    session.waterMs = ms;
    // Reset even with the water off, so a span started after one that ran it
    // does not open on the last one's flood.
    if (streets) {
      streets.reset();
      pipes?.reset();
    }
    pushSnapshot();
  }

  /**
   * Move the water toward the moment asked for by the shortest road: on from
   * where its clock stands when that is inside the window, else from the
   * latest snapshot inside the window, else from dry ground a window before
   * it. However far away the moment is, the cost is bounded by the window -
   * which is the point of it.
   */
  function catchUpWater(budgetMs = FRAME_BUDGET_MS) {
    const target = session.waterTargetMs;
    if (!waterEnabled()) {
      session.waterMs = target;
      return true;
    }
    const behind = target < session.waterMs;
    const tooFar = target - session.waterMs > windowMs();
    if (behind || tooFar) {
      const snap = snapshotFor(target);
      if (snap) {
        streets.restore(snap.streets);
        if (pipes && snap.pipes) {
          pipes.restore(snap.pipes);
        }
        session.waterMs = snap.ms;
      } else {
        dryWaterAt(Math.max(session.fromMs, target - windowMs()));
      }
    }
    const reached = stepWaterTo(target, budgetMs);
    if (reached) {
      pruneSnapshots(target);
    }
    return reached;
  }

  /** The water is at the moment shown: paint everything that reads it. */
  function waterArrived() {
    rainfall.render();
    refreshLayersNow({ water: true });
  }

  /**
   * Show the moment ms: the rain at once, the water as soon as it has been
   * run there.
   */
  function showMoment(ms) {
    const target = Math.max(session.fromMs, Math.min(session.endMs, ms));
    rainTo(target);
    session.waterTargetMs = target;
    rainfall.render();
    layersDirty = true;
    schedule();
  }

  /** Throw the computed water away and build it again for the moment shown. */
  function replayTo(ms) {
    const target = Math.max(session.fromMs, Math.min(session.endMs, ms));
    rewindGrid();
    dryWaterAt(Math.max(session.fromMs, target - windowMs()));
    showMoment(target);
  }

  function refreshLayersNow({ water = true } = {}) {
    refreshLayers({ water });
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
            playing: session.playing,
            // The water is still being run through the hours before the
            // moment shown.
            catchingUp: waterEnabled() && session.waterMs !== session.waterTargetMs,
            windowHours: config.forecastWaterWindowHours,
            waterOff: !waterEnabled()
          }
        : null
    );
  }

  function schedule() {
    if (frameHandle) {
      return;
    }
    // A slice of the water models runs for far longer than a frame, and
    // inside requestAnimationFrame the browser then paces the next call to
    // the display's rhythm. A timer keeps no such rhythm, so work that is
    // already too big for a frame is scheduled on one instead.
    frameHandle =
      session && !session.playing && session.waterMs !== session.waterTargetMs
        ? setTimeout(() => frame(performance.now()), 0)
        : requestAnimationFrame(frame);
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
      // removed must take its water with it. The water computed for those
      // hours went with it, so it is run again.
      replayTo(session.shownMs);
    }

    if (pendingShow !== null) {
      const ms = pendingShow;
      pendingShow = null;
      showMoment(ms);
    }

    let arrived = false;
    if (session.playing) {
      if (session.waterMs < session.shownMs) {
        // Play pressed while the water was still on its way to the moment
        // shown: it gets there first, then the clock runs.
        lastFrameAt = now;
        arrived = catchUpWater();
      } else {
        // Capped, so a tab that was in the background does not leap.
        const dt = lastFrameAt ? Math.min(0.25, (now - lastFrameAt) / 1000) : 0;
        lastFrameAt = now;
        if (dt > 0) {
          // Read every frame, so moving the speed slider mid-play changes
          // the pace there and then. The clock is the water's: a span whose
          // water costs more than the rate to compute slows down rather than
          // running ahead of its own physics.
          const rate = playHoursPerSecond();
          session.waterTargetMs = Math.min(session.endMs, session.waterMs + dt * rate * HOUR_MS);
          catchUpWater();
          rainTo(session.waterMs);
          rainfall.render();
          layersDirty = true;
        }
        if (session.shownMs >= session.endMs) {
          session.playing = false;
          rainfall.render();
        }
      }
    } else if (session.waterMs !== session.waterTargetMs) {
      // Running the water through the hours before the moment shown, a
      // frame's worth at a time, so the page carries on painting meanwhile.
      arrived = catchUpWater();
    }

    // While the clock runs or the pointer is still scrubbing, the rain-driven
    // layers follow on their cadence; once things settle they catch up at
    // once. The water-driven layers are drawn only once the water is at the
    // moment shown: the hours on the way are not being looked at, and a
    // flooded ponding sheet costs more to draw than the physics under it.
    const catchingUp = session.waterMs !== session.waterTargetMs;
    const busy = session.playing || now - lastInteraction < SETTLE_MS;
    if (arrived) {
      waterArrived();
    } else if (layersDirty && (!busy || now - lastLayerRefresh >= LAYER_REFRESH_MS)) {
      refreshLayersNow({ water: !catchingUp });
    }

    report();

    if (session.playing || pendingShow !== null || layersDirty || stormsDirty || catchingUp) {
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
      playing: false,
      // The water models' own clock, the moment they are being run toward,
      // and their snapshots through the window.
      waterMs: start,
      waterTargetMs: start,
      snapshots: []
    };

    rainfall.setExternalRain(handle);
    // clearWater resets the street and drain models through the map's own
    // onReset, so the span starts on dry ground - and that is snapshot zero.
    rainfall.clearWater();
    pushSnapshot();
    trackStorms();
    advanceRainTo(start);
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
    rewindGrid();
    dryWaterAt(session.fromMs);
    showMoment(session.fromMs);
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

    /** The water is still being run through the hours before the moment shown. */
    get catchingUp() {
      return Boolean(session) && waterEnabled() && session.waterMs !== session.waterTargetMs;
    },

    /**
     * Whether a span runs the street and drain models at all, or only draws
     * and routes the rain (a water window of zero).
     */
    get waterEnabled() {
      return waterEnabled();
    },

    /** Where the water models' own clock stands, Unix ms. */
    get waterMs() {
      return session ? session.waterMs : null;
    },

    /** How many snapshots the window is holding, for tests and tuning. */
    get snapshotCount() {
      return session ? session.snapshots.length : 0;
    },

    get playing() {
      return Boolean(session?.playing);
    }
  };
}
