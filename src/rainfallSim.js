// Wires the storm system, rainfall grid, map layers and control panel together.
//
//   Storm System -> Rainfall Grid -> (map canvas + panel readouts)
//
// Keeps the simulation clock, owns the play/pause loop, and translates panel
// input into storm parameters. The physics lives in storm.js and
// rainfallGrid.js; this module is orchestration only.

import L from 'leaflet';
import { createStormSystem, STORM_DEFAULTS } from './storm.js';
import { createRainfallGrid, RAINFALL_LEGEND } from './rainfallGrid.js';
import { createRainfallField, createStormHandles } from './rainfallLayer.js';
import { config } from './config.js';

// The loop ticks at a fixed real-time rate and advances the simulation by
// speed x tick seconds, so "20x" honestly means 20 simulated seconds per real
// second regardless of frame rate. A fixed interval also caps the work: the
// old requestAnimationFrame loop stepped the 160k-cell grid up to 60 times a
// second, which is what made the whole map stutter.
const TICK_MS = 250;

export function createRainfallSimulator({ map, bounds, onWaterAdded, onTick, onReset, getWaterOnMapM3 }) {
  const grid = createRainfallGrid({
    bounds,
    columns: config.rainGridSize,
    rows: config.rainGridSize,
    drainTauSeconds: config.rainDrainTauSeconds
  });

  const stormSystem = createStormSystem();
  const field = createRainfallField(grid);
  const handles = createStormHandles({
    grid,
    stormSystem,
    onChange: () => {
      refreshStormCards();
      previewField();
    },
    onSelect: (id) => selectStorm(id)
  });

  const layer = L.layerGroup([field, handles.layer]);

  const dom = {
    clock: document.querySelector('#sim-clock'),
    play: document.querySelector('#sim-play'),
    add: document.querySelector('#sim-add'),
    reset: document.querySelector('#sim-reset'),
    hint: document.querySelector('#sim-hint'),
    speed: document.querySelector('#sim-speed'),
    speedValue: document.querySelector('#sim-speed-value'),
    storms: document.querySelector('#sim-storms'),
    peak: document.querySelector('#sim-peak'),
    step: document.querySelector('#sim-step'),
    volume: document.querySelector('#sim-volume'),
    water: document.querySelector('#sim-water'),
    legend: document.querySelector('#sim-legend'),
    probe: document.querySelector('#sim-probe')
  };

  const formula = {
    imax: document.querySelector('#formula-imax'),
    sigma: document.querySelector('#formula-sigma'),
    rain: document.querySelector('#formula-rain'),
    cloud: document.querySelector('#formula-cloud'),
    samples: document.querySelector('#formula-samples')
  };

  // Every storm gets the same set of sliders. Speed and bearing are not stored
  // on the storm directly - it carries a velocity vector - so they are read
  // and written through the helpers below.
  const SLIDERS = [
    { key: 'maxIntensityMmPerHour', label: 'Peak intensity', min: 5, max: 200, step: 5,
      format: (v) => `${Math.round(v)} mm/h` },
    { key: 'sigmaMeters', label: 'Sigma', min: 200, max: 6000, step: 100,
      format: (v) => `${Math.round(v)} m` },
    { key: 'rainRadiusMeters', label: 'Rain radius', min: 500, max: 15000, step: 250,
      format: (v) => `${Math.round(v)} m` },
    { key: 'cloudRadiusMeters', label: 'Cloud radius', min: 500, max: 25000, step: 250,
      format: (v) => `${Math.round(v)} m` },
    { key: 'speed', label: 'Speed', min: 0, max: 30, step: 0.5,
      format: (v) => `${Number(v).toFixed(1)} m/s` },
    { key: 'bearing', label: 'Bearing', min: 0, max: 359, step: 1,
      format: (v) => `${String(Math.round(v)).padStart(3, '0')}\u00b0` }
  ];

  let selectedId = null;
  let running = false;
  let placing = false;
  let frameHandle = null;

  // Cards, keyed by storm id, in the order the storms were added.
  const stormCards = new Map();

  function bearingOf(storm) {
    // A parked storm has no direction to read back from its velocity, so the
    // heading the user picked is remembered on the storm itself.
    if (storm.headingDegrees === undefined) {
      storm.headingDegrees =
        (Math.round((Math.atan2(storm.velocityEastMs, storm.velocityNorthMs) * 180) / Math.PI) + 360) % 360;
    }

    return storm.headingDegrees;
  }

  function readStormValue(storm, key) {
    if (key === 'speed') {
      return Math.hypot(storm.velocityEastMs, storm.velocityNorthMs);
    }

    if (key === 'bearing') {
      return bearingOf(storm);
    }

    return storm[key];
  }

  function writeStormValue(storm, key, value) {
    if (key === 'speed' || key === 'bearing') {
      const speed = key === 'speed' ? value : readStormValue(storm, 'speed');
      const bearing = key === 'bearing' ? value : bearingOf(storm);
      const radians = (bearing * Math.PI) / 180;
      storm.headingDegrees = bearing;
      storm.velocityEastMs = speed * Math.sin(radians);
      storm.velocityNorthMs = speed * Math.cos(radians);
      return;
    }

    storm[key] = value;
  }

  function selectedStorm() {
    return stormSystem.storms.find((storm) => storm.id === selectedId) || null;
  }

  function selectStorm(id) {
    selectedId = id;
    handles.setSelected(id);
    refreshStormCards();
  }

  // --- storm editor cards ----------------------------------------------------
  //
  // One card per storm, each independently expandable: collapsed they are a
  // one-line summary, expanded they are the full slider set. Cards are built
  // once and updated in place, so a drag is never interrupted by a rebuild.

  function createStormCard(storm) {
    const element = document.createElement('div');
    element.className = 'storm-card';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'storm-card-header';
    header.setAttribute('aria-expanded', 'true');

    const name = document.createElement('strong');
    const summary = document.createElement('span');
    summary.className = 'storm-card-summary';
    const chevron = document.createElement('span');
    chevron.className = 'storm-card-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    header.append(name, summary, chevron);

    // The fold wrapper is what animates between open and collapsed; the body
    // inside it holds the controls and clips as it folds.
    const fold = document.createElement('div');
    fold.className = 'storm-card-fold';
    const body = document.createElement('div');
    body.className = 'storm-card-body';
    fold.append(body);

    const controls = new Map();
    for (const spec of SLIDERS) {
      const label = document.createElement('label');
      label.className = 'field field--inline';

      const caption = document.createElement('span');
      caption.textContent = spec.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);

      const output = document.createElement('output');

      label.append(caption, input, output);
      body.append(label);
      controls.set(spec.key, { input, output, spec });

      input.addEventListener('input', () => {
        // Editing a card is also how you pick which storm the formula card
        // and the map handles follow.
        selectedId = storm.id;
        handles.setSelected(storm.id);
        writeStormValue(storm, spec.key, Number(input.value));

        // Cloud must stay larger than the rain area: being under cloud is not
        // the same as being rained on.
        if (storm.cloudRadiusMeters <= storm.rainRadiusMeters) {
          storm.cloudRadiusMeters = storm.rainRadiusMeters * 1.2;
        }

        refreshStormCards();
        updateFormulaCard();
        handles.refresh();
        previewField();
      });
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sim-button sim-button--danger storm-card-remove';
    remove.textContent = 'Remove storm';
    remove.addEventListener('click', () => removeStorm(storm.id));
    body.append(remove);

    header.addEventListener('click', () => {
      const expanded = element.classList.toggle('storm-card--collapsed');
      header.setAttribute('aria-expanded', String(!expanded));
      selectStorm(storm.id);
    });

    element.append(header, fold);
    return { element, header, name, summary, controls };
  }

  function refreshStormCards() {
    const storms = stormSystem.storms;

    // Drop cards whose storm is gone, sliding them shut on the way out. The
    // start height has to be measured before the collapse begins, since
    // "auto" is not a height CSS can animate from.
    for (const [id, card] of stormCards) {
      if (!storms.some((storm) => storm.id === id)) {
        const element = card.element;
        element.style.height = `${element.offsetHeight}px`;
        element.classList.add('storm-card--leaving');
        requestAnimationFrame(() => {
          element.style.height = '0px';
        });
        setTimeout(() => element.remove(), 220);
        stormCards.delete(id);
      }
    }

    storms.forEach((storm, index) => {
      let card = stormCards.get(storm.id);
      if (!card) {
        card = createStormCard(storm);
        stormCards.set(storm.id, card);
        dom.storms.append(card.element);
      }

      // Numbered by position, so removing one renumbers the rest instead of
      // leaving a gap that keeps growing.
      card.name.textContent = `Storm - ${index + 1}`;
      card.summary.textContent =
        `${Math.round(storm.maxIntensityMmPerHour)} mm/h · ` +
        `${(storm.rainRadiusMeters / 1000).toFixed(1)} km`;
      card.element.classList.toggle('storm-card--selected', storm.id === selectedId);

      for (const [key, control] of card.controls) {
        const value = readStormValue(storm, key);
        // Never fight the slider the user is currently dragging.
        if (document.activeElement !== control.input) {
          control.input.value = String(value);
        }
        control.output.textContent = control.spec.format(value);
      }
    });

    if (storms.length > 0) {
      dom.storms.hidden = false;
    } else {
      // Hiding the container straight away would cut off the last card's
      // closing slide, so wait for it - unless a storm arrives meanwhile.
      setTimeout(() => {
        if (stormSystem.storms.length === 0) {
          dom.storms.hidden = true;
        }
      }, 240);
    }

    updateFormulaCard();
  }

  function removeStorm(id) {
    const removedIndex = stormSystem.storms.findIndex((storm) => storm.id === id);
    if (removedIndex < 0) {
      return;
    }

    stormSystem.remove(id);

    if (selectedId === id) {
      // Keep editing a neighbouring storm rather than dropping the selection.
      const next = stormSystem.storms[Math.min(removedIndex, stormSystem.storms.length - 1)];
      selectedId = next ? next.id : null;
    }

    handles.refresh();
    handles.setSelected(selectedId);
    refreshStormCards();
    previewField();

    if (running && stormSystem.storms.length === 0) {
      dom.hint.textContent = 'Storm removed - still simulating drainage.';
    }
  }

  // The formula card mirrors whichever storm is being edited; with none
  // selected it shows the defaults a new storm would get. Sample rows give the
  // Gaussian a few concrete values so the sliders read as physics, not knobs.
  function updateFormulaCard() {
    const storm = selectedStorm();
    const imax = storm ? storm.maxIntensityMmPerHour : config.stormMaxIntensity;
    const sigma = storm ? storm.sigmaMeters : config.stormSigma;
    const rainRadius = storm ? storm.rainRadiusMeters : config.stormRainRadius;
    const cloudRadius = storm ? storm.cloudRadiusMeters : config.stormCloudRadius;

    formula.imax.textContent = `${Math.round(imax)} mm/h`;
    formula.sigma.textContent = `${Math.round(sigma)} m`;
    formula.rain.textContent = `${Math.round(rainRadius)} m`;
    formula.cloud.textContent = `${Math.round(cloudRadius)} m`;

    const intensityAt = (d) =>
      d >= rainRadius ? 0 : imax * Math.exp(-(d * d) / (2 * sigma * sigma));

    const rows = [
      { label: 'Centre (d = 0)', d: 0 },
      { label: `${Math.round(sigma).toLocaleString()} m (1σ)`, d: sigma },
      { label: `${Math.round(2 * sigma).toLocaleString()} m (2σ)`, d: 2 * sigma },
      { label: `${Math.round(rainRadius).toLocaleString()} m (rain edge)`, d: rainRadius }
    ].sort((a, b) => a.d - b.d);

    formula.samples.innerHTML = rows
      .map(({ label, d }) => {
        const value = intensityAt(d);
        const text = value >= 0.05 ? `${value.toFixed(1)} mm/h` : 'dry';
        return `<tr><td>${label}</td><td>${text}</td></tr>`;
      })
      .join('');
  }

  // Recompute the intensity field without advancing the clock or adding water,
  // so edits show live while the simulation is paused.
  function previewField() {
    grid.step(stormSystem, 0, { noiseAmplitude: 0 });
    render();
  }

  function formatClock(seconds) {
    const total = Math.floor(seconds);
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function peakIntensity() {
    let peak = 0;
    for (let index = 0; index < grid.intensity.length; index += 1) {
      if (grid.intensity[index] > peak) {
        peak = grid.intensity[index];
      }
    }
    return peak;
  }

  function render() {
    field.update(grid.intensity, 1);
    handles.refresh();

    const totals = grid.totals();
    dom.clock.textContent = formatClock(grid.elapsedSeconds);
    dom.peak.textContent = `${peakIntensity().toFixed(1)} mm/h`;
    dom.step.textContent = `${grid.lastStepPeakMm.toFixed(2)} mm`;
    dom.volume.textContent = `${Math.round(totals.totalVolumeM3).toLocaleString()} m\u00b3`;
    // Standing water on the streets right now, which falls as it drains -
    // unlike the cumulative rain volume beside it.
    dom.water.textContent = `${Math.round(getWaterOnMapM3?.() ?? 0).toLocaleString()} m\u00b3`;
    updateProbe();

    onWaterAdded?.({
      totalVolumeM3: totals.totalVolumeM3,
      peakAccumulationMm: totals.peakAccumulationMm,
      wetCells: totals.wetCells
    });
  }

  function tick() {
    const dt = (TICK_MS / 1000) * Number(dom.speed.value);
    stormSystem.advance(dt);
    grid.step(stormSystem, dt, { noiseAmplitude: config.rainNoiseAmplitude });
    // Deliberately keeps running when the last storm expires or is removed:
    // the surface water is still draining, and watching the flow network dry
    // out is the interesting part.
    render();
    onTick?.(dt);
  }

  function setRunning(next) {
    running = next;
    dom.play.textContent = running ? 'Pause' : 'Play';
    dom.play.classList.toggle('sim-button--active', running);

    if (running && !frameHandle) {
      frameHandle = setInterval(tick, TICK_MS);
    } else if (!running && frameHandle) {
      clearInterval(frameHandle);
      frameHandle = null;
    }
  }

  function setPlacing(next) {
    placing = next;
    dom.add.classList.toggle('sim-button--active', placing);
    dom.hint.textContent = placing
      ? 'Click the map to drop the storm centre.'
      : 'Click Add storm, then click the map to place a storm cell. Drag its centre to move it, or its edge handle to resize.';
    map.getContainer().style.cursor = placing ? 'crosshair' : '';
  }

  function addStormAt(latlng) {
    const local = grid.toLocal(latlng.lat, latlng.lng);
    const storm = stormSystem.add({
      ...STORM_DEFAULTS,
      x: local.x,
      y: local.y,
      maxIntensityMmPerHour: config.stormMaxIntensity,
      sigmaMeters: config.stormSigma,
      rainRadiusMeters: config.stormRainRadius,
      cloudRadiusMeters: config.stormCloudRadius
    });

    handles.refresh();
    selectStorm(storm.id);
    grid.step(stormSystem, 0, { noiseAmplitude: 0 });
    render();
    return storm;
  }

  // --- events ---------------------------------------------------------------

  dom.play.addEventListener('click', () => {
    // Playing without a storm is allowed while water is still draining;
    // only a completely dry, stormless grid has nothing to simulate.
    if (stormSystem.storms.length === 0 && grid.totals().wetCells === 0) {
      dom.hint.textContent = 'Add a storm cell first.';
      return;
    }
    setRunning(!running);
  });

  dom.add.addEventListener('click', () => setPlacing(!placing));

  dom.reset.addEventListener('click', () => {
    setRunning(false);
    setPlacing(false);
    stormSystem.clear();
    grid.reset();
    selectedId = null;
    handles.refresh();
    refreshStormCards();
    // Before render(), not after: the panel reads the street water through
    // getWaterOnMapM3(), so painting first showed the volume that this very
    // click was about to clear - and it took a second press to zero.
    onReset?.();
    render();
  });

  dom.speed.addEventListener('input', () => {
    dom.speedValue.textContent = `${dom.speed.value}x`;
  });

  // Placing a storm: the same click must not open the map's sample-point
  // popup, even though that handler runs after this one for the same event.
  let suppressMapClickUntil = 0;
  map.on('click', (event) => {
    if (!placing) {
      return;
    }
    suppressMapClickUntil = Date.now() + 300;
    addStormAt(event.latlng);
    setPlacing(false);
  });

  // Live cell probe. The cursor position is remembered rather than read only
  // on mousemove, so the numbers keep counting while the mouse rests still
  // over one spot - they are simulation values, not hover values.
  let probeLatLng = null;

  function updateProbe() {
    if (!probeLatLng) {
      return;
    }

    // Off the grid reads as zeros in the same three fields rather than a
    // sentence: the readout keeps its shape, so the panel never reflows.
    const index = grid.indexAt(probeLatLng.lat, probeLatLng.lng);
    if (index < 0) {
      dom.probe.textContent = 'Intensity 0.0 mm/h \u00b7 Surface 0.0 mm \u00b7 Total 0.0 mm';
      return;
    }

    const local = grid.toLocal(probeLatLng.lat, probeLatLng.lng);
    const nearest = stormSystem.storms
      .map((storm) => ({ storm, distance: Math.hypot(local.x - storm.x, local.y - storm.y) }))
      .sort((a, b) => a.distance - b.distance)[0];

    const parts = [
      `Intensity ${grid.intensity[index].toFixed(1)} mm/h`,
      `Surface ${grid.surface[index].toFixed(1)} mm`,
      `Total ${grid.accumulation[index].toFixed(1)} mm`
    ];

    if (nearest) {
      parts.push(`${(nearest.distance / 1000).toFixed(2)} km from storm centre`);
      parts.push(stormSystem.isUnderCloud(local.x, local.y) ? 'under cloud' : 'clear of cloud');
    }

    dom.probe.textContent = parts.join(' \u00b7 ');
  }

  map.on('mousemove', (event) => {
    probeLatLng = event.latlng;
    updateProbe();
  });

  dom.legend.innerHTML = RAINFALL_LEGEND.map(
    (stop) =>
      `<span class="sim-legend-item"><i style="background:${stop.color}"></i>${stop.mmPerHour}</span>`
  ).join('');

  dom.speedValue.textContent = `${dom.speed.value}x`;
  refreshStormCards();
  render();

  return {
    layer,
    grid,
    stormSystem,
    addStormAt,

    /** True while a storm is being placed, or was placed by this click. */
    isPlacingStorm: () => placing || Date.now() < suppressMapClickUntil,

    /** Rain intensity in mm/h at a point right now; 0 outside grid or rain. */
    intensityAt(lat, lng) {
      const index = grid.indexAt(lat, lng);
      return index < 0 ? 0 : grid.intensity[index];
    },

    /**
     * Surface water in mm at a point; 0 outside the grid or once drained.
     * Deliberately the draining field rather than total accumulation, so flow
     * driven by this dries out after the storm moves on.
     */
    depthAt(lat, lng) {
      const index = grid.indexAt(lat, lng);
      if (index < 0) {
        return 0;
      }

      const value = grid.surface[index];
      return value >= 0.05 ? value : 0;
    },

    stop: () => setRunning(false)
  };
}
