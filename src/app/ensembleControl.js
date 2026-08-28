import { createEnsembleRunner } from '../sim/ensemble.js';

// The "Run ensemble" button: replays the placed storms with jittered tracks
// on the same models, one member at a time, and paints how often each street
// floods. The button doubles as Cancel while it works.

export function createEnsembleControl({ map, rainfall, roadFlow, pipeNet, tide, forecastRain, updateReadout }) {
  const dom = {
    button: document.querySelector('#sim-ensemble'),
    status: document.querySelector('#sim-ensemble-status')
  };

  const ensemble = createEnsembleRunner({
    rainfall,
    streets: roadFlow.dynamic,
    pipes: pipeNet,
    seaLevelAt: (simSeconds) => tide.levelAt(rainfall.scenarioTimeAt(simSeconds)),
    onProgress: (done, total) => {
      dom.status.textContent = `Running ensemble: ${done} of ${total} members done…`;
    }
  });

  function showStatus(text) {
    dom.status.hidden = !text;
    dom.status.textContent = text || '';
  }

  dom.button.addEventListener('click', async () => {
    if (!roadFlow.dynamic) {
      return;
    }
    if (ensemble.running) {
      ensemble.cancel();
      return;
    }
    if (rainfall.stormSystem.storms.length === 0) {
      showStatus(
        'Place a storm first: the ensemble replays the placed storms with jittered tracks, speeds, sizes and intensities.'
      );
      return;
    }

    // A forecast span would keep re-raining the grid underneath the runs.
    const driver = forecastRain();
    if (driver?.active) {
      driver.end();
    }
    rainfall.stop();
    dom.button.textContent = 'Cancel';
    dom.button.classList.add('sim-button--active');
    showStatus('Running ensemble…');

    let result = null;
    try {
      result = await ensemble.run();
    } finally {
      dom.button.textContent = 'Run ensemble';
      dom.button.classList.remove('sim-button--active');
    }

    rainfall.render();
    updateReadout();
    if (!result) {
      showStatus('Ensemble cancelled.');
      return;
    }

    // The street layer has to be on to show it; adding it repaints the
    // (now dry) live view, so the probability is painted after that.
    if (!map.hasLayer(roadFlow.layer)) {
      roadFlow.layer.addTo(map);
    }
    roadFlow.renderProbability(result.probability, {
      members: result.members,
      thresholdM: result.thresholdM
    });
    const hours = result.durationS / 3600;
    showStatus(
      `${result.members} runs over ${hours % 1 ? hours.toFixed(1) : hours} h: ` +
        `${result.floodedJunctions.toLocaleString()} street points flood deeper than ` +
        `${Math.round(result.thresholdM * 100)} cm in at least one. Hover a street for its chance; Play or Reset clears it.`
    );
  });

  return ensemble;
}
