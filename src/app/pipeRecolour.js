// Recolour each surveyed drain run by how full it is while it rains, and put
// the survey colours back afterwards.

const PIPE_FILL_COLORS = ['#60a5fa', '#22c55e', '#eab308', '#f97316', '#dc2626'];

/**
 * @param pipeNet        the running pipe network, or null
 * @param drainagePipes  the Drainage Pipes layer bundle (featureLayers, baseStyle)
 */
export function createPipeRecolour({ pipeNet, drainagePipes }) {
  let recoloured = false;

  function recolour() {
    if (!pipeNet || !drainagePipes.featureLayers) {
      return;
    }

    const fills = pipeNet.fillByFeature();
    for (const [id, featureLayer] of drainagePipes.featureLayers) {
      const fraction = fills[id];
      if (!(fraction > 0.02)) {
        if (recoloured) {
          featureLayer.setStyle(drainagePipes.baseStyle(featureLayer.feature));
        }
        continue;
      }
      const cls = Math.min(PIPE_FILL_COLORS.length - 1, Math.floor(fraction * PIPE_FILL_COLORS.length));
      featureLayer.setStyle({ color: PIPE_FILL_COLORS[cls] });
    }
    recoloured = true;
  }

  function restore() {
    if (!recoloured || !drainagePipes.featureLayers) {
      return;
    }

    for (const featureLayer of drainagePipes.featureLayers.values()) {
      featureLayer.setStyle(drainagePipes.baseStyle(featureLayer.feature));
    }
    recoloured = false;
  }

  return { recolour, restore };
}
