// The outcome timeline: "what does the map look like N hours into this
// storm?" without sitting through N hours of playback.
//
//   placed storms --once, in the background--> 24 h of the street and pipe
//   models in 5-minute steps, a snapshot every half hour
//                                     |
//   slider at T --instantly--> snapshot at T restored into the live models,
//                              rain grid replayed to T, storms placed at T
//
// The scenario is the storms as placed: each one's track from where it was
// put down, at its speed and bearing, raining as its sliders say. The
// snapshots are compact (depth in mm, outflow direction, pipe volumes:
// ~0.85 MB each, ~40 MB for a day) and are thrown away the moment a storm is
// added, edited or removed, or Reset is pressed.
//
// Scrubbing puts the state at T INTO the live models, so pressing Play from
// there simply carries on: the timeline is a fast-forward, not a separate
// simulation. The rain grid is not snapshotted; it is cheap enough to replay
// from dry ground to T with the same steps the precompute used, so the field
// on screen is bit-for-bit what the streets were rained with.

import { config } from '../config.js';

export function createOutcomeTimeline({
  rainfall,
  streets,
  pipes = null,
  seaLevelAt = null,
  hours = 24,
  stepSeconds = 300,
  snapshotEverySeconds = 1800,
  onProgress = null,
  onShown = null
}) {
  const grid = rainfall.grid;
  const stormSystem = rainfall.stormSystem;
  const totalSeconds = hours * 3600;
  const stepsPerSnapshot = Math.max(1, Math.round(snapshotEverySeconds / stepSeconds));

  let scenario = null; // [{ ...storm fields, x0, y0 }] as placed
  let snapshots = []; // index i is the state at i * snapshotEverySeconds
  let computing = false;
  let cancelled = false;
  let shownSeconds = 0;
  // The moment asked for while the precompute still owns the models; shown
  // the instant it finishes. Restoring a snapshot mid-run would put the
  // models back in time under the run's feet and corrupt every snapshot
  // after it.
  let pendingSeconds = null;

  /** Each storm's track origin: where it was when it was placed. */
  function captureScenario() {
    return stormSystem.storms.map((storm) => ({
      ...storm,
      x0: storm.x - storm.velocityEastMs * storm.ageSeconds,
      y0: storm.y - storm.velocityNorthMs * storm.ageSeconds
    }));
  }

  /** Storm copies placed at t seconds into the scenario, as a storm system. */
  function stormsAt(t) {
    return {
      storms: scenario
        .filter((storm) => t < storm.lifetimeSeconds)
        .map((storm) => ({
          ...storm,
          x: storm.x0 + storm.velocityEastMs * t,
          y: storm.y0 + storm.velocityNorthMs * t,
          ageSeconds: t
        }))
    };
  }

  /** Move the live storms to where the scenario has them at t. */
  function placeLiveStormsAt(t) {
    for (const saved of scenario) {
      const storm = stormSystem.storms.find((candidate) => candidate.id === saved.id);
      if (!storm) {
        continue;
      }
      storm.x = saved.x0 + saved.velocityEastMs * t;
      storm.y = saved.y0 + saved.velocityNorthMs * t;
      storm.ageSeconds = t;
    }
    rainfall.refreshStorms();
  }

  /** Rain grid from dry ground to t, with exactly the precompute's steps. */
  function replayGridTo(t) {
    grid.reset();
    const noise = { noiseAmplitude: config.rainNoiseAmplitude };
    let elapsed = 0;
    while (elapsed < t) {
      const dt = Math.min(stepSeconds, t - elapsed);
      grid.step(stormsAt(elapsed + dt), dt, noise);
      elapsed += dt;
    }
    // The field left on screen is the field at t itself.
    grid.compose(stormsAt(t).storms, noise);
  }

  function snapshotNow() {
    return { streets: streets.snapshot(), pipes: pipes ? pipes.snapshot() : null };
  }

  function restoreSnapshot(index) {
    const snap = snapshots[index];
    streets.restore(snap.streets);
    if (pipes && snap.pipes) {
      pipes.restore(snap.pipes);
    }
  }

  /** How far the scenario has been run, in seconds. */
  function computedSeconds() {
    return Math.max(0, snapshots.length - 1) * snapshotEverySeconds;
  }

  /**
   * Run the scenario forward to `target`, snapshotting as it goes - starting
   * from dry ground the first time, and from the last snapshot afterwards,
   * so asking for a later hour costs only the hours between. Yields to the
   * page between snapshots, so the bar fills and stays responsive.
   */
  async function extendTo(target) {
    if (computing) {
      return;
    }
    computing = true;
    cancelled = false;
    rainfall.setLocked(true);

    try {
      if (!scenario) {
        scenario = captureScenario();
        snapshots = [];
      }

      let t;
      if (snapshots.length === 0) {
        placeLiveStormsAt(0);
        grid.reset();
        streets.reset();
        pipes?.reset();
        snapshots.push(snapshotNow());
        t = 0;
        onProgress?.(0, target);
      } else {
        // Carry on from where the scenario got to, not from where the
        // viewer happens to have scrubbed back to.
        t = computedSeconds();
        restoreSnapshot(snapshots.length - 1);
      }

      const intensityAt = (lat, lng) => rainfall.intensityAt(lat, lng);
      const noise = { noiseAmplitude: config.rainNoiseAmplitude };
      const limit = Math.min(totalSeconds, target);

      while (t < limit && !cancelled) {
        for (let i = 0; i < stepsPerSnapshot && t < totalSeconds; i += 1) {
          const next = t + stepSeconds;
          if (seaLevelAt) {
            const level = seaLevelAt(next);
            streets.setSeaLevel(level);
            pipes?.setSeaLevel(level);
          }
          grid.step(stormsAt(next), stepSeconds, noise);
          // The streets step the drains inside their own substeps.
          streets.step(intensityAt, stepSeconds);
          t = next;
        }
        snapshots.push(snapshotNow());
        onProgress?.(t, limit);
        // Let the page paint and the viewer scrub what is done so far.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      computing = false;
      rainfall.setLocked(false);
    }
  }

  /**
   * Show the outcome at `seconds` into the scenario, running the scenario
   * that far first if it has not been. Returns the seconds shown, or null
   * while another call owns the models - that call shows the latest moment
   * asked for when it is done.
   */
  async function showAt(seconds) {
    if (stormSystem.storms.length === 0) {
      return null;
    }
    rainfall.stop();
    pendingSeconds = Math.max(0, Math.min(totalSeconds, seconds));

    // A call already running will pick up the moment just asked for.
    if (computing) {
      return null;
    }

    // Placing or editing a storm cancels the scenario; asking to see one is
    // what starts the next, so the flag is cleared here rather than left to
    // block the first run.
    cancelled = false;

    // Scrubbing further out while this runs raises the target, so the loop
    // extends again rather than stopping short of where the pointer went.
    while (pendingSeconds !== null && pendingSeconds > computedSeconds()) {
      await extendTo(pendingSeconds);
      if (cancelled) {
        break;
      }
    }

    const wanted = pendingSeconds;
    pendingSeconds = null;
    return showAvailable(wanted ?? seconds);
  }

  function showAvailable(seconds) {
    if (snapshots.length === 0) {
      return null;
    }
    const wanted = Math.round(Math.max(0, Math.min(totalSeconds, seconds)) / snapshotEverySeconds);
    const index = Math.min(wanted, snapshots.length - 1);
    const t = index * snapshotEverySeconds;

    restoreSnapshot(index);
    replayGridTo(t);
    placeLiveStormsAt(t);
    if (seaLevelAt) {
      const level = seaLevelAt(t);
      streets.setSeaLevel(level);
      pipes?.setSeaLevel(level);
    }
    shownSeconds = t;
    rainfall.render();
    onShown?.(t, { computed: (snapshots.length - 1) * snapshotEverySeconds, computing });
    return t;
  }

  return {
    showAt,
    extendTo,

    /** Forget the precomputed scenario (storms changed, Reset pressed). */
    invalidate() {
      cancelled = true;
      scenario = null;
      snapshots = [];
      shownSeconds = 0;
      pendingSeconds = null;
    },

    get ready() {
      return snapshots.length > 1 && !computing;
    },

    get computing() {
      return computing;
    },

    get computedSeconds() {
      return computedSeconds();
    },

    get shownSeconds() {
      return shownSeconds;
    },

    get totalSeconds() {
      return totalSeconds;
    },

    get snapshotEverySeconds() {
      return snapshotEverySeconds;
    }
  };
}
