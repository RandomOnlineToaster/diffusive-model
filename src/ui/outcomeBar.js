// The Outcome bar: a scrub bar over the storm's next 24 hours.
//
//   0        3        6        9       12  ...  24 h
//   |========|========|--------|--------|---------|
//    computed so far ^         ^ the moment shown
//
// A range slider was the wrong control for this: it gave no sense of scale,
// no idea which hours were ready, and its value sat in a cramped output box.
// This is the same bar the rain forecast uses - cells for the hours, a
// capsule on the playhead reading the exact time, a tint over the part that
// has been computed - so both timelines read alike.
//
// The module owns the interaction only: it reports where the pointer is and
// paints what it is told. Where the water comes from is outcomeTimeline.js.

const CELL_HOURS = 3;

/**
 * @param root       the .timeline element
 * @param onScrub    (seconds, { settled }) => void, while dragging and once
 *                   the pointer lifts (settled)
 */
export function createOutcomeBar({ root, onScrub, totalHours = 24, stepSeconds = 1800 }) {
  const track = root.querySelector('.timeline-track');
  const head = root.querySelector('.timeline-head');
  const label = root.querySelector('.timeline-head-label');
  const computed = root.querySelector('.timeline-computed');
  const totalSeconds = totalHours * 3600;

  // Hour cells, so the bar reads as a day rather than as a bare groove.
  track.innerHTML = '';
  for (let hour = CELL_HOURS; hour <= totalHours; hour += CELL_HOURS) {
    const cell = document.createElement('span');
    cell.className = 'timeline-day';
    cell.textContent = `${hour} h`;
    track.append(cell);
  }

  let shownSeconds = 0;
  let dragging = false;
  let frame = 0;
  let pendingSeconds = null;

  /** h:mm into the storm, the way a clock reads it. */
  function clockText(seconds) {
    const total = Math.round(seconds / 60);
    return `+${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function paint() {
    const fraction = totalSeconds > 0 ? shownSeconds / totalSeconds : 0;
    root.style.setProperty('--x', `${(fraction * 100).toFixed(3)}%`);
    label.textContent = clockText(shownSeconds);
    track.setAttribute('aria-valuenow', (shownSeconds / 3600).toFixed(1));
  }

  /**
   * The moment under the pointer, snapped to whole steps. Without the snap a
   * pointer landing a fraction of a pixel past an hour asks for that hour
   * plus a second, and the scenario runs to the snapshot after it - "5 h"
   * quietly costing five and a half.
   */
  function secondsAt(clientX) {
    const rect = track.getBoundingClientRect();
    const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const seconds = Math.max(0, Math.min(1, fraction)) * totalSeconds;
    return Math.min(totalSeconds, Math.round(seconds / stepSeconds) * stepSeconds);
  }

  /**
   * The bar follows the pointer at once; the water follows on the next
   * frame, so a drag across the day does not queue a restore per pixel.
   */
  function scrubTo(seconds, settled) {
    shownSeconds = seconds;
    paint();
    pendingSeconds = seconds;
    if (settled) {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      pendingSeconds = null;
      onScrub(seconds, { settled: true });
      return;
    }
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pendingSeconds !== null) {
          const value = pendingSeconds;
          pendingSeconds = null;
          onScrub(value, { settled: false });
        }
      });
    }
  }

  track.addEventListener('pointerdown', (event) => {
    dragging = true;
    track.setPointerCapture(event.pointerId);
    scrubTo(secondsAt(event.clientX), false);
    event.preventDefault();
  });

  track.addEventListener('pointermove', (event) => {
    if (dragging) {
      scrubTo(secondsAt(event.clientX), false);
    }
  });

  const release = (event) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    try {
      track.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already be gone; the drag is over either way.
    }
    scrubTo(secondsAt(event.clientX), true);
  };
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);

  track.addEventListener('keydown', (event) => {
    const stepSeconds = event.shiftKey ? 3600 : 1800;
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = Math.min(totalSeconds, shownSeconds + stepSeconds);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = Math.max(0, shownSeconds - stepSeconds);
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = totalSeconds;
    }
    if (next !== null) {
      event.preventDefault();
      scrubTo(next, true);
    }
  });

  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(totalHours));
  paint();

  return {
    get scrubbing() {
      return dragging;
    },

    /** Move the head without reporting it back - the clock is driving. */
    follow(seconds) {
      if (dragging) {
        return;
      }
      shownSeconds = Math.max(0, Math.min(totalSeconds, seconds));
      paint();
    },

    /** How much of the day has been computed, as a tint over the bar. */
    setComputed(seconds) {
      const fraction = totalSeconds > 0 ? Math.max(0, Math.min(1, seconds / totalSeconds)) : 0;
      computed.style.width = `calc(${(fraction * 100).toFixed(2)}% - 2px)`;
      computed.hidden = fraction <= 0;
    },

    get shownSeconds() {
      return shownSeconds;
    }
  };
}
