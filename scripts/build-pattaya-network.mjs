// Converts the Pattaya drainage export (coordinate_route / route_station /
// station, as TSV from pgAdmin) into GeoJSON for the map.
//
// Run: npm run build:pattaya

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const IN_DIR = path.join(process.cwd(), 'data', 'pattaya');
const OUT_DIR = path.join(process.cwd(), 'public', 'data');

function readTsv(name) {
  const file = path.join(IN_DIR, name);
  if (!existsSync(file)) {
    throw new Error(`missing ${file} — export it from pgAdmin first`);
  }

  const [header, ...lines] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const columns = header.split('\t');
  return lines.map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]]));
  });
}

const coordinates = readTsv('coordinate_route.tsv');
const segments = readTsv('route_station.tsv');
const stations = readTsv('station.tsv');

console.log(
  `Read ${coordinates.length} coordinates, ${segments.length} segments, ${stations.length} stations`
);

// --- validate before building ------------------------------------------------

const bySegment = new Map();
for (const row of coordinates) {
  if (!bySegment.has(row.routeStationId)) {
    bySegment.set(row.routeStationId, []);
  }
  bySegment.get(row.routeStationId).push({
    index: Number(row.index),
    lat: Number(row.latitude),
    lng: Number(row.longitude)
  });
}

const problems = [];
for (const segment of segments) {
  const points = bySegment.get(segment.routeStationId);
  if (!points) {
    problems.push(`segment ${segment.routeStationId} has no coordinates`);
    continue;
  }

  // Gaps mean the export was truncated: a missing index silently shortcuts the pipe.
  const seen = new Set(points.map((p) => p.index));
  const missing = [];
  for (let i = 0; i < Math.max(...seen) + 1; i += 1) {
    if (!seen.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    problems.push(`segment ${segment.routeStationId} missing index ${missing.join(', ')}`);
  }
}

const stationIds = new Set(stations.map((s) => s.stationId));
const missingEndpoints = new Set();
for (const segment of segments) {
  for (const key of ['startStationId', 'endStationId']) {
    if (segment[key] && !stationIds.has(segment[key])) {
      missingEndpoints.add(segment[key]);
    }
  }
}

const orphanCoords = [...bySegment.keys()].filter(
  (id) => !segments.some((s) => s.routeStationId === id)
);

if (problems.length) {
  console.warn('\nGaps found:');
  for (const p of problems) console.warn(`  ${p}`);
}
if (missingEndpoints.size) {
  console.warn(`\n${missingEndpoints.size} segment endpoints are not in station.tsv`);
}
if (orphanCoords.length) {
  console.warn(`\n${orphanCoords.length} coordinate groups have no matching segment`);
}

// --- build GeoJSON -----------------------------------------------------------

const stationById = new Map(stations.map((s) => [s.stationId, s]));

const pipeFeatures = segments
  .map((segment) => {
    const points = (bySegment.get(segment.routeStationId) || [])
      .slice()
      .sort((a, b) => a.index - b.index);

    if (points.length < 2) {
      return null;
    }

    const start = stationById.get(segment.startStationId);
    const end = stationById.get(segment.endStationId);

    return {
      type: 'Feature',
      properties: {
        routeStationId: segment.routeStationId,
        routeId: segment.routeId,
        segmentIndex: Number(segment.index),
        distanceM: Number(segment.distance),
        startStation: start?.name || null,
        endStation: end?.name || null,
        // Pipe bore is only recorded on the stations, so a segment carries the
        // figures from the stations at each of its ends.
        startHeightRef: start ? Number(start.heightRef) : null,
        endHeightRef: end ? Number(end.heightRef) : null,
        startCrossSectionArea: start ? Number(start.crossSectionArea) : null,
        endCrossSectionArea: end ? Number(end.crossSectionArea) : null,
        pointCount: points.length
      },
      geometry: {
        type: 'LineString',
        coordinates: points.map((p) => [p.lng, p.lat])
      }
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.properties.segmentIndex - b.properties.segmentIndex);

const stationFeatures = stations.map((station) => ({
  type: 'Feature',
  properties: {
    stationId: station.stationId,
    name: station.name,
    sensorType: station.sensorType,
    heightRef: Number(station.heightRef),
    crossSectionArea: Number(station.crossSectionArea)
  },
  geometry: {
    type: 'Point',
    coordinates: [Number(station.longitude), Number(station.latitude)]
  }
}));

const source = 'Pattaya drainage network (SMART GIS database export)';

writeFileSync(
  path.join(OUT_DIR, 'pattaya-pipes.geojson'),
  JSON.stringify({ type: 'FeatureCollection', properties: { source }, features: pipeFeatures }),
  'utf8'
);
writeFileSync(
  path.join(OUT_DIR, 'pattaya-stations.geojson'),
  JSON.stringify({ type: 'FeatureCollection', properties: { source }, features: stationFeatures }),
  'utf8'
);

const emptyCrossSection = stations.filter((s) => Number(s.crossSectionArea) === 0).length;
if (emptyCrossSection > 0) {
  console.warn(
    `
${emptyCrossSection} of ${stations.length} stations have crossSectionArea = 0 ` +
      '(field present but unpopulated, so pipe width/area is unknown)'
  );
}

const routes = new Set(segments.map((s) => s.routeId));
const tunnel = stations.filter((s) => s.sensorType === 'TUNNEL').length;
console.log(`\nWrote ${pipeFeatures.length} pipe segments across ${routes.size} routes`);
console.log(`Wrote ${stationFeatures.length} stations (${tunnel} in-pipe, ${stationFeatures.length - tunnel} on-road)`);
console.log(`Total pipe length: ${(segments.reduce((t, s) => t + Number(s.distance), 0) / 1000).toFixed(2)} km`);
