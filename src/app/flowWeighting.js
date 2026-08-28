import { config } from '../config.js';
import { calculateFlowAccumulation } from '../terrain/terrain.js';
import { drainageCutoff, populateFlowAccumulationLayer, populateFlowPathLayer } from '../terrain/flow.js';

// Rain-driven flow. Flow direction is fixed by terrain, but accumulation is
// water: while the rainfall simulator layer is on, Flow Paths and Catchment
// re-weight their accumulation by the storm's rain, so they show where THIS
// storm's water goes rather than the every-cell-equal terrain view. Refreshes
// are throttled because they rebuild polylines across the network.

const RAIN_FLOW_REFRESH_MS = 2000;

/**
 * @param grid    { flowDirection, visibleFlowDirection, visibleFlowAccumulation, isInsideAnalysis, cellAreaM2 }
 * @param layers  { flowPathLayer, flowAccumulationLayer }
 * @param state   getters: isRainActive(), isForecastActive(), isPathsClassic()
 */
export function createFlowWeighting({ map, rainfall, roadFlow, grid, layers, state, restorePipes }) {
  const { flowDirection, visibleFlowDirection, visibleFlowAccumulation, isInsideAnalysis } = grid;
  const { flowPathLayer, flowAccumulationLayer } = layers;
  const pathOptions = { cellAreaM2: grid.cellAreaM2 };
  let refreshTimer = null;
  let lastRefresh = 0;

  function apply() {
    const cellAreaM2 = pathOptions.cellAreaM2 || 1;
    const wantsPaths = map.hasLayer(flowPathLayer);
    const wantsAccumulation = map.hasLayer(flowAccumulationLayer);

    if (!state.isRainActive()) {
      // Uniform restore for every grid layer, whether or not it is on show:
      // switching a restored layer on later must not reveal stale rain data.
      populateFlowPathLayer(flowPathLayer, visibleFlowDirection, visibleFlowAccumulation, {
        ...pathOptions,
        classic: state.isPathsClassic()
      });
      populateFlowAccumulationLayer(flowAccumulationLayer, visibleFlowAccumulation);

      if (roadFlow.refresh) {
        roadFlow.refresh(null);
        restorePipes();
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
    const minUpstream = state.isForecastActive()
      ? Math.max(1000 / cellAreaM2, drainageCutoff(visibleWeighted, config.flowNetworkPercentile))
      : (config.flowRainMinM3 * 1000) / cellAreaM2;

    if (wantsPaths) {
      populateFlowPathLayer(flowPathLayer, visibleFlowDirection, visibleWeighted, {
        ...pathOptions,
        minUpstream,
        rainMode: true,
        classic: state.isPathsClassic()
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

  /** Throttled apply(), for the water-added events a storm fires. */
  function schedule() {
    // Forecast rain refreshes the flow layers on its own cadence.
    if (!state.isRainActive() || refreshTimer || state.isForecastActive()) {
      return;
    }

    const wait = Math.max(0, RAIN_FLOW_REFRESH_MS - (Date.now() - lastRefresh));
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      lastRefresh = Date.now();
      apply();
    }, wait);
  }

  function cancel() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  /**
   * Street Flow in the current mode: under forecast rain that water routed
   * along the streets (the way Flow Paths are re-weighted), under a storm the
   * live ponding model, otherwise the terrain baseline.
   */
  function refreshStreets() {
    if (!roadFlow.refresh || !map.hasLayer(roadFlow.layer)) {
      return;
    }

    if (state.isForecastActive()) {
      roadFlow.refresh((lat, lng) => rainfall.depthAt(lat, lng));
    } else if (state.isRainActive()) {
      roadFlow.dynamic?.render();
    } else {
      roadFlow.refresh(null);
    }
  }

  /** Repopulate Flow Paths in the just-chosen style, outside rain mode. */
  function repopulatePaths() {
    populateFlowPathLayer(flowPathLayer, visibleFlowDirection, visibleFlowAccumulation, {
      ...pathOptions,
      classic: state.isPathsClassic()
    });
  }

  return { apply, schedule, cancel, refreshStreets, repopulatePaths };
}
