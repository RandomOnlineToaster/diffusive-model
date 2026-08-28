import L from 'leaflet';
import { createMaskTest } from './boundary.js';

// The DEM as coloured squares, one per cell inside the province, each with
// its height and slope on hover.

export function createElevationLayer(dem, slope, displayMask) {
  const slopeById = new Map(slope.map((item) => [item.id, item.slopePercent]));
  const minElevation = dem.minElevationMeters ?? 0;
  const maxElevation = dem.maxElevationMeters ?? 200;
  const isInside = createMaskTest(dem.grid || dem, displayMask);

  const polygons = dem.cells.filter(isInside).map((cell) =>
    L.polygon(cell.polygon, {
      color: '#7c3aed',
      weight: 1,
      fillColor: elevationColor(cell.elevation, minElevation, maxElevation),
      fillOpacity: 0.28
    }).bindTooltip(`Elevation: ${cell.elevation} m<br>Slope: ${slopeById.get(cell.id)}%`, { sticky: true })
  );

  return L.layerGroup(polygons);
}

function elevationColor(elevation, minElevation, maxElevation) {
  const range = Math.max(1, maxElevation - minElevation);
  const normalized = (elevation - minElevation) / range;

  if (normalized < 0.2) return '#d9f99d';
  if (normalized < 0.4) return '#86efac';
  if (normalized < 0.6) return '#4ade80';
  if (normalized < 0.8) return '#22c55e';
  return '#15803d';
}
