// Downloads water gates (sluice gates, floodgates, weirs, dams) and water
// bodies (lakes, reservoirs, ponds) for the Chon Buri bounding box from
// OpenStreetMap.
//
// Run: npm run fetch:water

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { readChonBuriBounds, requestOverpass, toBboxString } from './overpass.mjs';

const OUTPUT_DIR = path.join(process.cwd(), 'public', 'data');
const GATES_PATH = path.join(OUTPUT_DIR, 'chonburi-water-gates.geojson');
const BODIES_PATH = path.join(OUTPUT_DIR, 'chonburi-water-bodies.geojson');

const GATE_TYPES = 'sluice_gate|floodgate|weir|dam|check_dam|lock_gate';
// Ponds below this are usually individual aquaculture or farm ponds; keeping
// them all would add tens of thousands of shapes with little analytical value.
const MIN_BODY_AREA_M2 = 10000;

const bounds = readChonBuriBounds();
const bbox = toBboxString(bounds);

await mkdir(OUTPUT_DIR, { recursive: true });

console.log(`Bounding box: ${bbox}\n`);

// --- water gates -----------------------------------------------------------

console.log(`Requesting water gates (${GATE_TYPES})...`);
const gatePayload = await requestOverpass(`
[out:json][timeout:240];
(
  node["waterway"~"^(${GATE_TYPES})$"](${bbox});
  way["waterway"~"^(${GATE_TYPES})$"](${bbox});
);
out center;
`);

const gateCounts = {};
const gateFeatures = [];

for (const element of gatePayload.elements || []) {
  // `out center` gives nodes a lat/lon and ways a center, so both reduce to a point.
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    continue;
  }

  const tags = element.tags || {};
  const gateType = tags.waterway || 'unknown';
  gateCounts[gateType] = (gateCounts[gateType] || 0) + 1;

  gateFeatures.push({
    type: 'Feature',
    properties: {
      id: `${element.type}/${element.id}`,
      name: tags.name || tags['name:en'] || null,
      gateType,
      operator: tags.operator || null
    },
    geometry: {
      type: 'Point',
      coordinates: [Number(lon.toFixed(6)), Number(lat.toFixed(6))]
    }
  });
}

await writeFile(
  GATES_PATH,
  JSON.stringify({
    type: 'FeatureCollection',
    properties: {
      source: 'OpenStreetMap contributors (ODbL), via Overpass API',
      downloadedAt: new Date().toISOString(),
      gateTypes: GATE_TYPES.split('|')
    },
    features: gateFeatures
  }),
  'utf8'
);

console.log(`\nSaved ${gateFeatures.length} water gates to ${GATES_PATH}`);
for (const [type, count] of Object.entries(gateCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count}`);
}

// --- lakes and reservoirs --------------------------------------------------

console.log('\nRequesting lakes and reservoirs...');
const bodyPayload = await requestOverpass(`
[out:json][timeout:240];
(
  way["natural"="water"](${bbox});
  way["landuse"="reservoir"](${bbox});
  relation["natural"="water"](${bbox});
  relation["landuse"="reservoir"](${bbox});
);
out geom;
`);

const bodyCounts = {};
const bodyFeatures = [];
let skippedSmall = 0;
let skippedOpen = 0;

for (const element of bodyPayload.elements || []) {
  const tags = element.tags || {};
  const waterType = tags.water || tags.landuse || tags.natural || 'water';

  for (const polygon of polygonsOf(element)) {
    const ring = polygon[0];
    if (ring.length < 4) {
      skippedOpen += 1;
      continue;
    }

    const areaM2 = ringAreaM2(ring);
    if (areaM2 < MIN_BODY_AREA_M2) {
      skippedSmall += 1;
      continue;
    }

    bodyCounts[waterType] = (bodyCounts[waterType] || 0) + 1;
    bodyFeatures.push({
      type: 'Feature',
      properties: {
        id: `${element.type}/${element.id}`,
        name: tags.name || tags['name:en'] || null,
        waterType,
        areaM2: Math.round(areaM2)
      },
      geometry: { type: 'Polygon', coordinates: polygon }
    });
  }
}

bodyFeatures.sort((a, b) => b.properties.areaM2 - a.properties.areaM2);

await writeFile(
  BODIES_PATH,
  JSON.stringify({
    type: 'FeatureCollection',
    properties: {
      source: 'OpenStreetMap contributors (ODbL), via Overpass API',
      downloadedAt: new Date().toISOString(),
      minimumAreaM2: MIN_BODY_AREA_M2
    },
    features: bodyFeatures
  }),
  'utf8'
);

console.log(`\nSaved ${bodyFeatures.length} water bodies to ${BODIES_PATH}`);
console.log(`  skipped ${skippedSmall} below ${MIN_BODY_AREA_M2 / 10000} ha, ${skippedOpen} unclosed rings`);
for (const [type, count] of Object.entries(bodyCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${type}: ${count}`);
}
const largest = bodyFeatures.slice(0, 5);
if (largest.length > 0) {
  console.log('  largest:');
  for (const feature of largest) {
    const hectares = (feature.properties.areaM2 / 10000).toFixed(0);
    console.log(`    ${feature.properties.name || '(unnamed)'} - ${hectares} ha`);
  }
}

