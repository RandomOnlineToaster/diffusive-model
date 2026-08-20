import { fromUrl } from 'geotiff';
import { config } from './config.js';

const CHON_BURI_BOUNDS = {
  west: 100.85,
  east: 101.72,
  south: 12.6,
  north: 13.6
};

// The dashboard preview stays small because every cell becomes an interactive
// Leaflet polygon. Slope and flow run on dem.analysisGrid instead, whose size
// comes from DEM_ANALYSIS_GRID in .env.local and is baked into the DEM cache.
const PREVIEW_GRID_COLUMNS = 24;
const PREVIEW_GRID_ROWS = 24;
const CONTOUR_GRID_COLUMNS = 256;
const CONTOUR_GRID_ROWS = 256;

let activeDEMContext = {
  source: 'placeholder',
  bounds: CHON_BURI_BOUNDS,
  minElevationMeters: 12,
  maxElevationMeters: 255,
  sampleElevationAt: placeholderSampleElevationAt
};

export async function loadDEM() {
  const localDEM = await loadLocalDEMManifest();
  if (localDEM) {
    try {
      const cachedDEM = await loadCachedDEM(localDEM);
      const rasterDEM = cachedDEM || (await loadRasterDEM(localDEM));

      activeDEMContext = {
        source: rasterDEM.source,
        bounds: rasterDEM.bounds,
        minElevationMeters: rasterDEM.minElevationMeters,
        maxElevationMeters: rasterDEM.maxElevationMeters,
        sampleElevationAt: rasterDEM.sampleElevationAt
      };

      return rasterDEM;
    } catch (error) {
      console.warn('Falling back to placeholder DEM:', error);
    }
  }

  activeDEMContext = {
    source: 'placeholder',
    bounds: CHON_BURI_BOUNDS,
    minElevationMeters: 12,
    maxElevationMeters: 255,
    sampleElevationAt: placeholderSampleElevationAt
  };

  return {
    source: 'placeholder',
    resolutionMeters: 500,
    bounds: CHON_BURI_BOUNDS,
    cells: createPlaceholderElevationCells(),
    grid: createPlaceholderGrid()
  };
}

export function calculateSlope(dem) {
  const analysisGrid = getAnalysisGrid(dem);

  if (analysisGrid) {
    // Slope is derived at analysis resolution, then averaged back onto the
    // coarse display squares so the tooltip reflects the block, not one pixel.
    const slopeByIndex = calculateSlopeGrid(analysisGrid);
    return averageOntoDisplayCells(dem, analysisGrid, slopeByIndex, 'slopePercent');
  }

  return dem.cells.map((cell) => ({
    ...cell,
    slopePercent: Number((cell.elevation / 12).toFixed(1))
  }));
}

export function calculateFlowDirection(dem) {
  const analysisGrid = getAnalysisGrid(dem);

  if (analysisGrid) {
    return calculateGridFlowDirection(analysisGrid);
  }

  const directions = ['E', 'SE', 'S', 'SW'];

  return dem.cells.map((cell, index) => ({
    id: cell.id,
    center: cell.center,
    direction: directions[index % directions.length]
  }));
}

// weights, when given, is one value per flowDirection entry: how much water
// that cell itself contributes before drainage. Uniform terrain analysis uses
// 1 per cell; rainfall-driven analysis uses the storm's rain depth, so cells
// outside the rain contribute nothing and the network shows only storm water.
export function calculateFlowAccumulation(flowDirection, weights = null) {
  if (flowDirection.every((item) => 'downstreamId' in item)) {
    return calculateGridFlowAccumulation(flowDirection, weights);
  }

  return flowDirection.map((item, index) => ({
    id: item.id,
    center: item.center,
    accumulationIndex: (index + 1) * 8
  }));
}

