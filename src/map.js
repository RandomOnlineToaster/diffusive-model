import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import chonburiBoundaryRaw from '../data/chonburi.geojson?raw';
import {
  loadDEM,
  calculateSlope,
  calculateFlowDirection,
  calculateFlowAccumulation,
  generateContourLines,
  getElevationAt
} from './terrain.js';
import {
  createFlowAccumulationLayer,
  createFlowDirectionLayer,
  createFlowPathLayer,
  drainageCutoff,
  populateFlowAccumulationLayer,
  populateFlowPathLayer
} from './flow.js';
import { createFlowParticleLayer, setChainDetail } from './flowParticles.js';
import {
  createRiverLayer,
  createSensorStationLayer,
  createWaterBodyLayer,
  createWaterGateLayer
} from './infrastructure.js';
import { createPondingLayer } from './ponding.js';
import {
  createBoundaryMask,
  createMaskTest,
  createPointInsideTest,
  dilateMask
} from './boundary.js';
import { createBaseMaps, MAX_ZOOM } from './basemaps.js';
import { createDrainagePipeLayer, createDrainageCoverLayer } from './drainage.js';
import { createRoadFlowLayer } from './roadFlow.js';
import { createPipeNetwork, loadDrainageModel, NODE_SEA_OUTFALL } from './pipeNetwork.js';
import { createTideSource } from './tide.js';
import { createWindSource } from './wind.js';
import { createEnsembleRunner } from './ensemble.js';
import { createOutcomeTimeline } from './outcomeTimeline.js';
import { createOutcomeBar } from './outcomeBar.js';
import { createRainfallSimulator } from './rainfallSim.js';
import {
  createCloudLayer,
  createRainForecastLayers,
  createRainGaugeLayer
} from './weather.js';
import { createForecastRainDriver } from './forecastRain.js';
import { config } from './config.js';

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

