// Downloads the urban landcover detail from OpenStreetMap: green ground
// (parks, pitches, gardens, grass, wood) and building footprints, for the
// dense city box around Pattaya.
//
// This is the DETAIL coat of the imperviousness build, not the base: the
// LDD land-use survey (LU_CBI_2567) classifies every square metre of the
// province but absorbs a city park into "City, Town, Commercial"; OSM knows
// the park but not the whole province. Each is used where it is strong, and
// OSM's silence proves nothing - an unmapped block keeps its land-use value.
//
// Run: npm run fetch:landcover

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { requestOverpass } from './overpass.mjs';

const OUTPUT_DIR = path.join(process.cwd(), 'public', 'data');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'chonburi-landcover.geojson');

// The street model's dense zone; the land-use base covers everything beyond.
const CITY_BBOX = '12.80,100.80,13.06,101.00';

const GREEN_LEISURE = 'park|garden|pitch|golf_course|recreation_ground|playground';
const GREEN_LANDUSE = 'grass|meadow|village_green|recreation_ground|forest|orchard|cemetery';
const GREEN_NATURAL = 'wood|scrub|grassland|beach|sand';

// Slivers below these read as noise: a verge strip is not a park, and a
// 20 m2 shed does not change a corridor's imperviousness.
const MIN_GREEN_M2 = 300;
const MIN_BUILDING_M2 = 25;

/** Rings of a way or multipolygon relation, [[ [lng,lat], ... ], ...]. */
function polygonsOf(element) {
  if (element.type === 'way' && Array.isArray(element.geometry)) {
    const ring = element.geometry.map((point) => [point.lon, point.lat]);
    if (ring.length >= 3) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push(first);
      }
      return [[ring]];
    }
    return [];
  }
  if (element.type === 'relation' && Array.isArray(element.members)) {
    const polygons = [];
    for (const member of element.members) {
      if (member.role !== 'outer' || !Array.isArray(member.geometry)) {
        continue;
      }
      const ring = member.geometry.map((point) => [point.lon, point.lat]);
      if (ring.length < 3) {
        continue;
      }
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push(first);
      }
      polygons.push([ring]);
    }
    return polygons;
  }
  return [];
}

/** Shoelace area of a lng/lat ring, in square metres. */
function ringAreaM2(ring) {
  const lat = ring[0][1];
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const mLat = 110574;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    total += (x1 * mLng) * (y2 * mLat) - (x2 * mLng) * (y1 * mLat);
  }
  return Math.abs(total) / 2;
}

function collect(payload, kind, minArea, counts, features) {
  for (const element of payload.elements || []) {
    const tags = element.tags || {};
    for (const polygon of polygonsOf(element)) {
      const areaM2 = ringAreaM2(polygon[0]);
      if (areaM2 < minArea) {
        continue;
      }
      const what =
        kind === 'green'
          ? tags.leisure || tags.landuse || tags.natural || 'green'
          : 'building';
      counts[what] = (counts[what] || 0) + 1;
      features.push({
        type: 'Feature',
        properties: { kind, what, areaM2: Math.round(areaM2) },
        geometry: { type: 'Polygon', coordinates: polygon }
      });
    }
  }
}

await mkdir(OUTPUT_DIR, { recursive: true });
const counts = {};
const features = [];

console.log(`City box: ${CITY_BBOX}\n`);
console.log('Requesting green ground (parks, pitches, grass, wood)...');
const green = await requestOverpass(`
[out:json][timeout:240];
(
  way["leisure"~"^(${GREEN_LEISURE})$"](${CITY_BBOX});
  way["landuse"~"^(${GREEN_LANDUSE})$"](${CITY_BBOX});
  way["natural"~"^(${GREEN_NATURAL})$"](${CITY_BBOX});
  relation["leisure"~"^(${GREEN_LEISURE})$"](${CITY_BBOX});
  relation["landuse"~"^(${GREEN_LANDUSE})$"](${CITY_BBOX});
);
out geom;
`);
collect(green, 'green', MIN_GREEN_M2, counts, features);

console.log('Requesting building footprints...');
const buildings = await requestOverpass(`
[out:json][timeout:240];
way["building"](${CITY_BBOX});
out geom;
`);
collect(buildings, 'building', MIN_BUILDING_M2, counts, features);

await writeFile(
  OUTPUT_PATH,
  JSON.stringify({
    type: 'FeatureCollection',
    properties: {
      source: 'OpenStreetMap contributors (ODbL), via Overpass API',
      downloadedAt: new Date().toISOString(),
      cityBbox: CITY_BBOX,
      minimumGreenM2: MIN_GREEN_M2,
      minimumBuildingM2: MIN_BUILDING_M2
    },
    features
  })
);

const greens = features.filter((f) => f.properties.kind === 'green').length;
const built = features.length - greens;
console.log(`\nSaved ${features.length.toLocaleString()} polygons to ${OUTPUT_PATH}`);
console.log(`  green ${greens.toLocaleString()} · buildings ${built.toLocaleString()}`);
for (const [what, count] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${what}: ${count}`);
}