// A closed way is one ring. A multipolygon relation is not: its outer ring is
// normally split across several open ways that have to be stitched end-to-end
// before it closes. Taking only members that were already closed silently
// dropped whole reservoirs, including Bang Phra.
function polygonsOf(element) {
  if (element.type === 'way') {
    const ring = toRing(element.geometry || []);
    return ring.length >= 4 && isClosed(ring) ? [[ring]] : [];
  }

  const members = element.members || [];
  const outer = stitchRings(members.filter((m) => m.role !== 'inner'));
  const inner = stitchRings(members.filter((m) => m.role === 'inner'));

  if (outer.length === 0) {
    return [];
  }

  // Holes are only assigned when there is a single outer ring; with several,
  // deciding which hole belongs to which needs point-in-polygon work this
  // prototype does not need.
  if (outer.length === 1) {
    return [[outer[0], ...inner]];
  }

  return outer.map((ring) => [ring]);
}

// Join member ways head-to-tail until each ring closes. Overpass emits the
// identical coordinate for a shared node, so endpoints match exactly.
function stitchRings(members) {
  const pending = members
    .map((member) => toRing(member.geometry || []))
    .filter((ring) => ring.length >= 2);

  const rings = [];

  while (pending.length > 0) {
    let ring = pending.shift();

    let extended = true;
    while (extended && !isClosed(ring)) {
      extended = false;

      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];
        const tail = ring[ring.length - 1];

        if (samePoint(tail, candidate[0])) {
          ring = ring.concat(candidate.slice(1));
        } else if (samePoint(tail, candidate[candidate.length - 1])) {
          ring = ring.concat(candidate.slice(0, -1).reverse());
        } else {
          continue;
        }

        pending.splice(index, 1);
        extended = true;
        break;
      }
    }

    if (ring.length >= 4 && isClosed(ring)) {
      rings.push(ring);
    }
  }

  return rings;
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function toRing(geometry) {
  return geometry
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
    .map((point) => [Number(point.lon.toFixed(6)), Number(point.lat.toFixed(6))]);
}

function isClosed(ring) {
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  return firstLng === lastLng && firstLat === lastLat;
}

// Shoelace area, with degrees converted to metres at the ring's own latitude.
function ringAreaM2(ring) {
  if (!isClosed(ring)) {
    return 0;
  }

  const meanLat = ring.reduce((total, point) => total + point[1], 0) / ring.length;
  const metersPerLat = 110574;
  const metersPerLng = 111320 * Math.cos((meanLat * Math.PI) / 180);

  let sum = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [lng1, lat1] = ring[previous];
    const [lng2, lat2] = ring[index];
    sum += lng1 * metersPerLng * (lat2 * metersPerLat) - lng2 * metersPerLng * (lat1 * metersPerLat);
  }

  return Math.abs(sum / 2);
}