export function generateContourLines(dem) {
  const grid = dem.contourGrid || dem.grid;
  if (!grid) {
    return [];
  }

  const intervalMeters = chooseContourInterval(
    dem.minElevationMeters ?? grid.minElevationMeters,
    dem.maxElevationMeters ?? grid.maxElevationMeters
  );
  const minLevel = Math.ceil((grid.minElevationMeters ?? 0) / intervalMeters) * intervalMeters;
  const maxLevel = Math.floor((grid.maxElevationMeters ?? 0) / intervalMeters) * intervalMeters;
  const segments = [];

  for (let level = minLevel; level <= maxLevel; level += intervalMeters) {
    for (let row = 0; row < grid.rows - 1; row += 1) {
      for (let column = 0; column < grid.columns - 1; column += 1) {
        const cellSegments = buildContourSegmentsForCell(grid, row, column, level);
        for (const points of cellSegments) {
          segments.push({
            level,
            points
          });
        }
      }
    }
  }

  return connectContourSegments(segments);
}

export async function getElevationAt(lat, lng) {
  return activeDEMContext.sampleElevationAt(lat, lng);
}

function createPlaceholderElevationCells() {
  return [
    createCell('cb-west', 12.88, 100.98, 24),
    createCell('cb-central', 13.18, 101.18, 78),
    createCell('cb-east', 13.24, 101.48, 132),
    createCell('cb-north', 13.42, 101.26, 156)
  ];
}

function createCell(id, lat, lng, elevation) {
  const halfHeight = 0.12;
  const halfWidth = 0.16;

  return {
    id,
    center: [lat, lng],
    elevation,
    polygon: [
      [lat - halfHeight, lng - halfWidth],
      [lat - halfHeight, lng + halfWidth],
      [lat + halfHeight, lng + halfWidth],
      [lat + halfHeight, lng - halfWidth]
    ]
  };
}

