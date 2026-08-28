// Extents and cell sizes the wiring needs from the models' grids.

/**
 * Extent of the street graph, for telling the simulator where street water
 * can be tracked. Null when no network loaded.
 */
export function streetGraphBounds(graph) {
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

/**
 * Analysis cells are rectangles in degrees; one converted to square metres,
 * so the flow tooltip can report a real catchment area.
 */
export function analysisCellAreaM2(grid) {
  if (!grid?.bounds) {
    return 0;
  }

  const { bounds, rows, columns } = grid;
  const meanLat = (bounds.north + bounds.south) / 2;
  const widthM = ((bounds.east - bounds.west) / columns) * 111320 * Math.cos((meanLat * Math.PI) / 180);
  const heightM = ((bounds.north - bounds.south) / rows) * 110574;
  return widthM * heightM;
}
