import { createOutcomeTimeline } from '../sim/outcomeTimeline.js';
import { createOutcomeBar } from '../ui/outcomeBar.js';

// The Outcome slider. "What does it look like N hours in?" answered without
// playing N hours: the first Play runs the scenario once in the background
// (a day in about half a minute) and keeps a snapshot every half hour; after
// that the bar is instant, and Play carries on from wherever it stands.
//
// Dragging parks the bar on an hour and points the storm tracks at it; Play
// is what goes there. The bar marks the hour picked and deliberately does not
// chase the clock afterwards.

const hoursText = (seconds) => {
  const h = seconds / 3600;
  return `${h % 1 ? h.toFixed(1) : h} h`;
};

/**
 * @param paint    () => void: repaint everything that reads the live models
 * @param state    getters: isForecastActive(), isEnsembleRunning()
 * @param trackHorizonS  how far ahead a storm's track looks when nothing else asks
 */
export function createOutcomeControl({ rainfall, roadFlow, pipeNet, tide, paint, state, trackHorizonS }) {
  const dom = {
    root: document.querySelector('#sim-outcome'),
    value: document.querySelector('#sim-outcome-value'),
    status: document.querySelector('#sim-outcome-status')
  };
  // The hour the bar is parked on, waiting for Play.
  let armedSeconds = null;

  function showStatus(text) {
    dom.status.hidden = !text;
    dom.status.textContent = text || '';
  }

  // The bar's caption: what the moment on it is - the live clock, a
  // precomputed outcome, or an invitation to compute one.
  function showLabel() {
    if (!bar) {
      return;
    }
    // The bar belongs to placed storms; a forecast span has its own
    // timeline and drives the same grid.
    const forecastHolds = state.isForecastActive();
    dom.root.classList.toggle('timeline--disabled', forecastHolds);
    if (forecastHolds) {
      dom.value.textContent = 'forecast span';
      return;
    }
    if (outcome.computing) {
      dom.value.textContent = 'running the scenario…';
      return;
    }
    if (armedSeconds !== null) {
      dom.value.textContent = `${hoursText(armedSeconds)} · press Play`;
      return;
    }
    if (outcome.ready) {
      dom.value.textContent = `${hoursText(outcome.shownSeconds)} · shown`;
      return;
    }
    dom.value.textContent = rainfall.stormSystem.storms.length ? 'drag to pick an hour' : 'place a storm';
  }

  const outcome = createOutcomeTimeline({
    rainfall,
    streets: roadFlow.dynamic,
    pipes: pipeNet,
    seaLevelAt: (seconds) => tide.levelAt(rainfall.scenarioTimeAt(seconds)),
    onProgress: (doneSeconds, totalSeconds) => {
      bar?.setComputed(doneSeconds);
      showStatus(
        doneSeconds < totalSeconds
          ? `Computing this scenario once: ${hoursText(doneSeconds)} of ${hoursText(totalSeconds)} done. The bar fills as it goes, and scrubbing is instant afterwards.`
          : ''
      );
      showLabel();
    },
    onShown: (seconds) => {
      // The live models now hold the moment shown: repaint everything that
      // reads them.
      bar?.follow(seconds);
      paint();
      showLabel();
    }
  });

  const bar = dom.root
    ? createOutcomeBar({
        root: dom.root,
        totalHours: outcome.totalSeconds / 3600,
        // The bar snaps to the spacing the scenario is snapshotted at, so
        // the hour picked is exactly the hour run to and shown.
        stepSeconds: outcome.snapshotEverySeconds,
        onScrub: async (seconds, { settled }) => {
          if (!roadFlow.dynamic) {
            return;
          }
          if (rainfall.stormSystem.storms.length === 0) {
            showStatus('Place a storm first: the bar shows that storm’s outcome at any hour of the day.');
            return;
          }
          if (state.isForecastActive()) {
            showStatus('The Outcome bar is for placed storms; a forecast span has its own timeline.');
            return;
          }
          if (state.isEnsembleRunning()) {
            return;
          }

          // Dragging points the storm tracks at the hour under the pointer,
          // so the ghosts show where the cells will have got to by then -
          // before any water is run for it.
          rainfall.stormTrack.setPreview(true);
          rainfall.stormTrack.setHorizon(Math.max(900, seconds - outcome.shownSeconds));
          if (!settled) {
            return;
          }

          // Letting go picks the hour; Play is what goes there. Running a
          // scenario the moment a pointer lifts took the decision away, and
          // a scrub across the bar would have started one per hour.
          rainfall.stop();
          armedSeconds = seconds;
          showStatus(
            seconds > outcome.computedSeconds
              ? 'Press Play to run the storm to this hour and stop there.'
              : 'Press Play to go to this hour.'
          );
          showLabel();
        }
      })
    : null;
  bar?.setComputed(0);
  showLabel();

  return {
    outcome,
    bar,
    showLabel,

    /** The storms changed: the precomputed outcomes no longer describe them. */
    invalidate() {
      outcome.invalidate();
      bar?.setComputed(0);
      showLabel();
    },

    /**
     * Play was pressed. Returns false when the press was spent going to the
     * parked hour, so the clock stays where it landed rather than running
     * straight past what was asked for.
     */
    async playRequest() {
      if (armedSeconds === null) {
        return true;
      }
      const target = armedSeconds;
      armedSeconds = null;
      showStatus('');
      showLabel();
      await outcome.showAt(target);
      // The hour is on the map now: the ghosts that predicted it would only
      // sit on top of the water they predicted.
      rainfall.stormTrack.setPreview(false);
      rainfall.stormTrack.setHorizon(trackHorizonS);
      showStatus('Showing this hour. Press Play again to run on from here.');
      showLabel();
      return false;
    },

    /** Reset: the bar back to the start, nothing armed, tracks at rest. */
    reset() {
      outcome.invalidate();
      bar?.setComputed(0);
      bar?.follow(0);
      armedSeconds = null;
      showStatus('');
      rainfall.stormTrack?.setPreview(false);
      rainfall.stormTrack?.setHorizon(trackHorizonS);
      showLabel();
    }
  };
}