export async function initializeMap() {
  const map = L.map('map', {
    center: [13.15, 101.05],
    zoom: 9,
    maxZoom: MAX_ZOOM,
    zoomControl: false
  });

  const baseMaps = createBaseMaps();
  const defaultBaseMap = 'Light';
  baseMaps[defaultBaseMap].addTo(map);
  // Both sit bottom-left. Leaflet *prepends* controls in the bottom corners, so
  // the one added last ends up on top: coordinates first, scale above them.
  const mouseCoordinates = createMouseCoordinatesControl();
  mouseCoordinates.addTo(map);

  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

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

  const dem = await loadDEM();
  const slope = calculateSlope(dem);
  const flowDirection = calculateFlowDirection(dem);
  const flowAccumulation = calculateFlowAccumulation(flowDirection);
  const contourLines = generateContourLines(dem);

  // Flow is routed across the whole DEM rectangle so cross-border catchments
  // stay intact; only what gets drawn is trimmed to the province.
  const clip = config.clipToBoundary;
  const displayMask = clip && dem.grid ? createBoundaryMask(dem.grid, chonburiBoundary) : null;
  const analysisGrid = dem.analysisGrid || dem.grid;
  // Flow is routed across the full DEM, but only drawn inside the province plus
  // a small buffer: the rest spreads the arrows thin and slows rendering.
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
  // One rasterised boundary test shared by every OSM layer.
  const isInsideProvince = config.clipRivers ? createPointInsideTest(chonburiBoundary) : null;
  const [
    rivers,
    waterGates,
    waterBodies,
    drainagePipes,
    tunnelSensors,
    poleSensors,
    roadFlow
  ] = await Promise.all([
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

  // What the drainage physics runs on: the surveyed pipe graph, the sea level
  // its outfalls meet, and the wind that steers storm cells. All keyless and
  // all optional - each reports itself unavailable rather than failing the
  // map. The tide is read a little offshore of the street network, the wind
  // at its centre.
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

  // Live weather: satellite tiles need no fetch, the TMD forecast does.
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

  // The drainage network under the streets (pipeNetwork.js): grated inlets
  // take street water down, the surveyed pipes carry it by Manning's law,
  // outfalls discharge against the tide, pump stations lift it out, and a
  // manhole filled to its lid spills back onto the street above it.
  let pipeNet = null;
  if (drainageModel && roadFlow.dynamic && roadFlow.graph) {
    pipeNet = createPipeNetwork({
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
      })
    : L.layerGroup([]);
  console.info(
    `Sea level: ${tide.source}` +
      (tide.range ? ` (${tide.range.minM.toFixed(2)} to +${tide.range.maxM.toFixed(2)} m this week)` : '') +
      `; wind: ${wind.source}`
  );

  // Recolour each surveyed drain run by how full it is while raining, and
  // put the survey colours back afterwards.
  const PIPE_FILL_COLORS = ['#60a5fa', '#22c55e', '#eab308', '#f97316', '#dc2626'];
  let pipesRecoloured = false;
  function recolorPipes() {
    if (!pipeNet || !drainagePipes.featureLayers) {
      return;
    }

    const fills = pipeNet.fillByFeature();
    for (const [id, featureLayer] of drainagePipes.featureLayers) {
      const fraction = fills[id];
      if (!(fraction > 0.02)) {
        if (pipesRecoloured) {
          featureLayer.setStyle(drainagePipes.baseStyle(featureLayer.feature));
        }
        continue;
      }
      const cls = Math.min(PIPE_FILL_COLORS.length - 1, Math.floor(fraction * PIPE_FILL_COLORS.length));
      featureLayer.setStyle({ color: PIPE_FILL_COLORS[cls] });
    }
    pipesRecoloured = true;
  }

  function restorePipeStyles() {
    if (!pipesRecoloured || !drainagePipes.featureLayers) {
      return;
    }

    for (const featureLayer of drainagePipes.featureLayers.values()) {
      featureLayer.setStyle(drainagePipes.baseStyle(featureLayer.feature));
    }
    pipesRecoloured = false;
  }

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
  const visibleFlowDirection = flowDirection.filter(isInsideAnalysis);
  // Particles need the grid to interpolate across, and motion the viewer has
  // not asked the browser to spare them; otherwise the static arrows.
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const flowArrowOptions = {
    cellSizeDegrees: analysisGrid
      ? (analysisGrid.bounds.north - analysisGrid.bounds.south) / analysisGrid.rows
      : 0
  };
  const particleFlowDirection =
    config.flowParticles && analysisGrid && !reducedMotion
      ? createFlowParticleLayer(visibleFlowDirection, analysisGrid, {
          isDark: (name) => name === 'Satellite'
        })
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
  const flowPathOptions = { cellAreaM2: analysisCellAreaM2(analysisGrid) };
  const flowPathLayer = createFlowPathLayer(
    visibleFlowDirection,
    visibleFlowAccumulation,
    flowPathOptions
  );
  const flowAccumulationLayer = createFlowAccumulationLayer(visibleFlowAccumulation);
  // Layers still running on demo data are marked in red rather than spelled out
  // with a "(Placeholder)" suffix, which kept the control cluttered.
  const usingPlaceholderDEM = dem.source === 'placeholder';
  const demLabel = (text) => (usingPlaceholderDEM ? placeholderLabel(text) : text);
  const elevationLayerLabel = demLabel('Elevation');
  const flowDirectionLabel = demLabel('Flow Direction');
  // "Flow accumulation" is the GIS term for upstream contributing area - where
  // flow CONVERGES, not where water stands - so the menu says so.
  const flowAccumulationLabel = demLabel('Catchment (flow accumulation)');
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
      // gravity pipes and the manhole/inlet covers, as two separate layers.
      // The covers paint only when zoomed in and load on first use, so the
      // menu can offer them without the map carrying 80k markers up front.
      [drainagePipes.available ? drainagePipes.label : wipLabel(drainagePipes.label)]:
        drainagePipes.layer,
      [drainageCovers.label]: drainageCovers.layer,
      [tunnelSensors.label]: tunnelSensors.layer,
      [poleSensors.label]: poleSensors.layer
    },
    { collapsed: false }
  );

  // Rain-driven flow state, declared before the simulator because its initial
  // render fires onWaterAdded synchronously (a later declaration would be TDZ).
  const RAIN_FLOW_REFRESH_MS = 2000;
  const STREET_RENDER_MS = 1200;
  const PONDING_MS = 300;
  // How far ahead a storm's track looks when nothing else is asking.
  const TRACK_HORIZON_S = 2 * 3600;
  let lastPondingUpdate = 0;
  let rainLayerActive = false;
  let rainRefreshTimer = null;
  let lastRainRefresh = 0;
  let streetRenderTimer = null;
  // Shift held while ticking a flow layer in the control asks for the classic
  // rendering (dashed lines, or the arrows for Flow Direction). Captured
  // before Leaflet handles the click, so the overlayadd handler can read it.
  let shiftTick = false;
  document.addEventListener(
    'click',
    (event) => {
      shiftTick = event.shiftKey === true;
    },
    true
  );
  let flowPathsClassic = false;
  let streetRenderDelay = STREET_RENDER_MS;
  // Declared here for the same reason: the tick handler below refreshes it.
  let samplePoint = null;
  // Shift + drag on the forecast bar; built once the simulator exists.
  let forecastRain = null;
  // The outcome timeline (the "Outcome at" bar) and the bar itself; built
  // once the simulator exists, invalidated whenever the storms change.
  let outcome = null;
  let outcomeBar = null;
  // The hour the outcome bar is parked on, waiting for Play.
  let armedSeconds = null;

  // Storms are placed over the DEM extent, so the simulator shares its bounds.
  const rainfall = createRainfallSimulator({
    map,
    bounds: dem.bounds,
    onWaterAdded: () => {
      scheduleRainFlowRefresh();
    },

    // Live total for the "Water on map" tile: what is standing on the street
    // network right now, which falls as it drains - unlike the cumulative
    // rain volume beside it. Under forecast rain the streets are routed, not
    // ponded, so the tile reads the water on the ground instead.
    getWaterOnMapM3: () =>
      forecastRain?.active
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
    onStormsChanged: () => {
      outcome?.invalidate();
      outcomeBar?.setComputed(0);
      showOutcomeLabel();
    },

    // Play runs the scenario to whatever hour the outcome bar is parked on
    // before the clock starts, so picking an hour and starting are two
    // separate acts.
    onPlayRequest: async () => {
      if (armedSeconds === null || !outcome) {
        return true;
      }
      const target = armedSeconds;
      armedSeconds = null;
      showOutcomeStatus('');
      showOutcomeLabel();
      await outcome.showAt(target);
      // The hour is on the map now: the ghosts that predicted it would only
      // sit on top of the water they predicted.
      rainfall.stormTrack.setPreview(false);
      rainfall.stormTrack.setHorizon(TRACK_HORIZON_S);
      showOutcomeStatus('Showing this hour. Press Play again to run on from here.');
      showOutcomeLabel();
      // This press was spent going to the hour, so the clock stays where it
      // landed rather than running straight past what was asked for.
      return false;
    },

    // Every simulation tick advances the street water: rain lands at the
    // current intensity and the water crawls downstream at street-flow speed.
    // Stepping is cheap; redrawing the polylines is not, so rendering is
    // throttled separately.
    onTick: (dtSeconds) => {
      // An open sample popup reads live, whether or not the street layer is on.
      refreshSamplePopup();

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
      roadFlow.dynamic.step((lat, lng) => rainfall.intensityAt(lat, lng), dtSeconds);
      pipeNet?.step(dtSeconds);
      updateDrainageReadout();

      if (!rainLayerActive) {
        return;
      }

      // Ponding is cheap to repaint (a few ms), so it follows the water on
      // its own short cadence rather than waiting for the street layer's
      // rebuild, which can be seconds behind under a big flood.
      const now = performance.now();
      if (map.hasLayer(pondingLayer) && now - lastPondingUpdate >= PONDING_MS) {
        lastPondingUpdate = now;
        pondingLayer.update?.();
      }
      // The Outcome slider follows the clock while the storm plays.
      showOutcomeLabel();

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
            recolorPipes();
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
      restorePipeStyles();
      pondingLayer.update?.();
      refreshSamplePopup();
      updateDrainageReadout();
      outcome?.invalidate();
      outcomeBar?.setComputed(0);
      outcomeBar?.follow(0);
      armedSeconds = null;
      showOutcomeStatus('');
      rainfall.stormTrack?.setPreview(false);
      rainfall.stormTrack?.setHorizon(TRACK_HORIZON_S);
      showOutcomeLabel();
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

  // --- the Outcome slider ------------------------------------------------------
  //
  // "What does it look like N hours in?" answered without playing N hours:
  // the first drag runs the whole scenario once in the background (a day in
  // about half a minute) and keeps a snapshot every half hour; after that
  // the slider is instant, and Play carries on from wherever it stands.
  const outcomeDom = {
    root: document.querySelector('#sim-outcome'),
    value: document.querySelector('#sim-outcome-value'),
    status: document.querySelector('#sim-outcome-status')
  };
  const hoursText = (seconds) => {
    const h = seconds / 3600;
    return `${h % 1 ? h.toFixed(1) : h} h`;
  };

  // The bar's caption: what the moment on it is - the live clock, a
  // precomputed outcome, or an invitation to compute one.
  function showOutcomeLabel() {
    if (!outcomeBar) {
      return;
    }
    // The bar belongs to placed storms; a forecast span has its own
    // timeline and drives the same grid.
    const forecastHolds = Boolean(forecastRain?.active);
    outcomeDom.root.classList.toggle('timeline--disabled', forecastHolds);
    if (forecastHolds) {
      outcomeDom.value.textContent = 'forecast span';
      return;
    }
    if (outcome?.computing) {
      outcomeDom.value.textContent = 'running the scenario…';
      return;
    }
    if (armedSeconds !== null) {
      outcomeDom.value.textContent = `${hoursText(armedSeconds)} · press Play`;
      return;
    }
    // The bar marks the hour that was picked and gone to; it deliberately
    // does NOT chase the clock. Running on from that hour is what the sim
    // time in the header reads, and a bar that crept along with it could
    // not be left parked anywhere.
    if (outcome?.ready) {
      outcomeDom.value.textContent = `${hoursText(outcome.shownSeconds)} · shown`;
      return;
    }
    outcomeDom.value.textContent = rainfall.stormSystem.storms.length
      ? 'drag to pick an hour'
      : 'place a storm';
  }

  function showOutcomeStatus(text) {
    outcomeDom.status.hidden = !text;
    outcomeDom.status.textContent = text || '';
  }

  outcome = createOutcomeTimeline({
    rainfall,
    streets: roadFlow.dynamic,
    pipes: pipeNet,
    seaLevelAt: (seconds) => tide.levelAt(rainfall.scenarioTimeAt(seconds)),
    onProgress: (doneSeconds, totalSeconds) => {
      outcomeBar?.setComputed(doneSeconds);
      showOutcomeStatus(
        doneSeconds < totalSeconds
          ? `Computing this scenario once: ${hoursText(doneSeconds)} of ${hoursText(totalSeconds)} done. The bar fills as it goes, and scrubbing is instant afterwards.`
          : ''
      );
      showOutcomeLabel();
    },
    onShown: (seconds) => {
      // The live models now hold the moment shown: repaint everything that
      // reads them.
      outcomeBar?.follow(seconds);
      if (rainLayerActive && map.hasLayer(roadFlow.layer)) {
        roadFlow.dynamic.render();
      }
      if (map.hasLayer(pondingLayer)) {
        pondingLayer.update?.();
      }
      if (map.hasLayer(drainagePipes.layer)) {
        recolorPipes();
      }
      updateDrainageReadout();
      refreshSamplePopup();
      scheduleRainFlowRefresh();
      showOutcomeLabel();
    }
  });

  outcomeBar = outcomeDom.root
    ? createOutcomeBar({
        root: outcomeDom.root,
        totalHours: outcome.totalSeconds / 3600,
        // The bar snaps to the spacing the scenario is snapshotted at, so
        // the hour picked is exactly the hour run to and shown.
        stepSeconds: outcome.snapshotEverySeconds,
        onScrub: async (seconds, { settled }) => {
          if (!roadFlow.dynamic) {
            return;
          }
          if (rainfall.stormSystem.storms.length === 0) {
            showOutcomeStatus('Place a storm first: the bar shows that storm’s outcome at any hour of the day.');
            return;
          }
          if (forecastRain?.active) {
            showOutcomeStatus('The Outcome bar is for placed storms; a forecast span has its own timeline.');
            return;
          }
          if (ensemble.running) {
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
          showOutcomeStatus(
            seconds > outcome.computedSeconds
              ? 'Press Play to run the storm to this hour and stop there.'
              : 'Press Play to go to this hour.'
          );
          showOutcomeLabel();
        }
      })
    : null;
  outcomeBar?.setComputed(0);
  showOutcomeLabel();

  // --- drainage readouts, surge slider and the ensemble -----------------------
  //
  // The panel tiles under the storm readouts: the sea level the outfalls
  // meet, the wind steering new storms, water held in the pipes, and water
  // the ground and generic drains have taken. Hover a tile for the detail.
  const drainDom = {
    sea: document.querySelector('#sim-sea'),
    wind: document.querySelector('#sim-wind'),
    drains: document.querySelector('#sim-drains'),
    absorbed: document.querySelector('#sim-absorbed'),
    surge: document.querySelector('#sim-surge'),
    surgeValue: document.querySelector('#sim-surge-value'),
    ensemble: document.querySelector('#sim-ensemble'),
    status: document.querySelector('#sim-ensemble-status')
  };
  const cubic = (value) => `${Math.round(value).toLocaleString()} m³`;

  function updateDrainageReadout() {
    const nowMs = rainfall.scenarioTimeMs;
    const level = tide.levelAt(nowMs);
    drainDom.sea.textContent = `${level >= 0 ? '+' : '−'}${Math.abs(level).toFixed(2)} m`;
    drainDom.sea.title =
      `Sea level at the outfalls, metres above mean sea level: ${tide.source}` +
      (tide.isSyntheticAt(nowMs) && tide.available ? ' (outside the forecast window: synthetic tide)' : '') +
      (tide.offsetM ? `, plus ${tide.offsetM.toFixed(1)} m surge` : '');

    const sample = wind.windAt(nowMs);
    if (sample) {
      drainDom.wind.textContent = `${(sample.speedMs * 3.6).toFixed(0)} km/h from ${Math.round(sample.directionDeg)}°`;
      const steer = wind.steeringVelocityAt(nowMs);
      drainDom.wind.title =
        `Surface wind, gusting ${(sample.gustMs * 3.6).toFixed(0)} km/h, ${sample.pressureHpa.toFixed(0)} hPa. ` +
        (steer
          ? `New storms drift towards ${Math.round(steer.bearingDeg)}° at ${steer.speedMs.toFixed(1)} m/s ` +
            `(${sample.steeringFromAloft ? '850 hPa' : 'scaled 10 m'} steering wind).`
          : '');
    } else {
      drainDom.wind.textContent = 'no data';
      drainDom.wind.title = 'Wind forecast unavailable; new storms start parked.';
    }

    if (pipeNet) {
      const t = pipeNet.totals();
      drainDom.drains.textContent = cubic(t.storedM3);
      drainDom.drains.title =
        `Water in the surveyed pipes now. ${t.surchargedNodes.toLocaleString()} manholes surcharged, ` +
        `${t.pumpsRunning} pump stations running (${cubic(t.pumpedM3)} pumped so far), ` +
        `${cubic(t.dischargedM3)} out through the outfalls, ${cubic(t.backflowM3)} in from the sea, ` +
        `${cubic(t.spilledM3)} spilled back onto the streets.`;
    } else {
      drainDom.drains.textContent = 'no model';
      drainDom.drains.title = 'Run `npm run build:drainage` to build the pipe network.';
    }

    const s = roadFlow.dynamic?.totals();
    if (s) {
      drainDom.absorbed.textContent = cubic(s.infiltratedM3 + s.drainedM3);
      drainDom.absorbed.title =
        `${cubic(s.infiltratedM3)} soaked into the ground, ${cubic(s.drainedM3)} down generic drains ` +
        `outside the surveyed network, ${cubic(s.capturedM3)} down the inlets, ` +
        `${cubic(s.dischargedM3)} out through ${s.seaOutfalls.toLocaleString()} sea and other street outfalls, ` +
        `${cubic(s.backflowM3)} in from the sea over the streets.`;
    }
  }

  drainDom.surge.value = String(config.tideSurgeM);
  const showSurge = () => {
    const value = Number(drainDom.surge.value);
    drainDom.surgeValue.textContent = `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} m`;
  };
  drainDom.surge.addEventListener('input', () => {
    tide.setOffset(Number(drainDom.surge.value));
    showSurge();
    updateDrainageReadout();
  });
  showSurge();
  updateDrainageReadout();

  // The ensemble replays the placed storms with jittered tracks and paints
  // how often each street floods. It runs on the same models, one member
  // at a time, so the button doubles as Cancel while it works.
  const ensemble = createEnsembleRunner({
    rainfall,
    streets: roadFlow.dynamic,
    pipes: pipeNet,
    seaLevelAt: (simSeconds) => tide.levelAt(rainfall.scenarioTimeAt(simSeconds)),
    onProgress: (done, total) => {
      drainDom.status.textContent = `Running ensemble: ${done} of ${total} members done…`;
    }
  });

  function showEnsembleStatus(text) {
    drainDom.status.hidden = !text;
    drainDom.status.textContent = text || '';
  }

  drainDom.ensemble.addEventListener('click', async () => {
    if (!roadFlow.dynamic) {
      return;
    }
    if (ensemble.running) {
      ensemble.cancel();
      return;
    }
    if (rainfall.stormSystem.storms.length === 0) {
      showEnsembleStatus('Place a storm first: the ensemble replays the placed storms with jittered tracks, speeds, sizes and intensities.');
      return;
    }

    // A forecast span would keep re-raining the grid underneath the runs.
    if (forecastRain?.active) {
      forecastRain.end();
    }
    rainfall.stop();
    drainDom.ensemble.textContent = 'Cancel';
    drainDom.ensemble.classList.add('sim-button--active');
    showEnsembleStatus('Running ensemble…');

    let result = null;
    try {
      result = await ensemble.run();
    } finally {
      drainDom.ensemble.textContent = 'Run ensemble';
      drainDom.ensemble.classList.remove('sim-button--active');
    }

    rainfall.render();
    updateDrainageReadout();
    if (!result) {
      showEnsembleStatus('Ensemble cancelled.');
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
    showEnsembleStatus(
      `${result.members} runs over ${hours % 1 ? hours.toFixed(1) : hours} h: ` +
        `${result.floodedJunctions.toLocaleString()} street points flood deeper than ` +
        `${Math.round(result.thresholdM * 100)} cm in at least one. Hover a street for its chance; Play or Reset clears it.`
    );
  });

  // --- rainfall-driven flow -------------------------------------------------
  //
  // Flow direction is fixed by terrain, but accumulation is water: while the
  // rainfall simulator layer is on, Flow Paths and Street Flow re-weight their
  // accumulation by the storm's rain, so they show where THIS storm's water
  // goes rather than the every-cell-equal terrain view. Refreshes are throttled
  // because they rebuild polylines across the network.
  function applyFlowWeighting() {
    const cellAreaM2 = flowPathOptions.cellAreaM2 || 1;
    const wantsPaths = map.hasLayer(flowPathLayer);
    const wantsAccumulation = map.hasLayer(flowAccumulationLayer);

    if (!rainLayerActive) {
      // Uniform restore for every grid layer, whether or not it is on show:
      // switching a restored layer on later must not reveal stale rain data.
      populateFlowPathLayer(flowPathLayer, visibleFlowDirection, visibleFlowAccumulation, {
        ...flowPathOptions,
        classic: flowPathsClassic
      });
      populateFlowAccumulationLayer(flowAccumulationLayer, visibleFlowAccumulation);

      if (roadFlow.refresh) {
        roadFlow.refresh(null);
        restorePipeStyles();
      }
      return;
    }

    // Street flow in rain mode is driven tick-by-tick by the dynamic water
    // model, not by this steady-state pass. The grid layers re-weight the
    // terrain accumulation by the storm's surface water, in mm, against an
    // ABSOLUTE threshold: a share of the total would divide out as everything
    // drains uniformly, and the network would never visibly dry.
    if (!wantsPaths && !wantsAccumulation) {
      return;
    }

    const weights = new Float64Array(flowDirection.length);
    let wetCount = 0;

    for (let position = 0; position < flowDirection.length; position += 1) {
      const [lat, lng] = flowDirection[position].center;
      const depth = rainfall.depthAt(lat, lng);
      if (depth > 0) {
        weights[position] = depth;
        wetCount += 1;
      }
    }

    if (wetCount === 0) {
      if (wantsPaths) {
        flowPathLayer.clearLayers();
      }
      if (wantsAccumulation) {
        flowAccumulationLayer.clearLayers();
      }
      return;
    }

    const weighted = calculateFlowAccumulation(flowDirection, weights);
    const visibleWeighted = weighted.filter(isInsideAnalysis);
    // The threshold is water volume; accumulation carries mm summed over
    // cells, so convert: mm x m2 / 1000 = m3. Forecast rain is light and
    // falls everywhere, so a cut tuned for a cloudburst left nothing drawn:
    // it keeps the uniform view's share of cells instead, floored at a cubic
    // metre so bone-dry ground stays blank, and the rain shapes the network.
    const minUpstream = forecastRain?.active
      ? Math.max(1000 / cellAreaM2, drainageCutoff(visibleWeighted, config.flowNetworkPercentile))
      : (config.flowRainMinM3 * 1000) / cellAreaM2;

    if (wantsPaths) {
      populateFlowPathLayer(flowPathLayer, visibleFlowDirection, visibleWeighted, {
        ...flowPathOptions,
        minUpstream,
        rainMode: true,
        classic: flowPathsClassic
      });
    }

    if (wantsAccumulation) {
      populateFlowAccumulationLayer(flowAccumulationLayer, visibleWeighted, {
        rainMode: true,
        cellAreaM2,
        minValue: minUpstream
      });
    }
  }

  function scheduleRainFlowRefresh() {
    // Forecast rain refreshes the flow layers on its own cadence.
    if (!rainLayerActive || rainRefreshTimer || forecastRain?.active) {
      return;
    }

    const wait = Math.max(0, RAIN_FLOW_REFRESH_MS - (Date.now() - lastRainRefresh));
    rainRefreshTimer = setTimeout(() => {
      rainRefreshTimer = null;
      lastRainRefresh = Date.now();
      applyFlowWeighting();
    }, wait);
  }

  // --- forecast rain: Shift + drag on the forecast timeline -----------------
  //
  // The forecast card marks a span; the driver rains the active forecast
  // onto the simulator's grid through it, and the three flow layers follow
  // the surface water the way they follow a storm's.
  //
  // Street Flow under forecast rain is that water routed along the streets,
  // the way Flow Paths are re-weighted - not the ponding model, which drains
  // anything short of a cloudburst before it can move and so showed nothing
  // for a real forecast.
  function refreshForecastStreets() {
    if (!roadFlow.refresh || !map.hasLayer(roadFlow.layer)) {
      return;
    }

    if (forecastRain?.active) {
      roadFlow.refresh((lat, lng) => rainfall.depthAt(lat, lng));
    } else if (rainLayerActive) {
      roadFlow.dynamic?.render();
    } else {
      roadFlow.refresh(null);
    }
  }

  forecastRain = createForecastRainDriver({
    rainfall,
    // The simulator's speed slider paces this the way it paces the storm
    // clock, so one control drives both halves of the card.
    playHoursPerSecond: () =>
      config.forecastPlayHoursPerSecond * rainfall.speedMultiplier ** FORECAST_SPEED_CURVE,
    refreshLayers: () => {
      applyFlowWeighting();
      refreshForecastStreets();
      refreshSamplePopup();
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

    if (event.layer === rainfall.layer) {
      rainLayerActive = true;
      applyFlowWeighting();
      roadFlow.dynamic?.render();
      forecast.card.refreshHint();
    } else if (
      rainLayerActive &&
      (event.layer === flowPathLayer || event.layer === flowAccumulationLayer)
    ) {
      // Switched on while rain mode is active: rebuild rather than show stale.
      applyFlowWeighting();
    } else if (event.layer === flowPathLayer) {
      // Repopulate in the just-chosen style.
      populateFlowPathLayer(flowPathLayer, visibleFlowDirection, visibleFlowAccumulation, {
        ...flowPathOptions,
        classic: flowPathsClassic
      });
    } else if (event.layer === roadFlow.layer) {
      // Rebuild in the just-chosen style; in rain mode with live water.
      refreshForecastStreets();
    }
  });

  map.on('overlayremove', (event) => {
    if (event.layer === rainfall.layer) {
      rainLayerActive = false;
      // A forecast span cannot outlive the grid it rains onto.
      forecastRain.end();
      if (rainRefreshTimer) {
        clearTimeout(rainRefreshTimer);
        rainRefreshTimer = null;
      }
      if (streetRenderTimer) {
        clearTimeout(streetRenderTimer);
        streetRenderTimer = null;
      }
      applyFlowWeighting();
      forecast.card.refreshHint();
    }
  });

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
      [forecast.openMeteo.available
        ? forecast.openMeteo.label
        : wipLabel(forecast.openMeteo.label)]: forecast.openMeteo.layer,
      // TMD arrives a minute or so after load; the label reflects whether it
      // can arrive at all, which is what a token decides.
      [config.tmdToken ? forecast.tmd.label : wipLabel(`${forecast.tmd.label} - no token`)]:
        forecast.tmd.layer,
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
  labelLayerControl(weatherControl, 'Weather');

  map.on('mousemove', (event) => {
    mouseCoordinates.update(event.latlng);
  });

  // Leaflet closes popups when a new one opens, but allows one tooltip per
  // layer to stay open at once. With elevation, contours, rivers and flow
  // arrows stacked, that leaves several readouts on screen together.
  let openTooltip = null;
  map.on('tooltipopen', (event) => {
    if (openTooltip && openTooltip !== event.tooltip) {
      map.closeTooltip(openTooltip);
    }

    openTooltip = event.tooltip;
  });

  map.on('tooltipclose', (event) => {
    if (openTooltip === event.tooltip) {
      openTooltip = null;
    }
  });

  // The open sample popup keeps its position and its terrain readings; the
  // water figures are recomputed on every tick, so an open popup reads live
  // instead of freezing at whatever the values were when it was clicked.
  function samplePointContent() {
    const { lat, lng, elevationText, flowText } = samplePoint;
    const lines = [
      '<strong>Sample point</strong>',
      `Elevation: ${elevationText}`,
      `Flow: ${flowText}`
    ];

    // Water here right now: rain falling, surface water on the ground grid,
    // and the deepest flooded street within ~60 m - so nobody has to hover a
    // thin line to read a depth.
    const intensity = rainfall.intensityAt(lat, lng);
    const surfaceMm = rainfall.depthAt(lat, lng);
    lines.push(`Rain here: ${intensity.toFixed(1)} mm/h`);
    lines.push(`Water on ground: ${surfaceMm.toFixed(1)} mm`);

    // Forecast rain is routed along the streets, not ponded, so there is no
    // standing depth to read.
    const street = forecastRain?.active ? null : roadFlow.dynamic?.depthNear(lat, lng, 60);
    if (street) {
      const here = Math.round(street.distanceM) <= 20 ? '' : ` (${Math.round(street.distanceM)} m away)`;
      lines.push(
        `Street water: ~${(street.depthM * 100).toFixed(0)} cm, ${street.severity}${here}`
      );

      // Only worth a second line when it is a different, meaningfully worse
      // spot - otherwise it just repeats the line above.
      const worst = street.deepest;
      if (worst && worst.depthM > street.depthM + 0.05) {
        lines.push(
          `Deepest within 60 m: ~${(worst.depthM * 100).toFixed(0)} cm, ` +
            `${Math.round(worst.distanceM)} m away`
        );
      }

      if (street.flowM3s > 0.05) {
        lines.push(`Street flow: ~${street.flowM3s.toFixed(1)} m³/s`);
      }
    } else if (forecastRain?.active) {
      lines.push('Street water: forecast rain runs along the streets (see Street Flow)');
    } else {
      lines.push('Street water: none within 60 m');
    }

    // The nearest manhole of the surveyed network, and how full it stands.
    const drain = pipeNet?.nearestNode(lat, lng, 80);
    if (drain) {
      const what = drain.pump ? 'pump station' : drain.kind === NODE_SEA_OUTFALL ? 'sea outfall' : 'drain';
      const state = drain.surcharged
        ? 'surcharged'
        : drain.fill > 0.005
          ? `${Math.round(drain.fill * 100)}% full`
          : 'dry';
      lines.push(
        `Nearest ${what}: ${drain.sizeText ? `${drain.sizeText}, ` : ''}${state}` +
          `${drain.pumpRunning ? ', pumping' : ''} (${Math.round(drain.distanceM)} m away)`
      );
    }

    return lines.join('<br />');
  }

  function refreshSamplePopup() {
    if (samplePoint?.popup && map.hasLayer(samplePoint.popup)) {
      samplePoint.popup.setContent(samplePointContent());
    }
  }

  map.on('popupclose', (event) => {
    if (samplePoint?.popup === event.popup) {
      samplePoint = null;
    }
  });

  map.on('click', async (event) => {
    // Clicking to drop a storm cell must not also open the sample popup, and
    // neither must a click that just opened a drainage cover's popup.
    if (rainfall.isPlacingStorm() || event.originalEvent?.coverPopupOpened) {
      return;
    }

    const { lat, lng } = event.latlng;
    const elevationMeters = await getElevationAt(lat, lng);
    // The covers layer's handler runs after this one but before the await
    // resolves, so its flag has to be checked again here.
    if (event.originalEvent?.coverPopupOpened) {
      return;
    }

    samplePoint = {
      lat,
      lng,
      elevationText: Number.isFinite(elevationMeters) ? `${elevationMeters} m` : 'N/A',
      flowText: inferFlowText(lat, lng),
      popup: L.popup()
    };

    samplePoint.popup.setLatLng(event.latlng).setContent(samplePointContent()).openOn(map);
  });

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
      outcome,
      pondingLayer,
      drainagePipes,
      drainageCovers
    };
  }

  return map;
}

// Each control otherwise sizes to its own longest label, so the two stacked
// groups end up different widths. Measure both once laid out and take the wider.
function matchLayerControlWidths() {
  requestAnimationFrame(() => {
    const controls = [...document.querySelectorAll('.leaflet-control-layers')];
    if (controls.length < 2) {
      return;
    }

    for (const control of controls) {
      control.style.width = '';
    }

    const widest = Math.max(...controls.map((control) => control.offsetWidth));
    for (const control of controls) {
      control.style.width = `${widest}px`;
    }
  });
}

// Leaflet renders layer names as HTML, so a placeholder layer can be marked
// with a class instead of a "(Placeholder)" suffix.
// Analysis cells are rectangles in degrees; convert one to square metres so the
// flow tooltip can report a real catchment area.
// Extent of the street graph, for telling the simulator where street water
// can be tracked. Null when no network loaded.
function streetGraphBounds(graph) {
  if (!graph?.nodeCount) {
    return null;
  }

  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;

  for (let n = 0; n < graph.nodeCount; n += 1) {
    const lat = graph.lat[n];
    const lng = graph.lng[n];
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }

  return { south, north, west, east };
}

function analysisCellAreaM2(grid) {
  if (!grid?.bounds) {
    return 0;
  }

  const { bounds, rows, columns } = grid;
  const meanLat = (bounds.north + bounds.south) / 2;
  const widthM = ((bounds.east - bounds.west) / columns) * 111320 * Math.cos((meanLat * Math.PI) / 180);
  const heightM = ((bounds.north - bounds.south) / rows) * 110574;
  return widthM * heightM;
}

function placeholderLabel(text) {
  return `<span class="layer-placeholder">${text}</span>`;
}

// Yellow marks a layer that carries real data but is still being worked on,
// as opposed to red, which marks demo geometry.
function wipLabel(text) {
  return `<span class="layer-wip">${text}</span>`;
}

// Leaflet's layer control has no concept of groups, so two controls are
// stacked and each gets a title injected above its list.
function labelLayerControl(control, title) {
  const container = control.getContainer();
  const heading = L.DomUtil.create('div', 'layer-control-title');
  heading.textContent = title;
  container.insertBefore(heading, container.firstChild);
}

// The three flow layers have a classic rendering (dashes, or arrows for Flow
// Direction) behind Shift + tick; say so on hover, or nobody would find it.
function hintClassicToggle(control, layers) {
  const ids = new Set(layers.map((layer) => L.Util.stamp(layer)));
  for (const input of control._layerControlInputs || []) {
    if (ids.has(input.layerId)) {
      input.parentElement.title = 'Shift + click for the classic style';
    }
  }
}

// Say on hover that a layer only draws once zoomed in, so switching it on at a
// city-wide view does not read as a broken toggle (the covers are 80k markers,
// hidden until a street-level zoom).
function hintLayerToggle(control, layer, text) {
  const id = L.Util.stamp(layer);
  for (const input of control._layerControlInputs || []) {
    if (input.layerId === id) {
      // The whole row is a <label>; put the hover text there, not on the
      // inner wrapper, so it shows over the name as well as the checkbox.
      (input.closest('label') || input.parentElement).title = text;
    }
  }
}

function createElevationLayer(dem, slope, displayMask) {
  const slopeById = new Map(slope.map((item) => [item.id, item.slopePercent]));
  const minElevation = dem.minElevationMeters ?? 0;
  const maxElevation = dem.maxElevationMeters ?? 200;
  const isInside = createMaskTest(dem.grid || dem, displayMask);

  const polygons = dem.cells.filter(isInside).map((cell) =>
    L.polygon(cell.polygon, {
      color: '#7c3aed',
      weight: 1,
      fillColor: getElevationColor(cell.elevation, minElevation, maxElevation),
      fillOpacity: 0.28
    }).bindTooltip(
      `Elevation: ${cell.elevation} m<br>Slope: ${slopeById.get(cell.id)}%`,
      { sticky: true }
    )
  );

  return L.layerGroup(polygons);
}

function createContourLayer(contourLines, boundaryFeature) {
  const clippedLines = contourLines.flatMap((line) =>
    clipContourLineToBoundary(line, boundaryFeature)
  );
  const contourPaths = clippedLines.map((segment) =>
    L.polyline(segment.points, {
      color: '#5b3a29',
      weight: 1.15,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }).bindTooltip(`${segment.level} m contour`, {
      sticky: true
    })
  );
  const contourLabels = createContourLabels(clippedLines);

  return L.layerGroup([...contourPaths, ...contourLabels]);
}

function createContourLabels(contourLines) {
  const labelsByLevel = new Map();

  return contourLines
    .filter((line) => line.points.length >= 8 && getPolylineLength(line.points) > 0.025)
    .filter((line) => {
      const labelCount = labelsByLevel.get(line.level) || 0;
      if (labelCount >= 8) {
        return false;
      }

      labelsByLevel.set(line.level, labelCount + 1);
      return true;
    })
    .map((line) => {
      const { point, angle } = getContourLabelPlacement(line.points);

      return L.marker(point, {
        interactive: false,
        icon: L.divIcon({
          className: 'contour-label',
          html: `<span style="--angle: ${angle}deg">${line.level}</span>`,
          iconSize: [34, 16],
          iconAnchor: [17, 8]
        })
      });
    });
}

function getContourLabelPlacement(points) {
  const totalLength = getPolylineLength(points);
  const targetLength = totalLength / 2;
  let travelled = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const segmentLength = getPointDistance(start, end);

    if (travelled + segmentLength >= targetLength) {
      const ratio = segmentLength === 0 ? 0 : (targetLength - travelled) / segmentLength;
      const point = [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio
      ];
      const dx = end[1] - start[1];
      const dy = end[0] - start[0];

      return {
        point,
        angle: normalizeLabelAngle(Math.atan2(dy, dx) * (180 / Math.PI))
      };
    }

    travelled += segmentLength;
  }

  return {
    point: points[Math.floor(points.length / 2)],
    angle: 0
  };
}

function getPolylineLength(points) {
  let length = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    length += getPointDistance(points[index], points[index + 1]);
  }

  return length;
}

function getPointDistance(start, end) {
  return Math.hypot(end[0] - start[0], end[1] - start[1]);
}

function normalizeLabelAngle(angle) {
  let normalized = angle;

  if (normalized > 90) {
    normalized -= 180;
  }

  if (normalized < -90) {
    normalized += 180;
  }

  return Number(normalized.toFixed(1));
}

function clipContourLineToBoundary(line, boundaryFeature) {
  const clippedLines = [];
  let activePoints = [];

  for (let index = 0; index < line.points.length - 1; index += 1) {
    const segment = {
      points: [line.points[index], line.points[index + 1]]
    };

    if (isContourSegmentInsideBoundary(segment, boundaryFeature)) {
      if (activePoints.length === 0) {
        activePoints.push(...segment.points);
      } else {
        activePoints.push(segment.points[1]);
      }
    } else if (activePoints.length > 1) {
      clippedLines.push({ level: line.level, points: activePoints });
      activePoints = [];
    } else {
      activePoints = [];
    }
  }

  if (activePoints.length > 1) {
    clippedLines.push({ level: line.level, points: activePoints });
  }

  return clippedLines;
}

// Reserved for the rain-simulation side panel. Rain is a scenario you drive,
// not a static overlay, so it is no longer registered in the layer control.
function createRainfallLayer() {
  const zones = [
    {
      label: 'Low rainfall demo zone',
      center: [12.92, 101.0],
      radius: 18000,
      color: '#60a5fa'
    },
    {
      label: 'Medium rainfall demo zone',
      center: [13.16, 101.2],
      radius: 22000,
      color: '#3b82f6'
    },
    {
      label: 'High rainfall demo zone',
      center: [13.32, 101.44],
      radius: 26000,
      color: '#1d4ed8'
    }
  ];

  return L.layerGroup(
    zones.map((zone) =>
      L.circle(zone.center, {
        radius: zone.radius,
        color: zone.color,
        weight: 1,
        fillColor: zone.color,
        fillOpacity: 0.16
      }).bindTooltip(zone.label)
    )
  );
}

function createMouseCoordinatesControl() {
  const control = L.control({ position: 'bottomleft' });

  control.onAdd = () => {
    const container = L.DomUtil.create('div', 'mouse-coordinates');
    container.textContent = 'Lat: --, Lng: --';
    return container;
  };

  control.update = (latlng) => {
    control.getContainer().textContent = `Lat: ${latlng.lat.toFixed(5)}, Lng: ${latlng.lng.toFixed(5)}`;
  };

  return control;
}

function getElevationColor(elevation, minElevation, maxElevation) {
  const range = Math.max(1, maxElevation - minElevation);
  const normalized = (elevation - minElevation) / range;

  if (normalized < 0.2) return '#d9f99d';
  if (normalized < 0.4) return '#86efac';
  if (normalized < 0.6) return '#4ade80';
  if (normalized < 0.8) return '#22c55e';
  return '#15803d';
}

function inferFlowText(lat, lng) {
  if (lat > 13.25 && lng > 101.3) {
    return 'Southwest drainage tendency';
  }

  if (lat > 13.05) {
    return 'Southward drainage tendency';
  }

  return 'Southeast drainage tendency';
}

function isContourSegmentInsideBoundary(segment, boundaryFeature) {
  const [start, end] = segment.points;
  const midpoint = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2
  ];

  return isPointInsideFeature(midpoint, boundaryFeature);
}

function isPointInsideFeature(point, feature) {
  if (feature?.type === 'FeatureCollection') {
    return feature.features.some((item) => isPointInsideFeature(point, item));
  }

  if (!feature?.geometry) {
    return false;
  }

  if (feature.geometry.type === 'Polygon') {
    return isPointInsidePolygon(point, feature.geometry.coordinates);
  }

  if (feature.geometry.type === 'MultiPolygon') {
    return feature.geometry.coordinates.some((polygon) => isPointInsidePolygon(point, polygon));
  }

  return false;
}

function isPointInsidePolygon(point, polygonCoordinates) {
  const [lat, lng] = point;
  const exteriorRing = polygonCoordinates[0] || [];

  if (!isPointInsideRing(lat, lng, exteriorRing)) {
    return false;
  }

  for (let index = 1; index < polygonCoordinates.length; index += 1) {
    if (isPointInsideRing(lat, lng, polygonCoordinates[index])) {
      return false;
    }
  }

  return true;
}

function isPointInsideRing(lat, lng, ring) {
  let inside = false;

  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [currentLng, currentLat] = ring[current];
    const [previousLng, previousLat] = ring[previous];
    const intersects =
      currentLat > lat !== previousLat > lat &&
      lng <
        ((previousLng - currentLng) * (lat - currentLat)) / (previousLat - currentLat) +
          currentLng;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}