function normalize(value, min, max) {
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function placeholderSampleElevationAt(lat, lng) {
  const eastWestPosition = normalize(lng, CHON_BURI_BOUNDS.west, CHON_BURI_BOUNDS.east);
  const northSouthPosition = normalize(lat, CHON_BURI_BOUNDS.south, CHON_BURI_BOUNDS.north);
  const elevation = 12 + eastWestPosition * 160 + northSouthPosition * 95;
  return Number(elevation.toFixed(1));
}

async function loadLocalDEMManifest() {
  try {
    const response = await fetch('/data/chonburi-dem.json', {
      cache: 'no-store'
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

async function loadRasterDEM(localDEM) {
  const tiff = await fromUrl(localDEM.tifPath);
  const image = await tiff.getImage();
  const [west, south, east, north] = image.getBoundingBox();
  const bounds = {
    west,
    south,
    east,
    north
  };

  const [previewRaster, contourRaster] = await Promise.all([
    image.readRasters({
      samples: [0],
      width: PREVIEW_GRID_COLUMNS,
      height: PREVIEW_GRID_ROWS,
      fillValue: Number.NaN,
      resampleMethod: 'bilinear'
    }),
    image.readRasters({
      samples: [0],
      width: CONTOUR_GRID_COLUMNS,
      height: CONTOUR_GRID_ROWS,
      fillValue: Number.NaN,
      resampleMethod: 'bilinear'
    })
  ]);

  const overviewValues = Array.from(previewRaster[0], (value) => sanitizeElevation(value, null));
  const contourValues = Array.from(contourRaster[0], (value) => sanitizeElevation(value, null));
  const stats = computeElevationStats(contourValues);
  const grid = buildGridFromOverview(
    overviewValues,
    PREVIEW_GRID_COLUMNS,
    PREVIEW_GRID_ROWS,
    bounds,
    stats.min,
    stats.max
  );
  const contourGrid = buildGridFromOverview(
    contourValues,
    CONTOUR_GRID_COLUMNS,
    CONTOUR_GRID_ROWS,
    bounds,
    stats.min,
    stats.max
  );

  return {
    source: `OpenTopography ${localDEM.dataset} local cache`,
    resolutionMeters: localDEM.resolutionMeters || estimateResolutionMeters(image, bounds),
    bounds,
    dataset: localDEM.dataset,
    tifPath: localDEM.tifPath,
    cells: grid.cells,
    grid,
    analysisGrid: config.fillSinks ? fillSinks(contourGrid) : contourGrid,
    contourGrid,
    minElevationMeters: stats.min,
    maxElevationMeters: stats.max,
    sampleElevationAt: async (lat, lng) => {
      const sampled = await sampleGeoTIFFElevation(image, bounds, lat, lng);
      if (sampled === null) {
        return Number.NaN;
      }

      return sampled;
    }
  };
}

async function loadCachedDEM(localDEM) {
  const cache = await loadDEMBrowserCache(localDEM);
  if (!cache) {
    return null;
  }

  const bounds = cache.bounds || localDEM.bounds || CHON_BURI_BOUNDS;
  const stats = {
    min: cache.minElevationMeters ?? 0,
    max: cache.maxElevationMeters ?? 0
  };
  const grid = buildGridFromOverview(
    cache.previewGrid.values,
    cache.previewGrid.columns,
    cache.previewGrid.rows,
    bounds,
    stats.min,
    stats.max
  );
  const contourGrid = buildGridFromOverview(
    cache.contourGrid.values,
    cache.contourGrid.columns,
    cache.contourGrid.rows,
    bounds,
    stats.min,
    stats.max
  );

  const analysisSource =
    cache.analysisGrid || cache.sampleGrid || cache.contourGrid || cache.previewGrid;
  let analysisGrid = buildGridFromOverview(
    analysisSource.values,
    analysisSource.columns,
    analysisSource.rows,
    bounds,
    stats.min,
    stats.max
  );

  if (config.fillSinks) {
    analysisGrid = fillSinks(analysisGrid);
  }

  return {
    source: `OpenTopography ${cache.dataset || localDEM.dataset} browser cache`,
    resolutionMeters: cache.resolutionMeters || localDEM.resolutionMeters,
    bounds,
    dataset: cache.dataset || localDEM.dataset,
    tifPath: cache.tifPath || localDEM.tifPath,
    cachePath: localDEM.cachePath,
    cells: grid.cells,
    grid,
    analysisGrid,
    contourGrid,
    minElevationMeters: stats.min,
    maxElevationMeters: stats.max,
    sampleElevationAt: async (lat, lng) =>
      sampleGridElevation(cache.sampleGrid || cache.contourGrid, bounds, lat, lng)
  };
}

async function loadDEMBrowserCache(localDEM) {
  try {
    const response = await fetch(localDEM.cachePath || '/data/chonburi-dem-cache.json', {
      cache: 'no-store'
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

function buildGridFromOverview(
  values,
  columns,
  rows,
  bounds,
  minElevation,
  maxElevation,
  { preservePrecision = false } = {}
) {
  const lngStep = (bounds.east - bounds.west) / columns;
  const latStep = (bounds.north - bounds.south) / rows;
  const cells = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const elevation = sanitizeElevation(values[row * columns + column], null, {
        preservePrecision
      });
      if (!Number.isFinite(elevation)) {
        continue;
      }

      const west = bounds.west + column * lngStep;
      const east = west + lngStep;
      const north = bounds.north - row * latStep;
      const south = north - latStep;

      cells.push({
        id: `dem-${row}-${column}`,
        row,
        column,
        elevation,
        center: [(north + south) / 2, (west + east) / 2],
        polygon: [
          [south, west],
          [south, east],
          [north, east],
          [north, west]
        ]
      });
    }
  }

  const cellIndex = new Map();
  for (const cell of cells) {
    cellIndex.set(cell.row * columns + cell.column, cell);
  }

  return {
    rows,
    columns,
    bounds,
    values,
    cells,
    // Neighbour lookups run 8x per cell during flow routing. A linear scan over
    // cells is unnoticeable on a 24x24 preview and fatal on a 512x512 analysis
    // grid, so the position index is built once here.
    cellIndex,
    minElevationMeters: minElevation,
    maxElevationMeters: maxElevation
  };
}

function getAnalysisGrid(dem) {
  return dem.analysisGrid || dem.grid || null;
}

// The analysis grid and the display grid share bounds, so mapping between them
// is a plain integer scale.
function averageOntoDisplayCells(dem, analysisGrid, valuesByCell, propertyName) {
  const displayGrid = dem.grid;
  if (!displayGrid) {
    return dem.cells.map((cell) => ({ ...cell, [propertyName]: 0 }));
  }

  const totals = new Map();

  analysisGrid.cells.forEach((cell, index) => {
    const value = valuesByCell[index];
    if (!Number.isFinite(value)) {
      return;
    }

    const row = Math.min(
      Math.floor((cell.row * displayGrid.rows) / analysisGrid.rows),
      displayGrid.rows - 1
    );
    const column = Math.min(
      Math.floor((cell.column * displayGrid.columns) / analysisGrid.columns),
      displayGrid.columns - 1
    );

    const key = `${row}-${column}`;
    const entry = totals.get(key) || { sum: 0, count: 0 };
    entry.sum += value;
    entry.count += 1;
    totals.set(key, entry);
  });

  return dem.cells.map((cell) => {
    const entry = totals.get(`${cell.row}-${cell.column}`);
    return {
      ...cell,
      [propertyName]: entry ? Number((entry.sum / entry.count).toFixed(1)) : 0
    };
  });
}

function calculateSlopeGrid(grid) {
  const slopes = [];

  for (const cell of grid.cells) {
    const left = getGridValue(grid, cell.row, cell.column - 1, cell.elevation);
    const right = getGridValue(grid, cell.row, cell.column + 1, cell.elevation);
    const up = getGridValue(grid, cell.row - 1, cell.column, cell.elevation);
    const down = getGridValue(grid, cell.row + 1, cell.column, cell.elevation);

    const centerLat = cell.center[0];
    const dxMeters = metersPerDegreeLongitude(centerLat) * ((grid.bounds.east - grid.bounds.west) / grid.columns);
    const dyMeters = metersPerDegreeLatitude() * ((grid.bounds.north - grid.bounds.south) / grid.rows);

    const dzdx = (right - left) / (2 * dxMeters);
    const dzdy = (down - up) / (2 * dyMeters);
    const slopePercent = Math.sqrt(dzdx ** 2 + dzdy ** 2) * 100;
    slopes.push(Number(slopePercent.toFixed(1)));
  }

  return slopes;
}

function calculateGridFlowDirection(grid) {
  const directions = [
    { rowOffset: -1, columnOffset: 0, direction: 'N' },
    { rowOffset: -1, columnOffset: 1, direction: 'NE' },
    { rowOffset: 0, columnOffset: 1, direction: 'E' },
    { rowOffset: 1, columnOffset: 1, direction: 'SE' },
    { rowOffset: 1, columnOffset: 0, direction: 'S' },
    { rowOffset: 1, columnOffset: -1, direction: 'SW' },
    { rowOffset: 0, columnOffset: -1, direction: 'W' },
    { rowOffset: -1, columnOffset: -1, direction: 'NW' }
  ];

  // Neighbour elevations are read straight out of a flat array. Going through
  // the cell objects costs a map lookup per neighbour, which is 8x per cell.
  const { rows, columns } = grid;
  const elevations = new Float64Array(rows * columns).fill(Number.NaN);
  for (const cell of grid.cells) {
    elevations[cell.row * columns + cell.column] = cell.elevation;
  }

  return grid.cells.map((cell) => {
    const index = cell.row * columns + cell.column;
    let bestDirection = 'Flat';
    let bestDrop = 0;
    let downstreamIndex = -1;

    for (const candidate of directions) {
      const neighborRow = cell.row + candidate.rowOffset;
      const neighborColumn = cell.column + candidate.columnOffset;

      if (
        neighborRow < 0 ||
        neighborColumn < 0 ||
        neighborRow >= rows ||
        neighborColumn >= columns
      ) {
        continue;
      }

      const neighborIndex = neighborRow * columns + neighborColumn;
      const neighborElevation = elevations[neighborIndex];
      if (!Number.isFinite(neighborElevation)) {
        continue;
      }

      const drop = cell.elevation - neighborElevation;
      if (drop > bestDrop) {
        bestDrop = drop;
        bestDirection = candidate.direction;
        downstreamIndex = neighborIndex;
      }
    }

    return {
      id: cell.id,
      index,
      row: cell.row,
      column: cell.column,
      center: cell.center,
      direction: bestDirection,
      downstreamIndex,
      downstreamId: downstreamIndex < 0
        ? null
        : `dem-${Math.floor(downstreamIndex / columns)}-${downstreamIndex % columns}`
    };
  });
}

function calculateGridFlowAccumulation(flowDirection, weights) {
  const count = flowDirection.length;
  if (count === 0) {
    return [];
  }

  // Positions are resolved through typed arrays rather than string-keyed maps,
  // and the ready queue uses a read cursor: Array.shift() on a queue this size
  // is O(n) per call and dominated the whole pipeline.
  const positionByIndex = new Map();
  for (let position = 0; position < count; position += 1) {
    positionByIndex.set(flowDirection[position].index, position);
  }

  const downstream = new Int32Array(count).fill(-1);
  const indegree = new Int32Array(count);

  for (let position = 0; position < count; position += 1) {
    const target = flowDirection[position].downstreamIndex;
    if (target === undefined || target < 0) {
      continue;
    }

    const downstreamPosition = positionByIndex.get(target);
    if (downstreamPosition === undefined) {
      continue;
    }

    downstream[position] = downstreamPosition;
    indegree[downstreamPosition] += 1;
  }

  const accumulation = new Float64Array(count);
  for (let position = 0; position < count; position += 1) {
    accumulation[position] = weights ? weights[position] : 1;
  }
  const queue = new Int32Array(count);
  let tail = 0;

  for (let position = 0; position < count; position += 1) {
    if (indegree[position] === 0) {
      queue[tail] = position;
      tail += 1;
    }
  }

  for (let head = 0; head < tail; head += 1) {
    const position = queue[head];
    const target = downstream[position];
    if (target < 0) {
      continue;
    }

    accumulation[target] += accumulation[position];
    indegree[target] -= 1;

    if (indegree[target] === 0) {
      queue[tail] = target;
      tail += 1;
    }
  }

  return flowDirection.map((item, position) => ({
    id: item.id,
    index: item.index,
    row: item.row,
    column: item.column,
    center: item.center,
    accumulationIndex: accumulation[position]
  }));
}

function buildContourSegmentsForCell(grid, row, column, level) {
  const northWest = getGridCoordinate(grid, row, column);
  const northEast = getGridCoordinate(grid, row, column + 1);
  const southEast = getGridCoordinate(grid, row + 1, column + 1);
  const southWest = getGridCoordinate(grid, row + 1, column);

  const corners = [
    { point: northWest, value: getGridRawValue(grid, row, column) },
    { point: northEast, value: getGridRawValue(grid, row, column + 1) },
    { point: southEast, value: getGridRawValue(grid, row + 1, column + 1) },
    { point: southWest, value: getGridRawValue(grid, row + 1, column) }
  ];

  if (corners.some((corner) => !Number.isFinite(corner.value))) {
    return [];
  }

  const edgePoints = {
    top: interpolateContourPoint(corners[0], corners[1], level),
    right: interpolateContourPoint(corners[1], corners[2], level),
    bottom: interpolateContourPoint(corners[3], corners[2], level),
    left: interpolateContourPoint(corners[0], corners[3], level)
  };

  const mask =
    (corners[0].value >= level ? 8 : 0) |
    (corners[1].value >= level ? 4 : 0) |
    (corners[2].value >= level ? 2 : 0) |
    (corners[3].value >= level ? 1 : 0);

  const segmentEdges = MARCHING_SQUARES_SEGMENTS[mask] || [];

  return segmentEdges
    .map(([startEdge, endEdge]) => [edgePoints[startEdge], edgePoints[endEdge]])
    .filter(([startPoint, endPoint]) => startPoint && endPoint);
}

async function sampleGeoTIFFElevation(image, bounds, lat, lng) {
  if (
    lat < bounds.south ||
    lat > bounds.north ||
    lng < bounds.west ||
    lng > bounds.east
  ) {
    return Number.NaN;
  }

  const width = image.getWidth();
  const height = image.getHeight();
  const x = clamp(Math.floor(normalize(lng, bounds.west, bounds.east) * width), 0, width - 1);
  const y = clamp(
    Math.floor(normalize(bounds.north - lat, 0, bounds.north - bounds.south) * height),
    0,
    height - 1
  );

  const pixel = await image.readRasters({
    window: [x, y, x + 1, y + 1],
    samples: [0],
    fillValue: Number.NaN
  });

  return sanitizeElevation(pixel[0][0], null);
}

function sampleGridElevation(grid, bounds, lat, lng) {
  if (
    lat < bounds.south ||
    lat > bounds.north ||
    lng < bounds.west ||
    lng > bounds.east
  ) {
    return Number.NaN;
  }

  const x = clamp(
    normalize(lng, bounds.west, bounds.east) * (grid.columns - 1),
    0,
    grid.columns - 1
  );
  const y = clamp(
    normalize(bounds.north - lat, 0, bounds.north - bounds.south) * (grid.rows - 1),
    0,
    grid.rows - 1
  );
  const left = Math.floor(x);
  const right = Math.min(grid.columns - 1, left + 1);
  const top = Math.floor(y);
  const bottom = Math.min(grid.rows - 1, top + 1);
  const xRatio = x - left;
  const yRatio = y - top;
  const topLeft = getCachedGridValue(grid, top, left);
  const topRight = getCachedGridValue(grid, top, right);
  const bottomLeft = getCachedGridValue(grid, bottom, left);
  const bottomRight = getCachedGridValue(grid, bottom, right);
  const validValues = [topLeft, topRight, bottomLeft, bottomRight].filter(Number.isFinite);

  if (validValues.length === 0) {
    return Number.NaN;
  }

  if (validValues.length < 4) {
    const average = validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
    return Number(average.toFixed(1));
  }

  const topValue = topLeft + (topRight - topLeft) * xRatio;
  const bottomValue = bottomLeft + (bottomRight - bottomLeft) * xRatio;
  return Number((topValue + (bottomValue - topValue) * yRatio).toFixed(1));
}

function getCachedGridValue(grid, row, column) {
  return sanitizeElevation(grid.values[row * grid.columns + column], null);
}

function computeElevationStats(values) {
  const filtered = values.filter(Number.isFinite);

  if (filtered.length === 0) {
    return {
      min: 0,
      max: 0
    };
  }

  return {
    min: Math.min(...filtered),
    max: Math.max(...filtered)
  };
}

function sanitizeElevation(value, noDataValue, { preservePrecision = false } = {}) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }

  if (noDataValue !== null && value === noDataValue) {
    return Number.NaN;
  }

  if (value < -1000 || value > 9000) {
    return Number.NaN;
  }

  // The filled analysis grid carries a sub-millimetre gradient across former
  // depressions. Rounding to 0.1 m would flatten it straight back out.
  if (preservePrecision) {
    return value;
  }

  return Number(Number(value).toFixed(1));
}

function getGridValue(grid, row, column, fallback) {
  const cell = findGridCell(grid, row, column);
  return cell ? cell.elevation : fallback;
}

function getGridRawValue(grid, row, column) {
  if (row < 0 || row >= grid.rows || column < 0 || column >= grid.columns) {
    return Number.NaN;
  }

  return grid.values[row * grid.columns + column];
}

function getGridCoordinate(grid, row, column) {
  // GeoTIFF resampling returns values at pixel centres, not the outer raster edge.
  const lngStep = (grid.bounds.east - grid.bounds.west) / grid.columns;
  const latStep = (grid.bounds.north - grid.bounds.south) / grid.rows;
  return {
    lat: grid.bounds.north - (row + 0.5) * latStep,
    lng: grid.bounds.west + (column + 0.5) * lngStep
  };
}

function connectContourSegments(segments) {
  const byLevel = new Map();

  for (const segment of segments) {
    const levelSegments = byLevel.get(segment.level) || [];
    levelSegments.push(segment.points);
    byLevel.set(segment.level, levelSegments);
  }

  const lines = [];
  for (const [level, levelSegments] of byLevel) {
    const available = levelSegments.map((points) => ({ points, used: false }));
    const endpointIndex = new Map();

    available.forEach((segment, index) => {
      addEndpoint(endpointIndex, segment.points[0], index);
      addEndpoint(endpointIndex, segment.points[1], index);
    });

    for (let index = 0; index < available.length; index += 1) {
      if (available[index].used) {
        continue;
      }

      const line = [...available[index].points];
      available[index].used = true;
      extendContourLine(line, 'end', available, endpointIndex);
      extendContourLine(line, 'start', available, endpointIndex);
      lines.push({ level, points: line });
    }
  }

  return lines;
}

function extendContourLine(line, side, segments, endpointIndex) {
  while (true) {
    const endpoint = side === 'end' ? line[line.length - 1] : line[0];
    const candidates = endpointIndex.get(contourPointKey(endpoint)) || [];
    const nextIndex = candidates.find((index) => !segments[index].used);

    if (nextIndex === undefined) {
      return;
    }

    const next = segments[nextIndex];
    next.used = true;
    const [first, last] = next.points;
    const joinsFirst = contourPointKey(first) === contourPointKey(endpoint);
    const continuation = joinsFirst ? last : first;

    if (side === 'end') {
      line.push(continuation);
    } else {
      line.unshift(continuation);
    }
  }
}

function addEndpoint(index, point, segmentIndex) {
  const key = contourPointKey(point);
  const segmentIndices = index.get(key) || [];
  segmentIndices.push(segmentIndex);
  index.set(key, segmentIndices);
}

function contourPointKey([lat, lng]) {
  return `${lat.toFixed(8)},${lng.toFixed(8)}`;
}

function findGridCell(grid, row, column) {
  if (row < 0 || row >= grid.rows || column < 0 || column >= grid.columns) {
    return null;
  }

  if (grid.cellIndex) {
    return grid.cellIndex.get(row * grid.columns + column) || null;
  }

  return grid.cells.find((cell) => cell.row === row && cell.column === column) || null;
}

function createPlaceholderGrid() {
  return {
    rows: 2,
    columns: 2,
    bounds: CHON_BURI_BOUNDS,
    values: [24, 78, 132, 156],
    cells: createPlaceholderElevationCells(),
    minElevationMeters: 24,
    maxElevationMeters: 156
  };
}

function estimateResolutionMeters(image, bounds) {
  const width = image.getWidth();
  const height = image.getHeight();
  const centerLat = (bounds.south + bounds.north) / 2;
  const xResolution =
    (metersPerDegreeLongitude(centerLat) * (bounds.east - bounds.west)) / width;
  const yResolution = (metersPerDegreeLatitude() * (bounds.north - bounds.south)) / height;
  return Math.round((xResolution + yResolution) / 2);
}

function metersPerDegreeLatitude() {
  return 111320;
}

function metersPerDegreeLongitude(latitude) {
  return 111320 * Math.cos((latitude * Math.PI) / 180);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function interpolateContourPoint(start, end, level) {
  const startAbove = start.value >= level;
  const endAbove = end.value >= level;

  if (startAbove === endAbove && start.value !== level && end.value !== level) {
    return null;
  }

  const delta = end.value - start.value;
  if (delta === 0) {
    return [start.point.lat, start.point.lng];
  }

  const ratio = clamp((level - start.value) / delta, 0, 1);
  return [
    start.point.lat + (end.point.lat - start.point.lat) * ratio,
    start.point.lng + (end.point.lng - start.point.lng) * ratio
  ];
}

function chooseContourInterval(minElevation, maxElevation) {
  const range = Math.max(1, maxElevation - minElevation);
  if (range <= 60) return 5;
  if (range <= 180) return 10;
  if (range <= 360) return 20;
  return 50;
}

const MARCHING_SQUARES_SEGMENTS = {
  0: [],
  1: [['left', 'bottom']],
  2: [['bottom', 'right']],
  3: [['left', 'right']],
  4: [['top', 'right']],
  5: [
    ['top', 'right'],
    ['left', 'bottom']
  ],
  6: [['top', 'bottom']],
  7: [['top', 'left']],
  8: [['top', 'left']],
  9: [['top', 'bottom']],
  10: [
    ['top', 'left'],
    ['bottom', 'right']
  ],
  11: [['top', 'right']],
  12: [['left', 'right']],
  13: [['bottom', 'right']],
  14: [['left', 'bottom']],
  15: []
};

// Priority-flood depression filling (Barnes et al. 2014).
//
// Your brief's pipeline is DEM -> grid -> fill sinks -> slope -> flow direction
// -> flow accumulation. Without this step every pit in the DEM terminates flow,
// so accumulation breaks into disconnected fragments instead of forming a
// continuous drainage network. Raising a cell to the lowest elevation reachable
// from the edge guarantees every cell has a downhill path to the boundary.
const FILL_EPSILON_METERS = 1e-5;

export function fillSinks(grid) {
  const { rows, columns, values } = grid;
  const total = rows * columns;
  const filled = new Float64Array(total);
  const resolved = new Uint8Array(total);

  for (let index = 0; index < total; index += 1) {
    const elevation = sanitizeElevation(values[index], null, { preservePrecision: true });
    filled[index] = Number.isFinite(elevation) ? elevation : Number.NaN;
  }

  const isNoData = (index) => !Number.isFinite(filled[index]);
  const heap = createMinHeap();

  // Seed from the boundary and from the edges of any no-data area (the coast),
  // because those are the places water is allowed to leave the grid.
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (isNoData(index)) {
        resolved[index] = 1;
        continue;
      }

      const onEdge = row === 0 || column === 0 || row === rows - 1 || column === columns - 1;
      const besideNoData =
        !onEdge &&
        (isNoData(index - 1) ||
          isNoData(index + 1) ||
          isNoData(index - columns) ||
          isNoData(index + columns));

      if (onEdge || besideNoData) {
        resolved[index] = 1;
        heap.push(index, filled[index]);
      }
    }
  }

  while (heap.size() > 0) {
    const { index, priority } = heap.pop();
    const row = Math.floor(index / columns);
    const column = index % columns;

    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
        if (rowOffset === 0 && columnOffset === 0) {
          continue;
        }

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

        const neighborIndex = neighborRow * columns + neighborColumn;
        if (resolved[neighborIndex]) {
          continue;
        }

        resolved[neighborIndex] = 1;

        // Raising a pit to exactly its spill level creates a flat, where no
        // neighbour is strictly lower and flow routing stalls. Adding a tiny
        // increment preserves a downhill path across the filled area.
        if (filled[neighborIndex] <= priority) {
          filled[neighborIndex] = priority + FILL_EPSILON_METERS;
        }

        heap.push(neighborIndex, filled[neighborIndex]);
      }
    }
  }

  // Kept at full precision: rounding here would erase the epsilon gradient.
  const filledValues = Array.from(filled, (elevation) =>
    Number.isFinite(elevation) ? elevation : null
  );

  return buildGridFromOverview(
    filledValues,
    columns,
    rows,
    grid.bounds,
    grid.minElevationMeters,
    grid.maxElevationMeters,
    { preservePrecision: true }
  );
}

export function createMinHeap() {
  const indices = [];
  const priorities = [];

  function swap(a, b) {
    const index = indices[a];
    indices[a] = indices[b];
    indices[b] = index;

    const priority = priorities[a];
    priorities[a] = priorities[b];
    priorities[b] = priority;
  }

  return {
    size: () => indices.length,
    push(index, priority) {
      indices.push(index);
      priorities.push(priority);

      let child = indices.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (priorities[parent] <= priorities[child]) {
          break;
        }

        swap(parent, child);
        child = parent;
      }
    },
    pop() {
      const topIndex = indices[0];
      const topPriority = priorities[0];
      const lastIndex = indices.pop();
      const lastPriority = priorities.pop();

      if (indices.length > 0) {
        indices[0] = lastIndex;
        priorities[0] = lastPriority;

        let parent = 0;
        for (;;) {
          const left = parent * 2 + 1;
          const right = left + 1;
          let smallest = parent;

          if (left < indices.length && priorities[left] < priorities[smallest]) {
            smallest = left;
          }

          if (right < indices.length && priorities[right] < priorities[smallest]) {
            smallest = right;
          }

          if (smallest === parent) {
            break;
          }

          swap(parent, smallest);
          parent = smallest;
        }
      }

      return { index: topIndex, priority: topPriority };
    }
  };
}
