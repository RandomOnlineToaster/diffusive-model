// Turns the Chon Buri polygon into a per-cell inside/outside mask for a grid.
//
// Testing every cell against the polygon would be O(cells x vertices): the
// 512x512 analysis grid against 13,510 boundary vertices is ~3.5 billion
// operations. Scanline rasterisation is O(rows x vertices) instead, because
// each grid row is solved once and filled as spans.
//
// Rings are combined with the even-odd rule, so holes and multi-part polygons
// (Chon Buri's islands) fall out of the same pass.

export function createBoundaryMask(grid, feature) {
  const { rows, columns, bounds } = grid;
  const mask = new Uint8Array(rows * columns);
  const rings = collectRings(feature);

  if (rings.length === 0) {
    return mask.fill(1);
  }

  const latStep = (bounds.north - bounds.south) / rows;
  const lngStep = (bounds.east - bounds.west) / columns;
  const crossings = [];

  for (let row = 0; row < rows; row += 1) {
    // Sample at the cell centre, matching how the cells are drawn.
    const lat = bounds.north - (row + 0.5) * latStep;
    crossings.length = 0;

    for (const ring of rings) {
      for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
        const [currentLng, currentLat] = ring[current];
        const [previousLng, previousLat] = ring[previous];

        if (currentLat > lat === previousLat > lat) {
          continue;
        }

        const ratio = (lat - currentLat) / (previousLat - currentLat);
        crossings.push(currentLng + ratio * (previousLng - currentLng));
      }
    }

    if (crossings.length < 2) {
      continue;
    }

    crossings.sort((a, b) => a - b);

    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const startColumn = Math.max(
        0,
        Math.ceil((crossings[pair] - bounds.west) / lngStep - 0.5)
      );
      const endColumn = Math.min(
        columns - 1,
        Math.floor((crossings[pair + 1] - bounds.west) / lngStep - 0.5)
      );

      for (let column = startColumn; column <= endColumn; column += 1) {
        mask[row * columns + column] = 1;
      }
    }
  }

  return mask;
}

export function createMaskTest(grid, mask) {
  if (!mask) {
    return () => true;
  }

  // The placeholder DEM has hand-placed cells with no grid position. They
  // cannot be masked, so let them through rather than drawing nothing at all.
  return (item) =>
    Number.isInteger(item.row) && Number.isInteger(item.column)
      ? mask[item.row * grid.columns + item.column] === 1
      : true;
}

function collectRings(feature) {
  if (!feature) {
    return [];
  }

  if (feature.type === 'FeatureCollection') {
    return feature.features.flatMap((item) => collectRings(item));
  }

  const geometry = feature.geometry || feature;

  if (geometry.type === 'Polygon') {
    return geometry.coordinates;
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flat();
  }

  return [];
}

// Point-in-polygon for arbitrary coordinates, backed by the same scanline mask.
//
// Testing 85k river vertices directly against 13,510 boundary vertices would be
// over a billion operations. Rasterising the polygon once and then doing array
// lookups turns each test into O(1). Resolution is the mask's grid size, so
// 1024 over Chon Buri is roughly 100 m precision, which is plenty for deciding
// whether a line belongs to the province.
export function createPointInsideTest(feature, resolution = 1024) {
  const bounds = boundsOfFeature(feature);

  if (!bounds) {
    return () => true;
  }

  const grid = { rows: resolution, columns: resolution, bounds };
  const mask = createBoundaryMask(grid, feature);
  const latSpan = bounds.north - bounds.south;
  const lngSpan = bounds.east - bounds.west;

  return (lat, lng) => {
    const row = Math.floor(((bounds.north - lat) / latSpan) * resolution);
    const column = Math.floor(((lng - bounds.west) / lngSpan) * resolution);

    if (row < 0 || column < 0 || row >= resolution || column >= resolution) {
      return false;
    }

    return mask[row * resolution + column] === 1;
  };
}

function boundsOfFeature(feature) {
  const rings = collectRings(feature);
  if (rings.length === 0) {
    return null;
  }

  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }

  return { west, east, south, north };
}

// Grows a mask outward by a number of cells.
//
// Flow is routed across the whole DEM rectangle so cross-border catchments stay
// intact, but drawing every cell of that rectangle spreads the arrows thin and
// costs render time. A small buffer keeps just enough context to see where water
// leaves the province.
export function dilateMask(mask, columns, rows, cells) {
  if (!mask || cells <= 0) {
    return mask;
  }

  let current = mask;

  for (let pass = 0; pass < cells; pass += 1) {
    const next = new Uint8Array(current);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (current[row * columns + column] !== 1) {
          continue;
        }

        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
            const neighborRow = row + rowOffset;
            const neighborColumn = column + columnOffset;

            if (
              neighborRow < 0 ||
              neighborColumn < 0 ||
              neighborRow >= rows ||
              neighborColumn >= columns
            ) {
              continue;
            }

            next[neighborRow * columns + neighborColumn] = 1;
          }
        }
      }
    }

    current = next;
  }

  return current;
}
