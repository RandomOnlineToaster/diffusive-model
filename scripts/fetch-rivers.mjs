// Downloads real waterway geometry for the Chon Buri bounding box from
// OpenStreetMap via the Overpass API, and writes it as GeoJSON LineStrings.
//
// Run: npm run fetch:rivers

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROJECT_ROOT = process.cwd();
const GEOJSON_PATH = path.join(PROJECT_ROOT, 'data', 'chonburi.geojson');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'public', 'data');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'chonburi-rivers.geojson');

// Ordered by preference; the main instance is often rate limited.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const WATERWAY_TYPES = 'river|canal|stream|drain';
// Overpass rate-limits anonymous clients, so identify the tool explicitly.
const USER_AGENT =
  'chonburi-rainfall-prototype/0.1 (local research prototype; contact via repository)';
const TIMEOUT_MS = 300000;

const bounds = computeBounds(JSON.parse(readFileSync(GEOJSON_PATH, 'utf8')));
const bbox = [
  bounds.south.toFixed(6),
  bounds.west.toFixed(6),
  bounds.north.toFixed(6),
  bounds.east.toFixed(6)
].join(',');

const query = `
[out:json][timeout:240];
(
  way["waterway"~"^(${WATERWAY_TYPES})$"](${bbox});
);
out geom;
`;

console.log(`Requesting Chon Buri waterways (${WATERWAY_TYPES}) from OpenStreetMap...`);
console.log(`Bounding box: ${bbox}`);

const payload = await requestWithFallback(query);
const elements = payload.elements || [];
console.log(`Received ${elements.length} ways.`);

const features = [];
const counts = {};

for (const element of elements) {
  if (!Array.isArray(element.geometry) || element.geometry.length < 2) {
    continue;
  }

  const tags = element.tags || {};
  const waterway = tags.waterway || 'unknown';
  counts[waterway] = (counts[waterway] || 0) + 1;

  features.push({
    type: 'Feature',
    properties: {
      id: element.id,
      name: tags.name || tags['name:en'] || null,
      nameEn: tags['name:en'] || null,
      waterway,
      intermittent: tags.intermittent === 'yes' || undefined,
      tunnel: tags.tunnel || undefined,
      width: tags.width || undefined
    },
    geometry: {
      type: 'LineString',
      // Overpass returns {lat, lon}; GeoJSON wants [lng, lat].
      coordinates: element.geometry.map((point) => [
        Number(point.lon.toFixed(6)),
        Number(point.lat.toFixed(6))
      ])
    }
  });
}

const collection = {
  type: 'FeatureCollection',
  properties: {
    source: 'OpenStreetMap contributors (ODbL), via Overpass API',
    downloadedAt: new Date().toISOString(),
    bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
    waterwayTypes: WATERWAY_TYPES.split('|')
  },
  features
};

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(collection), 'utf8');

const named = features.filter((feature) => feature.properties.name).length;
console.log(`\nSaved ${features.length} waterway lines to ${OUTPUT_PATH}`);
console.log(`  named: ${named}`);
for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count}`);
}

async function requestWithFallback(overpassQuery) {
  let lastError = null;

  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      console.log(`  trying ${new URL(endpoint).host} ...`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT
        },
        body: new URLSearchParams({ data: overpassQuery }),
        signal: controller.signal
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`${response.status} ${response.statusText} ${detail}`);
      }

      const text = await response.text();
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ok: ${(text.length / (1024 * 1024)).toFixed(1)} MB in ${seconds}s`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const reason = error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : error.message;
      console.warn(`  failed: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  console.error('\nAll Overpass endpoints failed. Overpass is frequently rate limited;');
  console.error('wait a minute and run npm run fetch:rivers again.');
  console.error(lastError?.message || '');
  process.exitCode = 1;
  throw new Error('Overpass request failed');
}

function computeBounds(geojson) {
  const coordinates =
    geojson.type === 'Feature'
      ? geojson.geometry.coordinates
      : geojson.features.flatMap((feature) => feature.geometry.coordinates);

  const flattened = [];
  collectPositions(coordinates, flattened);

  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const [lng, lat] of flattened) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  return { west, east, south, north };
}

function collectPositions(value, output) {
  if (!Array.isArray(value)) {
    return;
  }

  if (typeof value[0] === 'number' && typeof value[1] === 'number') {
    output.push(value);
    return;
  }

  for (const item of value) {
    collectPositions(item, output);
  }
}
