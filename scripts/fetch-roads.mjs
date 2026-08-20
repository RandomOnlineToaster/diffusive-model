// Downloads the street network for the urban area from OpenStreetMap.
//
// Streets are the real conveyance for surface runoff in a built-up area: water
// that leaves a roof or a yard runs along the kerb until it finds an inlet. A
// 200 m DEM grid cannot see that, so this gives the flow model a second, much
// finer network to route on.
//
// Run: npm run fetch:roads

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { requestOverpass } from './overpass.mjs';

const OUTPUT_DIR = path.join(process.cwd(), 'public', 'data');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'chonburi-roads.geojson');

// Greater Pattaya by default: Bang Lamung down through Nong Prue and Khao Talo
// to Na Chom Thian and Ban Chak. The whole province has 151,292 road ways,
// which is far too much for a browser; this box holds ~22,000.
const BBOX = process.env.ROAD_BBOX || '12.720000,100.830000,13.050000,101.000000';
const CLASSES =
  process.env.ROAD_CLASSES ||
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track';

console.log(`Requesting streets in ${BBOX}`);
console.log(`Classes: ${CLASSES.split('|').join(', ')}`);

const payload = await requestOverpass(`
[out:json][timeout:240];
way["highway"~"^(${CLASSES})$"](${BBOX});
out geom;
`);

const counts = {};
const features = [];

for (const element of payload.elements || []) {
  if (!Array.isArray(element.geometry) || element.geometry.length < 2) {
    continue;
  }

  const tags = element.tags || {};
  const highway = tags.highway || 'unknown';
  counts[highway] = (counts[highway] || 0) + 1;

  features.push({
    type: 'Feature',
    properties: {
      id: element.id,
      name: tags.name || null,
      highway,
      // A bridge carries water across, not along; a tunnel is not a surface route.
      bridge: tags.bridge ? 1 : 0,
      tunnel: tags.tunnel ? 1 : 0
    },
    geometry: {
      type: 'LineString',
      coordinates: element.geometry.map((point) => [
        Number(point.lon.toFixed(6)),
        Number(point.lat.toFixed(6))
      ])
    }
  });
}

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(
  OUTPUT_PATH,
  JSON.stringify({
    type: 'FeatureCollection',
    properties: {
      source: 'OpenStreetMap contributors (ODbL), via Overpass API',
      downloadedAt: new Date().toISOString(),
      bbox: BBOX
    },
    features
  }),
  'utf8'
);

const vertices = features.reduce((total, f) => total + f.geometry.coordinates.length, 0);
console.log(`\nSaved ${features.length} street ways (${vertices.toLocaleString()} vertices) to ${OUTPUT_PATH}`);
for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count}`);
}
console.log('\nNext: npm run build:roads');
