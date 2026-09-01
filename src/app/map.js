import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import chonburiBoundaryRaw from '../../data/chonburi.geojson?raw';
import { config } from '../config.js';
import {
  loadDEM,
  calculateSlope,
  calculateFlowDirection,
  calculateFlowAccumulation,
  generateContourLines
} from '../terrain/terrain.js';
import { createFlowAccumulationLayer, createFlowDirectionLayer, createFlowPathLayer } from '../terrain/flow.js';
import { createFlowParticleLayer, setChainDetail } from '../terrain/flowParticles.js';
import { createBoundaryMask, createMaskTest, createPointInsideTest, dilateMask } from '../terrain/boundary.js';
import { createElevationLayer } from '../terrain/elevationLayer.js';
import { createContourLayer } from '../terrain/contourLayer.js';
import { createBaseMaps, MAX_ZOOM } from '../layers/basemaps.js';
import { createRiverLayer, createWaterBodyLayer } from '../layers/waterways.js';
import { createWaterGateLayer } from '../layers/waterGates.js';
import { createSensorStationLayer } from '../layers/sensors.js';
import { createDrainagePipeLayer, createDrainageCoverLayer } from '../layers/drainage.js';
import { createFloodAreaLayer } from '../layers/floodArea.js';
import { createPumpStationLayer } from '../layers/pumpStations.js';
import { createPondingLayer } from '../layers/ponding.js';
import { createCloudLayer } from '../layers/cloudCover.js';
import { createRainForecastLayers } from '../layers/rainForecast.js';
import { createRainGaugeLayer } from '../layers/rainGauges.js';
import { createRoadFlowLayer } from '../hydro/roadFlow.js';
import { createDrainage, loadDrainageModel } from '../hydro/drainage.js';
import { createTideSource } from '../sources/tide.js';
import { createWindSource } from '../sources/wind.js';
import { createRainfallSimulator } from '../sim/rainfallSim.js';
import { createForecastRainDriver } from '../sim/forecastRain.js';
import { analysisCellAreaM2, streetGraphBounds } from './extents.js';
import { createPipeRecolour } from './pipeRecolour.js';
import { createFlowWeighting } from './flowWeighting.js';
import { createSamplePopup } from './samplePopup.js';
import { createDrainageReadout } from './drainageReadout.js';
import { createEnsembleControl } from './ensembleControl.js';
import { createOutcomeControl } from './outcomeControl.js';
import {
  createMouseCoordinatesControl,
  hintClassicToggle,
  hintLayerToggle,
  keepOneTooltipOpen,
  labelLayerControl,
  matchLayerControlWidths,
  placeholderLabel,
  wipLabel
} from './layerControls.js';

// The map: every layer and model built and wired together. The pieces live
// in their own modules (terrain/, hydro/, sim/, sources/, layers/, ui/); the
// glue that only makes sense with all of them in hand - which layer refreshes
// on which event, what the simulator's callbacks do - is here, in the order
// things are built.

const chonburiBoundary = JSON.parse(chonburiBoundaryRaw);

// How the simulator's speed slider bends the forecast's playback rate. The
// two halves of the card run in different units - storm seconds per real
// second against forecast hours per real second - so the slider is read as a
// ratio to its own default, and 1.5 rather than 1 because a straight ratio
// left the slow end at 0.4 forecast hours a second: a day in a minute, still
// too quick to follow a band across the province. The exponent stretches the
// bottom of the range and leaves 10x, where the configured rate stands
// exactly, untouched.
const FORECAST_SPEED_CURVE = 1.5;

// Cadences: how often the street layer, the ponding sheet and the pump
// markers repaint under rain, and how far ahead a storm's track looks when
// nothing else is asking.
const STREET_RENDER_MS = 1200;
const PONDING_MS = 300;
const PUMP_UPDATE_MS = 500;
const TRACK_HORIZON_S = 2 * 3600;

