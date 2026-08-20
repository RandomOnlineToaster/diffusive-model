// Shared helpers for the OpenStreetMap / Overpass download scripts.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Ordered by preference; the main instance is often rate limited.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

// Overpass rate-limits anonymous clients, so identify the tool explicitly.
const USER_AGENT =
  'chonburi-rainfall-prototype/0.1 (local research prototype; contact via repository)';

const TIMEOUT_MS = 300000;

export async function requestOverpass(query) {
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
        body: new URLSearchParams({ data: query }),
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
      const reason =
        error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : error.message;
      console.warn(`  failed: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  console.error('\nAll Overpass endpoints failed. Overpass is frequently rate limited;');
  console.error('wait a minute and run the command again.');
  console.error(lastError?.message || '');
  process.exitCode = 1;
  throw new Error('Overpass request failed');
}

export function readChonBuriBounds() {
  const geojsonPath = path.join(process.cwd(), 'data', 'chonburi.geojson');
  return computeBounds(JSON.parse(readFileSync(geojsonPath, 'utf8')));
}

export function toBboxString(bounds) {
  return [
    bounds.south.toFixed(6),
    bounds.west.toFixed(6),
    bounds.north.toFixed(6),
    bounds.east.toFixed(6)
  ].join(',');
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
