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
import { createRainfallField, createStormHandles, createStormTrackLayer } from '../layers/rainfallLayer.js';
import { config } from '../config.js';

// The loop ticks at a fixed real-time rate and advances the simulation by
// speed x tick seconds, so "20x" honestly means 20 simulated seconds per real
// second regardless of frame rate. A fixed interval also caps the work: the
// old requestAnimationFrame loop stepped the 160k-cell grid up to 60 times a
// second, which is what made the whole map stutter.
const TICK_MS = 250;

export function createRainfallSimulator({
  map,
  bounds,
  onWaterAdded,
  onTick,
  onReset,
  getWaterOnMapM3,
  streetCoverage,
  // () => { east, north } m/s for a newly placed storm, or null: the
  // steering wind, so a cell drifts the way the weather says it would.
  defaultVelocity = null,
  // Called whenever a storm is placed, edited or removed in storm mode: the
  // scenario has changed, so anything precomputed from it is stale.
  onStormsChanged = null,
  // Called when Play is pressed to START the clock, before it starts.
  // Returning false calls the press off. This is where an hour picked on
  // the outcome bar is run to: choosing a moment and starting are two
  // decisions, and Play is the one that means "go".
  onPlayRequest = null
}) {
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

  // Tracks under the handles, so a storm's own rings and grips stay on top
  // of the ghosts of where it is going.
  const track = createStormTrackLayer({
    grid,
    stormSystem,
    // Dragging a track's tip aims the storm: same effect as moving its speed
    // and bearing sliders, so it goes through the same path.
    onChange: () => {
      refreshStormCards();
      previewField();
    }
  });
  const layer = L.layerGroup([field, track.layer, handles.layer]);

  // Every place the handles are redrawn, the tracks are too: they are the
  // same picture of the same storms.
  function refreshHandles() {
    handles.refresh();
    track.update();
  }

  const dom = {
    clock: document.querySelector('#sim-clock'),
    play: document.querySelector('#sim-play'),
    add: document.querySelector('#sim-add'),
    reset: document.querySelector('#sim-reset'),
    speed: document.querySelector('#sim-speed'),
    speedValue: document.querySelector('#sim-speed-value'),
    storms: document.querySelector('#sim-storms'),
    peak: document.querySelector('#sim-peak'),
    step: document.querySelector('#sim-step'),
    volume: document.querySelector('#sim-volume'),
    water: document.querySelector('#sim-water'),
    legend: document.querySelector('#sim-legend'),
    coverageNote: document.querySelector('#sim-coverage-note'),
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
  // Set while something else is driving the models (the outcome timeline's
  // precompute): Play is refused until it is done.
  let locked = false;
  // The storm clock counts from zero; the tide and the wind run on real
  // time. A scenario starts "now", so sim time t is this moment plus t.
  let scenarioStartMs = Date.now();
  // Set while another rain source - the forecast scrub - holds the grid. The
  // storm loop stays paused for as long as it does, and the storm controls
  // end it before they take the grid back.
  let externalRain = null;

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
        refreshHandles();
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

    refreshHandles();
    handles.setSelected(selectedId);
    refreshStormCards();
    previewField();

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
    // With a forecast span holding the grid the storms are part of that
    // scenario, so the span is re-rained with them rather than the storms
    // being previewed on their own.
    if (externalRain) {
      externalRain.stormsChanged();
      return;
    }

    grid.step(stormSystem, 0, { noiseAmplitude: 0 });
    render();
    onStormsChanged?.();
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
    // Under forecast rain the heatmap is the rain on screen; painting the
    // same figures again here, resampled and on the storm colour scale, only
    // muddied it.
    // Under a forecast span the map already carries the forecast's own
    // heatmap, so the simulator paints only what it adds to it: the storms.
    field.update(externalRain ? grid.stormIntensity : grid.intensity, 1);
    refreshHandles();
    if (externalRain) {
      dom.play.textContent = externalRain.playing ? 'Pause' : 'Play';
      dom.play.classList.toggle('sim-button--active', Boolean(externalRain.playing));
    }

    const totals = grid.totals();
    dom.clock.textContent = formatClock(grid.elapsedSeconds);
    dom.peak.textContent = `${peakIntensity().toFixed(1)} mm/h`;
    dom.step.textContent = `${grid.lastStepPeakMm.toFixed(2)} mm`;
    dom.volume.textContent = `${Math.round(totals.totalVolumeM3).toLocaleString()} m\u00b3`;
    // Standing water on the streets right now, which falls as it drains -
    // unlike the cumulative rain volume beside it.
    dom.water.textContent = `${Math.round(getWaterOnMapM3?.() ?? 0).toLocaleString()} m\u00b3`;
    updateCoverageNote();
    updateProbe();

    onWaterAdded?.({
      totalVolumeM3: totals.totalVolumeM3,
      peakAccumulationMm: totals.peakAccumulationMm,
      wetCells: totals.wetCells
    });
  }

  /**
   * Street water is only tracked where streets are mapped, and the graph
   * covers the Pattaya-Sattahip strip rather than the whole province. Rain
   * outside it is real but lands on nothing, so "Water on map" reads zero
   * with no visible reason - which is worth saying rather than leaving to be
   * discovered.
   *
   * Judged on the outcome rather than on where the storm sits: a cell whose
   * edge merely grazes the network drops almost nothing on it, so geometry
   * alone called that "covered" while the readout still sat at zero.
   */
  function updateCoverageNote() {
    // A cell dragged out past the rain grid rains on nothing at all: the
    // grid is the model, and a storm outside it reads 0 mm/h however hard
    // its sliders say it is raining. Worth saying outright, since the map
    // goes on well past the edge of what is simulated.
    const outside = stormSystem.storms.filter((storm) => {
      const { lat, lng } = grid.toLatLng(storm.x, storm.y);
      return grid.indexAt(lat, lng) < 0;
    });
    if (outside.length > 0) {
      dom.coverageNote.hidden = false;
      const one = outside.length === 1;
      const which = one
        ? stormSystem.storms.length === 1
          ? 'This storm sits'
          : 'One storm sits'
        : outside.length === stormSystem.storms.length
          ? 'Every storm sits'
          : `${outside.length} of ${stormSystem.storms.length} storms sit`;
      dom.coverageNote.textContent =
        `${which} outside the simulated area, so nothing ${one ? 'it drops' : 'they drop'} is ` +
        'modelled. Drag the centre back inside the study box to simulate it.';
      return;
    }

    const rained = grid.totals().totalVolumeM3;
    const onStreets = getWaterOnMapM3?.() ?? 0;

    // Enough rain to expect a reading, and effectively none arriving.
    // Forecast rain covers the whole province, streets and all, so the
    // ratio says nothing about where it is falling.
    const missing =
      !externalRain && streetCoverage && rained > 10000 && onStreets < rained * 0.02;

    dom.coverageNote.hidden = !missing;
    if (missing) {
      dom.coverageNote.textContent =
        'Rain is falling outside the mapped street network (Pattaya to Sattahip), ' +
        'so no street water is tracked where this storm is.';
    }
  }

  function stepScenario(dt) {
    stormSystem.advance(dt);
    grid.step(stormSystem, dt, { noiseAmplitude: config.rainNoiseAmplitude });
    // Deliberately keeps running when the last storm expires or is removed:
    // the surface water is still draining, and watching the flow network dry
    // out is the interesting part.
    render();
    onTick?.(dt);
  }

  function tick() {
    stepScenario((TICK_MS / 1000) * Number(dom.speed.value));
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

  // Placing shows itself: the Add storm button stays lit and the map cursor
  // turns to a crosshair, so it needs no line of prose alongside.
  function setPlacing(next) {
    placing = next;
    dom.add.classList.toggle('sim-button--active', placing);
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

    // Drift with the steering wind, when there is one; the card's speed
    // and bearing sliders read it back and can override it.
    const drift = defaultVelocity?.();
    if (drift && Number.isFinite(drift.east) && Number.isFinite(drift.north)) {
      storm.velocityEastMs = drift.east;
      storm.velocityNorthMs = drift.north;
    }

    refreshHandles();
    selectStorm(storm.id);
    // Under a forecast span this hands the storm to the span, which re-rains
    // it from here; otherwise it previews on the paused grid as before.
    previewField();
    return storm;
  }

  // --- events ---------------------------------------------------------------

  dom.play.addEventListener('click', async () => {
    if (locked) {
      return;
    }
    // With a forecast span holding the grid, Play runs or pauses the span.
    if (externalRain) {
      externalRain.togglePlay();
      return;
    }
    // Pausing is immediate and unconditional.
    if (running) {
      setRunning(false);
      return;
    }

    if (onPlayRequest && (await onPlayRequest()) === false) {
      return;
    }

    // Playing without a storm is allowed while water is still draining;
    // only a completely dry, stormless grid has nothing to simulate.
    if (stormSystem.storms.length === 0 && grid.totals().wetCells === 0) {
      return;
    }
    setRunning(true);
  });

  dom.add.addEventListener('click', () => setPlacing(!placing));

  dom.reset.addEventListener('click', () => {
    setPlacing(false);

    // With a forecast span holding the grid, Reset is stop-and-rewind. The
    // span and the storms placed on it are the scenario being watched, so
    // they stay and the clock goes back to the span's first hour on dry
    // ground; dropping the span is what a plain click off it does, and a
    // storm goes by its own Remove button.
    if (externalRain) {
      onReset?.();
      externalRain.rewind();
      return;
    }

    setRunning(false);
    stormSystem.clear();
    grid.reset();
    scenarioStartMs = Date.now();
    selectedId = null;
    refreshHandles();
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
    // Where the storms have been and are going; the outcome bar points its
    // horizon at the hour being scrubbed to.
    stormTrack: track,
    addStormAt,

    /** True while a storm is being placed, or was placed by this click. */
    isPlacingStorm: () => placing || Date.now() < suppressMapClickUntil,

    /** Rain intensity in mm/h at a point right now; 0 outside grid or rain. */
    intensityAt(lat, lng) {
      const index = grid.indexAt(lat, lng);
      return index < 0 ? 0 : grid.intensity[index];
    },

    /**
     * The moment the simulation is showing, as real time (Unix ms): the
     * forecast's own clock while a span holds the grid, otherwise the storm
     * clock counted from when the scenario began. The tide and the wind are
     * read at this time.
     */
    get scenarioTimeMs() {
      const shown = externalRain?.shownMs;
      if (Number.isFinite(shown)) {
        return shown;
      }
      return scenarioStartMs + grid.elapsedSeconds * 1000;
    },

    /** Sim seconds -> Unix ms on the scenario's clock, for the ensemble. */
    scenarioTimeAt(simSeconds) {
      return scenarioStartMs + simSeconds * 1000;
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

    stop: () => setRunning(false),

    get running() {
      return running;
    },

    /** Refuse Play (and grey the button) while another driver owns the models. */
    setLocked(flag) {
      locked = Boolean(flag);
      if (locked) {
        setRunning(false);
      }
      dom.play.disabled = locked;
    },

    /** Repaint the storm handles and cards after storms were moved directly. */
    refreshStorms() {
      refreshHandles();
      refreshStormCards();
    },

    /**
     * Advance the storm clock by dt seconds outside the play loop - what one
     * tick does, at a chosen size. For scripts and tests; a forecast span
     * keeps its own clock, so this does nothing while one holds the grid.
     */
    advance(dtSeconds) {
      if (!externalRain && dtSeconds > 0) {
        stepScenario(dtSeconds);
      }
    },

    /**
     * The speed slider as a multiple of its default position, so anything
     * else running on the simulation clock - the forecast playback - can be
     * scaled by the same control. The two run in different units (storm
     * seconds per real second against forecast hours per real second), and
     * a ratio is the one thing they share.
     */
    get speedMultiplier() {
      const value = Number(dom.speed.value);
      const base = Number(dom.speed.defaultValue) || 10;
      return value > 0 ? value / base : 1;
    },

    /** Repaint the readouts (and the field) from the grid as it stands. */
    render,

    /**
     * Lend the grid to another source of rain - the forecast span - until it
     * hands it back with null. The storm loop pauses, because the holder now
     * keeps the clock, and the readouts follow whatever it puts through the
     * grid. Storms carry on raining into that same water: they are part of
     * the span's scenario, and every edit reaches it through previewField.
     * Play toggles the holder's playback and Reset rewinds it.
     */
    setExternalRain(holder) {
      if (holder) {
        setRunning(false);
        setPlacing(false);
      }
      externalRain = holder;
      if (holder) {
        render();
        return;
      }

      // Puts the Play button back to the storm loop's state, and the field
      // back to the storms on their own.
      setRunning(false);
      previewField();
    },

    /** Clear the water on the ground without touching the storms. */
    clearWater() {
      grid.reset();
      scenarioStartMs = Date.now();
      onReset?.();
      render();
    }
  };
}