export async function initializeMap() {
  // --- the map itself --------------------------------------------------------
  const map = L.map('map', {
    center: [13.15, 101.05],
    zoom: 9,
    maxZoom: MAX_ZOOM,
    zoomControl: false
  });

  const baseMaps = createBaseMaps();
  baseMaps.Light.addTo(map);
  // Both sit bottom-left. Leaflet *prepends* controls in the bottom corners, so
  // the one added last ends up on top: coordinates first, scale above them.
  const mouseCoordinates = createMouseCoordinatesControl();
  mouseCoordinates.addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.on('mousemove', (event) => mouseCoordinates.update(event.latlng));
  keepOneTooltipOpen(map);

  const boundaryLayer = L.geoJSON(chonburiBoundary, {
    style: {
      className: 'province-outline',
      color: '#f97316',
      weight: 3,
      fillColor: '#fb923c',
      fillOpacity: 0.08
    }
  }).bindTooltip('Chon Buri Province');
  boundaryLayer.addTo(map);
  map.fitBounds(boundaryLayer.getBounds(), { padding: [24, 24] });

  // --- terrain ------------------------------------------------------------------
  const dem = await loadDEM();
  const slope = calculateSlope(dem);
  const flowDirection = calculateFlowDirection(dem);
  const flowAccumulation = calculateFlowAccumulation(flowDirection);
  const contourLines = generateContourLines(dem);

  // Flow is routed across the whole DEM rectangle so cross-border catchments
  // stay intact; only what gets drawn is trimmed to the province, plus a
  // small buffer: the rest spreads the arrows thin and slows rendering.
  const clip = config.clipToBoundary;
  const displayMask = clip && dem.grid ? createBoundaryMask(dem.grid, chonburiBoundary) : null;
  const analysisGrid = dem.analysisGrid || dem.grid;
  const flowMask = analysisGrid
    ? dilateMask(
        createBoundaryMask(analysisGrid, chonburiBoundary),
        analysisGrid.columns,
        analysisGrid.rows,
        config.flowBoundaryBuffer
      )
    : null;
  const isInsideAnalysis = createMaskTest(analysisGrid, flowMask);

  const elevationLayer = createElevationLayer(dem, slope, displayMask);
  const contourLayer = createContourLayer(contourLines, chonburiBoundary);

  // --- geography layers ----------------------------------------------------------
  // One rasterised boundary test shared by every OSM layer.
  const isInsideProvince = config.clipRivers ? createPointInsideTest(chonburiBoundary) : null;
  const [rivers, waterGates, waterBodies, drainagePipes, tunnelSensors, poleSensors, roadFlow] =
    await Promise.all([
      createRiverLayer({ isInside: isInsideProvince }),
      createWaterGateLayer({ isInside: isInsideProvince }),
      createWaterBodyLayer({ isInside: isInsideProvince }),
      createDrainagePipeLayer({ isInside: isInsideProvince }),
      createSensorStationLayer({ sensorType: 'TUNNEL' }),
      createSensorStationLayer({ sensorType: 'ROAD' }),
      createRoadFlowLayer()
    ]);
  // The 80k covers load on first use, not now, so this is only the layer shell.
  const drainageCovers = createDrainageCoverLayer({ isInside: isInsideProvince });
  // The city's own flood-prone areas, drawn to lay over the ponding output.
  // The survey's chambers and flow arrows ride inside the Drainage Pipes layer.
  const floodArea = await createFloodAreaLayer({ isInside: isInsideProvince });

  // --- the physics' inputs -------------------------------------------------------
  // The surveyed pipe graph, the sea level its outfalls meet, and the wind
  // that steers storm cells. All keyless and all optional - each reports
  // itself unavailable rather than failing the map. The tide is read a
  // little offshore of the street network, the wind at its centre.
  const streetBounds = streetGraphBounds(roadFlow.graph);
  const midLat = streetBounds ? (streetBounds.south + streetBounds.north) / 2 : 12.93;
  const [drainageModel, tide, wind] = await Promise.all([
    config.enableDrainageModel ? loadDrainageModel() : Promise.resolve(null),
    createTideSource({ lat: midLat, lng: streetBounds ? streetBounds.west - 0.03 : 100.87 }),
    createWindSource({
      lat: midLat,
      lng: streetBounds ? (streetBounds.west + streetBounds.east) / 2 : 100.9
    })
  ]);
  tide.setOffset(config.tideSurgeM);

  // --- live weather --------------------------------------------------------------
  // Satellite tiles need no fetch, the forecasts do.
  const cloudCover = createCloudLayer({ bounds: dem.bounds });
  const [forecast, rainGauges] = await Promise.all([
    createRainForecastLayers({ boundary: chonburiBoundary, bounds: dem.bounds }),
    createRainGaugeLayer({ isInside: isInsideProvince })
  ]);
  console.info(
    `Weather: GSMaP frame ${cloudCover.frame.year}-${cloudCover.frame.month}-` +
      `${cloudCover.frame.day} ${cloudCover.frame.hour}:00 UTC, ` +
      `rain forecast Open-Meteo ${forecast.openMeteo.available ? 'ready' : 'unavailable'}, ` +
      `TMD ${config.tmdToken ? 'loading in background' : 'no token'}, ` +
      `${rainGauges.count} of ${rainGauges.totalCount} TMD rain gauges in area`
  );
  cloudCover.updateBlur(map.getZoom());
  map.on('zoomend', () => cloudCover.updateBlur(map.getZoom()));

  // --- the drainage network ------------------------------------------------------
  // Under the streets (hydro/drainage.js picks the engine): grated inlets
  // take street water down, the surveyed pipes carry it, outfalls discharge
  // against the tide, pump stations lift it out, and a manhole filled to its
  // lid spills back onto the street above it. Which engine does the carrying
  // is VITE_DRAINAGE_ENGINE; the street model above is the same either way.
  let pipeNet = null;
  if (drainageModel && roadFlow.dynamic && roadFlow.graph) {
    pipeNet = await createDrainage({
      model: drainageModel,
      streets: roadFlow.graph,
      onSpill: (streetIndex, m3) => roadFlow.dynamic.addWater(streetIndex, m3)
    });
    roadFlow.dynamic.attachPipes(pipeNet);
    const s = pipeNet.stats;
    console.info(
      `Drainage model: ${s.nodes.toLocaleString()} junctions, ${s.conduits.toLocaleString()} conduits, ` +
        `${s.inlets.toLocaleString()} inlets, ${s.pumps} pump stations, ${s.seaOutfalls} sea + ` +
        `${s.freeOutfalls} free outfalls, ${s.capacityM3.toLocaleString()} m³ capacity; ` +
        `${s.coveredStreets.toLocaleString()} street junctions covered`
    );
  } else {
    console.info('Drainage model: off (no drainage-model.json or disabled); streets use the generic drain term');
  }
  const pumpStations = createPumpStationLayer({ model: drainageModel, pipeNet, isInside: isInsideProvince });
  const pipes = createPipeRecolour({ pipeNet, drainagePipes });

  // Standing water as pools: each wet junction's depth painted over the area
  // it has spread to, so low ground reads as a pond rather than a thin line.
  const pondingLayer = roadFlow.dynamic
    ? createPondingLayer({
        lat: roadFlow.graph.lat,
        lng: roadFlow.graph.lng,
        edges: roadFlow.graph.edges,
        depths: roadFlow.dynamic.depths,
        curbDepthM: roadFlow.dynamic.curbDepthM,
        // Below the kerb the water is on the street itself; above it, on the
        // catchment strip the model spreads it over.
        streetWidthM: 10,
        stripWidthM: config.streetCatchmentWidthM,
        stops: roadFlow.dynamic.depthStops
      }, { isInside: isInsideProvince })
    : L.layerGroup([]);
  console.info(
    `Sea level: ${tide.source}` +
      (tide.range ? ` (${tide.range.minM.toFixed(2)} to +${tide.range.maxM.toFixed(2)} m this week)` : '') +
      `; wind: ${wind.source}`
  );
  if (roadFlow.stats) {
    console.info(
      `Street flow: ${roadFlow.stats.nodeCount.toLocaleString()} junctions, ` +
        `${roadFlow.stats.edgeCount.toLocaleString()} links, ` +
        `${roadFlow.stats.sinks.toLocaleString()} sinks, ` +
        `${roadFlow.stats.despiked.toLocaleString()} DEM spikes clamped, ` +
        `${roadFlow.stats.noisePitsFilled.toLocaleString()} noise pits filled, ` +
        `${roadFlow.stats.lines} lines drawn`
    );
  }

  // --- the grid flow layers -------------------------------------------------------
  const visibleFlowDirection = flowDirection.filter(isInsideAnalysis);
  // Particles need the grid to interpolate across, and motion the viewer has
  // not asked the browser to spare them; otherwise the static arrows.
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const flowArrowOptions = {
    cellSizeDegrees: analysisGrid ? (analysisGrid.bounds.north - analysisGrid.bounds.south) / analysisGrid.rows : 0
  };
  const particleFlowDirection =
    config.flowParticles && analysisGrid && !reducedMotion
      ? createFlowParticleLayer(visibleFlowDirection, analysisGrid, { isDark: (name) => name === 'Satellite' })
      : null;
  // The arrows are the classic look for this layer, built on first request.
  let arrowFlowDirection = null;
  const flowDirectionArrows = () => {
    if (!arrowFlowDirection) {
      arrowFlowDirection = createFlowDirectionLayer(visibleFlowDirection, flowArrowOptions);
    }
    return arrowFlowDirection;
  };
  // A shell, so Shift + tick can swap which rendering the checkbox shows.
  const flowDirectionLayer = particleFlowDirection
    ? L.layerGroup([particleFlowDirection])
    : createFlowDirectionLayer(visibleFlowDirection, flowArrowOptions);
  const visibleFlowAccumulation = flowAccumulation.filter(isInsideAnalysis);
  const cellAreaM2 = analysisCellAreaM2(analysisGrid);
  const flowPathLayer = createFlowPathLayer(visibleFlowDirection, visibleFlowAccumulation, { cellAreaM2 });
  const flowAccumulationLayer = createFlowAccumulationLayer(visibleFlowAccumulation);

  // Layers still running on demo data are marked in red rather than spelled
  // out with a "(Placeholder)" suffix, which kept the control cluttered.
  const usingPlaceholderDEM = dem.source === 'placeholder';
  const demLabel = (text) => (usingPlaceholderDEM ? placeholderLabel(text) : text);
  const elevationLayerLabel = demLabel('Elevation');
  const flowDirectionLabel = demLabel('Flow Direction');
  // "Flow accumulation" is the GIS term for upstream contributing area -
  // where flow CONVERGES, not where water stands - so the menu says Catchment.
  const flowAccumulationLabel = demLabel('Catchment');
  const flowPathLabel = demLabel('Flow Paths');
  const contourLayerLabel = demLabel('Elevation Contours');

  const geographyControl = L.control.layers(
    baseMaps,
    {
      'Chon Buri Boundary': boundaryLayer,
      [elevationLayerLabel]: elevationLayer,
      [contourLayerLabel]: contourLayer,
      [rivers.label]: rivers.layer,
      [waterBodies.label]: waterBodies.layer,
      [waterGates.label]: waterGates.layer,
      // The surveyed drainage network from the city's GIS geodatabase: the
      // gravity pipes, the manhole/inlet covers and the pump stations, as
      // three layers. The covers paint only when zoomed in and load on first
      // use, so the menu can offer them without 80k markers up front.
      [drainagePipes.available ? drainagePipes.label : wipLabel(drainagePipes.label)]: drainagePipes.layer,
      [drainageCovers.label]: drainageCovers.layer,
      [floodArea.label]: floodArea.layer,
      [pumpStations.available ? pumpStations.label : wipLabel(pumpStations.label)]: pumpStations.layer,
      [tunnelSensors.label]: tunnelSensors.layer,
      [poleSensors.label]: poleSensors.layer
    },
    { collapsed: false }
  );

  // --- rain-mode state ------------------------------------------------------------
  // Shared by the simulator's callbacks and the layer-control handlers below.
  let rainLayerActive = false;
  let lastPondingUpdate = 0;
  let lastPumpUpdate = 0;
  let streetRenderTimer = null;
  let streetRenderDelay = STREET_RENDER_MS;
  // Shift held while ticking a flow layer in the control asks for the classic
  // rendering (dashed lines, or the arrows for Flow Direction). Captured
  // before Leaflet handles the click, so the overlayadd handler can read it.
  let shiftTick = false;
  document.addEventListener('click', (event) => {
    shiftTick = event.shiftKey === true;
  }, true);
  let flowPathsClassic = false;
  // The wiring modules below are built once the simulator exists, so its
  // callbacks reach them through these; each is guarded until then.
  let flowWeighting = null;
  let samplePopup = null;
  let readout = null;
  let ensemble = null;
  let outcomeControl = null;
  let forecastRain = null;
  const isForecastActive = () => Boolean(forecastRain?.active);
  // A span with its water window set to zero draws and routes the rain but
  // steps nothing, the way a forecast did before the models were wired to
  // it: the street layer, the panel tile and the sample point all read the
  // routed surface water instead of standing depths.
  const isForecastRouted = () => isForecastActive() && !forecastRain.waterEnabled;

  // --- the rainfall simulator ---------------------------------------------------------
  // Storms are placed over the DEM extent, so the simulator shares its bounds.
  const rainfall = createRainfallSimulator({
    map,
    bounds: dem.bounds,
    onWaterAdded: () => flowWeighting?.schedule(),

    // Live total for the "Water on map" tile: what is standing on the street
    // network right now, which falls as it drains - unlike the cumulative
    // rain volume beside it. Forecast rain runs the same street model, so
    // the tile means the same thing either way - unless its water is off,
    // when the water on the ground is all there is to report.
    getWaterOnMapM3: () =>
      isForecastRouted()
        ? rainfall.grid.surfaceVolumeM3()
        : roadFlow.dynamic
          ? roadFlow.dynamic.totals().storedM3
          : 0,

    // Where street water can exist at all, measured from the graph itself
    // rather than assumed from the build-time bbox.
    streetCoverage: streetBounds,

    // A newly placed storm drifts with the forecast steering wind at the
    // moment on the scenario's clock; its sliders can override it.
    defaultVelocity: () =>
      config.stormFollowsWind && wind.available ? wind.steeringVelocityAt(rainfall.scenarioTimeMs) : null,

    // A placed, edited or removed storm is a different scenario: the
    // precomputed outcomes no longer describe it.
    onStormsChanged: () => outcomeControl?.invalidate(),

    // Play runs the scenario to whatever hour the outcome bar is parked on
    // before the clock starts, so picking an hour and starting are two
    // separate acts.
    onPlayRequest: async () => (outcomeControl ? outcomeControl.playRequest() : true),

    // Every simulation tick advances the street water: rain lands at the
    // current intensity and the water crawls downstream at street-flow speed.
    // Stepping is cheap; redrawing the polylines is not, so rendering is
    // throttled separately.
    onTick: (dtSeconds) => {
      // An open sample popup reads live, whether or not the street layer is on.
      samplePopup?.refresh();
      const nowMs = performance.now();
      if (nowMs - lastPumpUpdate > PUMP_UPDATE_MS) {
        lastPumpUpdate = nowMs;
        pumpStations.update();
      }

      if (!roadFlow.dynamic) {
        return;
      }

      // Stepped whatever the rainfall layer's checkbox says: the storm is
      // still raining and the grid is still advancing, so the street water
      // and the "Water on map" readout must advance with them. Only the
      // drawing below is gated on the layer being visible.
      //
      // The sea stands at the tide for this moment on the scenario's clock;
      // streets drain first (rain, inlets, soakage, outfalls), then the
      // pipes carry what came down and spill what they cannot hold back up.
      const seaLevelM = tide.levelAt(rainfall.scenarioTimeMs);
      roadFlow.dynamic.setSeaLevel(seaLevelM);
      pipeNet?.setSeaLevel(seaLevelM);
      // The streets step the drains inside their own substeps.
      roadFlow.dynamic.step((lat, lng) => rainfall.intensityAt(lat, lng), dtSeconds);
      readout?.update();

      if (!rainLayerActive) {
        return;
      }

      // Ponding is cheap to repaint (a few ms), so it follows the water on
      // its own short cadence rather than waiting for the street layer's
      // rebuild, which can be seconds behind under a big flood.
      if (map.hasLayer(pondingLayer) && nowMs - lastPondingUpdate >= PONDING_MS) {
        lastPondingUpdate = nowMs;
        pondingLayer.update?.();
      }
      // The Outcome slider's caption follows the clock while the storm plays.
      outcomeControl?.showLabel();

      if (!streetRenderTimer) {
        streetRenderTimer = setTimeout(() => {
          streetRenderTimer = null;
          // Rain may have been switched off since this was queued; repainting
          // the flood view now would paint over the restored baseline.
          if (rainLayerActive && map.hasLayer(roadFlow.layer)) {
            // Pace the next redraw by what this one cost, so a machine that
            // takes 300 ms to rebuild a big flood is not asked to do it
            // again 900 ms later - that is what froze the street layer.
            const started = performance.now();
            roadFlow.dynamic.render();
            const cost = performance.now() - started;
            streetRenderDelay = Math.min(6000, Math.max(STREET_RENDER_MS, cost * 6));
          }
          if (map.hasLayer(drainagePipes.layer)) {
            pipes.recolour();
          }
        }, streetRenderDelay);
      }
    },

    onReset: () => {
      if (roadFlow.dynamic) {
        roadFlow.dynamic.reset();
        if (rainLayerActive) {
          roadFlow.dynamic.render();
        }
      }
      pipeNet?.reset();
      pipes.restore();
      pondingLayer.update?.();
      pumpStations.update();
      samplePopup?.refresh();
      readout?.update();
      outcomeControl?.reset();
    }
  });

  // Which rain-grid cell a street junction sits in never changes, so the
  // water model reads the intensity field straight out of the array rather
  // than asking for a lat/lng lookup per junction: that was 266k
  // projections and object allocations on every step, and it dominated any
  // long run.
  if (roadFlow.dynamic) {
    const cells = new Int32Array(roadFlow.graph.nodeCount);
    for (let n = 0; n < roadFlow.graph.nodeCount; n += 1) {
      cells[n] = rainfall.grid.indexAt(roadFlow.graph.lat[n], roadFlow.graph.lng[n]);
    }
    roadFlow.dynamic.setRainField(rainfall.grid.intensity, cells);
  }

  // --- the wiring around the simulator ----------------------------------------------
  flowWeighting = createFlowWeighting({
    map,
    rainfall,
    roadFlow,
    grid: { flowDirection, visibleFlowDirection, visibleFlowAccumulation, isInsideAnalysis, cellAreaM2 },
    layers: { flowPathLayer, flowAccumulationLayer },
    state: {
      isRainActive: () => rainLayerActive,
      isForecastActive,
      isForecastRouted,
      isPathsClassic: () => flowPathsClassic
    },
    restorePipes: () => pipes.restore()
  });
  samplePopup = createSamplePopup({ map, rainfall, roadFlow, pipeNet, isForecastRouted });
  readout = createDrainageReadout({ rainfall, tide, wind, pipeNet, roadFlow });
  ensemble = createEnsembleControl({
    map,
    rainfall,
    roadFlow,
    pipeNet,
    tide,
    forecastRain: () => forecastRain,
    updateReadout: () => readout.update()
  });
  outcomeControl = createOutcomeControl({
    rainfall,
    roadFlow,
    pipeNet,
    tide,
    trackHorizonS: TRACK_HORIZON_S,
    state: { isForecastActive, isEnsembleRunning: () => ensemble.running },
    // The live models hold a new moment: repaint everything that reads them.
    paint: () => {
      if (rainLayerActive && map.hasLayer(roadFlow.layer)) {
        roadFlow.dynamic.render();
      }
      if (map.hasLayer(pondingLayer)) {
        pondingLayer.update?.();
      }
      if (map.hasLayer(drainagePipes.layer)) {
        pipes.recolour();
      }
      readout.update();
      samplePopup.refresh();
      flowWeighting.schedule();
    }
  });

  // --- forecast rain: Shift + drag on the forecast timeline -------------------------
  // The forecast card marks a span; the driver rains the active forecast
  // onto the simulator's grid through it, and the flow layers follow the
  // surface water the way they follow a storm's.
  forecastRain = createForecastRainDriver({
    rainfall,
    // The simulator's speed slider paces this the way it paces the storm
    // clock, so one control drives both halves of the card.
    playHoursPerSecond: () => config.forecastPlayHoursPerSecond * rainfall.speedMultiplier ** FORECAST_SPEED_CURVE,
    // A forecast is the realistic input, so it runs the same physics a
    // placed storm does rather than only tinting the ground it fell on.
    streets: roadFlow.dynamic,
    pipes: pipeNet,
    seaLevelAt: (ms) => tide.levelAt(ms),
    // The rain-driven layers follow the moment shown at once; the
    // water-driven ones only once the water has been run there.
    refreshLayers: ({ water = true } = {}) => {
      flowWeighting.apply();
      samplePopup.refresh();
      if (!water) {
        return;
      }
      flowWeighting.refreshStreets();
      if (map.hasLayer(pondingLayer)) {
        pondingLayer.update?.();
      }
      if (map.hasLayer(drainagePipes.layer)) {
        pipes.recolour();
      }
      pumpStations.update();
      readout.update();
    },
    onState: (state) => forecast.card.setSeries(state)
  });
  forecast.card.setSeriesHandler({
    canStart: () => map.hasLayer(rainfall.layer),
    begin: ({ grid, fromMs }) => forecastRain.begin({ forecastGrid: grid, fromMs }),
    setEnd: (ms) => forecastRain.setEnd(ms),
    play: () => forecastRain.play(),
    showAt: (ms) => forecastRain.showAt(ms),
    end: () => forecastRain.end()
  });

  // --- layer toggles -------------------------------------------------------------------
  map.on('overlayadd', (event) => {
    // Shift on the tick chooses the classic rendering for that layer.
    if (event.layer === flowDirectionLayer && particleFlowDirection) {
      const wanted = shiftTick ? flowDirectionArrows() : particleFlowDirection;
      if (!flowDirectionLayer.hasLayer(wanted)) {
        flowDirectionLayer.clearLayers();
        flowDirectionLayer.addLayer(wanted);
      }
    }
    if (event.layer === flowPathLayer) {
      flowPathsClassic = shiftTick;
    }
    if (event.layer === roadFlow.layer) {
      roadFlow.setClassic?.(shiftTick);
    }
    if (event.layer === pondingLayer) {
      pondingLayer.update?.();
    }
    if (event.layer === drainagePipes.layer) {
      // Otherwise the fill colours wait on the street layer's throttled
      // timer, which stretches to 6 s under a big flood and does not run at
      // all while the rain is paused: a layer switched on mid-storm sat at
      // its survey colours, reading as empty pipe under a flooded street.
      pipes.recolour();
    }

    if (event.layer === rainfall.layer) {
      rainLayerActive = true;
      flowWeighting.apply();
      roadFlow.dynamic?.render();
      forecast.card.refreshHint();
    } else if (rainLayerActive && (event.layer === flowPathLayer || event.layer === flowAccumulationLayer)) {
      // Switched on while rain mode is active: rebuild rather than show stale.
      flowWeighting.apply();
    } else if (event.layer === flowPathLayer) {
      // Repopulate in the just-chosen style.
      flowWeighting.repopulatePaths();
    } else if (event.layer === roadFlow.layer) {
      // Rebuild in the just-chosen style; in rain mode with live water.
      flowWeighting.refreshStreets();
    }
  });

  map.on('overlayremove', (event) => {
    if (event.layer === rainfall.layer) {
      rainLayerActive = false;
      // A forecast span cannot outlive the grid it rains onto.
      forecastRain.end();
      flowWeighting.cancel();
      if (streetRenderTimer) {
        clearTimeout(streetRenderTimer);
        streetRenderTimer = null;
      }
      flowWeighting.apply();
      forecast.card.refreshHint();
    }
  });

  // --- the other two controls ------------------------------------------------------------
  const simulationControl = L.control.layers(
    null,
    {
      'Rainfall Simulator': rainfall.layer,
      [flowDirectionLabel]: flowDirectionLayer,
      [flowPathLabel]: flowPathLayer,
      [wipLabel(roadFlow.label)]: roadFlow.layer,
      Ponding: pondingLayer,
      [flowAccumulationLabel]: flowAccumulationLayer
    },
    { collapsed: false }
  );

  const weatherControl = L.control.layers(
    null,
    {
      [cloudCover.label]: cloudCover.layer,
      [forecast.openMeteo.available ? forecast.openMeteo.label : wipLabel(forecast.openMeteo.label)]:
        forecast.openMeteo.layer,
      // TMD arrives a minute or so after load; the label reflects whether it
      // can arrive at all, which is what a token decides.
      [config.tmdToken ? forecast.tmd.label : wipLabel(`${forecast.tmd.label} - no token`)]: forecast.tmd.layer,
      [rainGauges.available ? rainGauges.label : wipLabel(rainGauges.label)]: rainGauges.layer
    },
    { collapsed: false }
  );

  // Default view: the Light basemap, the provincial outline, and the rain
  // gauges. Everything heavier starts off so the first paint stays quick.
  rainGauges.layer.addTo(map);

  geographyControl.addTo(map);
  simulationControl.addTo(map);
  weatherControl.addTo(map);
  matchLayerControlWidths();
  labelLayerControl(geographyControl, 'Geography');
  labelLayerControl(simulationControl, 'Water Simulation');
  labelLayerControl(weatherControl, 'Weather');
  hintLayerToggle(geographyControl, drainageCovers.layer, 'Zoom in to street level to see the covers');
  hintLayerToggle(
    simulationControl,
    flowAccumulationLayer,
    'Upstream area draining through each cell: where flow converges, not where water stands. Ponding shows standing water.'
  );
  hintLayerToggle(
    simulationControl,
    pondingLayer,
    'Standing water while it rains, as a blue sheet under the streets: each wet junction painted over the ground it has spread to, darker the deeper'
  );
  hintClassicToggle(simulationControl, [flowDirectionLayer, flowPathLayer, roadFlow.layer]);

  // Flow detail: how much of the network Flow Paths and Street Flow draw, in
  // both the smooth and the classic style. Full detail is every chain in
  // view; lower keeps the longer ones, generalising the picture to the main
  // channels the way a smaller-scale map would - and costing less to draw.
  const detailInput = document.querySelector('#sim-detail');
  const detailValue = document.querySelector('#sim-detail-value');
  let detailFrame = 0;
  function applyFlowDetail() {
    detailValue.textContent = `${detailInput.value}%`;
    // A drag fires far faster than the network can be re-picked, and only
    // where it ends up matters.
    if (detailFrame) {
      return;
    }
    detailFrame = requestAnimationFrame(() => {
      detailFrame = 0;
      setChainDetail(Number(detailInput.value) / 100);
    });
  }
  detailInput.addEventListener('input', applyFlowDetail);
  applyFlowDetail();

  if (import.meta.env?.DEV) {
    // A console handle on the models for poking and scripted checks, e.g.
    //   __waterMap.rainfall.addStormAt({ lat: 12.93, lng: 100.89 });
    //   __waterMap.rainfall.advance(600); __waterMap.roadFlow.dynamic.totals()
    window.__waterMap = {
      map,
      rainfall,
      roadFlow,
      pipeNet,
      tide,
      wind,
      ensemble,
      forecastRain,
      forecast,
      outcome: outcomeControl.outcome,
      // Live, so a setting can be tried without a restart while calibrating.
      config,
      pondingLayer,
      drainagePipes,
      drainageCovers,
      pumpStations
    };
  }

  return map;
}
