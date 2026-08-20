import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROJECT_ROOT = process.cwd();
const GEOJSON_PATH = path.join(PROJECT_ROOT, 'data', 'chonburi.geojson');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'public', 'data');
const OUTPUT_MANIFEST = path.join(OUTPUT_DIR, 'chonburi-dem.json');

const dataset = getEnvValue('DEM_DATASET') || 'COP30';
const outputFormat = getEnvValue('DEM_OUTPUT_FORMAT') || 'AAIGrid';
const apiKey = getEnvValue('OPENTOPOGRAPHY_API_KEY');
const timeoutMs = Number(getEnvValue('DEM_FETCH_TIMEOUT_MS') || 10 * 60 * 1000);
const stallTimeoutMs = Number(getEnvValue('DEM_STALL_TIMEOUT_MS') || 90 * 1000);

const RENDER_INTERVAL_MS = process.stdout.isTTY ? 200 : 5000;

let progressLineOpen = false;
const SPLIT_HINT =
  'OpenTopography cuts large responses off mid-stream. Fetch a smaller area, or switch to COP90, ' +
  'which is roughly 9x smaller for the same bounds.';

if (!apiKey) {
  console.error('Missing OPENTOPOGRAPHY_API_KEY. Put it in .env.local or your shell environment.');
  process.exit(1);
}

const bounds = computeBounds(JSON.parse(readFileSync(GEOJSON_PATH, 'utf8')));
const query = new URLSearchParams({
  demtype: dataset,
  south: bounds.south.toFixed(6),
  north: bounds.north.toFixed(6),
  west: bounds.west.toFixed(6),
  east: bounds.east.toFixed(6),
  outputFormat,
  API_Key: apiKey
});

const url = `https://portal.opentopography.org/API/globaldem?${query.toString()}`;

await mkdir(OUTPUT_DIR, { recursive: true });

console.log(`Requesting ${dataset} DEM for Chon Buri...`);
console.log(
  `Bounds: south=${bounds.south.toFixed(4)}, north=${bounds.north.toFixed(4)}, west=${bounds.west.toFixed(4)}, east=${bounds.east.toFixed(4)}`
);
console.log(
  `Timeout: ${Math.round(timeoutMs / 1000)}s total, ${Math.round(stallTimeoutMs / 1000)}s without data`
);

const controller = new AbortController();
let abortCause = '';

const deadlineTimer = setTimeout(() => {
  abortCause = 'deadline';
  controller.abort();
}, timeoutMs);

let stallTimer = null;

function resetStallTimer() {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    abortCause = 'stall';
    controller.abort();
  }, stallTimeoutMs);
}

function clearTimers() {
  clearTimeout(deadlineTimer);
  clearTimeout(stallTimer);
}

let response;
resetStallTimer();

try {
  response = await fetch(url, { signal: controller.signal });
} catch (error) {
  clearTimers();

  if (error.name === 'AbortError') {
    console.error(reportAbort(0));
    process.exit(1);
  }

  throw error;
}

if (!response.ok) {
  clearTimers();
  const errorText = await response.text();
  console.error(`OpenTopography request failed: ${response.status} ${response.statusText}`);
  console.error(errorText.slice(0, 800));
  process.exit(1);
}

const expectedBytes = Number(response.headers.get('content-length')) || 0;
const startedAt = Date.now();
const chunks = [];
let received = 0;
let lastRenderAt = 0;
let streamError = null;

console.log(
  expectedBytes
    ? `Server reports ${formatBytes(expectedBytes)}. Downloading...`
    : 'Server did not report a size (chunked response). Downloading...'
);

try {
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    resetStallTimer();

    const now = Date.now();
    if (now - lastRenderAt >= RENDER_INTERVAL_MS) {
      renderProgress(received, expectedBytes, startedAt);
      lastRenderAt = now;
    }
  }

  renderProgress(received, expectedBytes, startedAt);
} catch (error) {
  streamError = error;
} finally {
  clearTimers();
  endProgressLine();
}

const buffer = Buffer.concat(chunks);

if (streamError) {
  if (streamError.name === 'AbortError') {
    console.error(reportAbort(received));
  } else {
    console.error(
      `Download failed after ${formatBytes(received)}: ${streamError.message}${
        streamError.cause ? ` (${streamError.cause.message})` : ''
      }`
    );
  }

  await savePartial(buffer);
  process.exit(1);
}

if (expectedBytes && received !== expectedBytes) {
  console.error(
    `Truncated download: received ${formatBytes(received)} of ${formatBytes(expectedBytes)} (${(
      (received / expectedBytes) *
      100
    ).toFixed(1)}%).`
  );
  console.error(SPLIT_HINT);
  await savePartial(buffer);
  process.exit(1);
}

console.log(`Downloaded ${formatBytes(received)} in ${formatDuration(Date.now() - startedAt)}.`);

const dataFileName = getDEMFileName(outputFormat, buffer);
const outputDEM = path.join(OUTPUT_DIR, dataFileName);

const shortfall = describeGridShortfall(outputFormat, buffer);
if (shortfall) {
  console.error(shortfall);
  console.error(SPLIT_HINT);
  await savePartial(buffer);
  process.exit(1);
}

await writeFile(outputDEM, buffer);

const manifest = {
  source: 'OpenTopography',
  dataset,
  outputFormat,
  dataPath: `/data/${dataFileName}`,
  cachePath: '/data/chonburi-dem-cache.json',
  downloadedAt: new Date().toISOString(),
  bounds,
  resolutionMeters: inferResolutionMeters(dataset),
  notes: [
    'GeoTIFF downloaded locally for Chon Buri Province.',
    'The browser app reads a generated DEM cache for elevation sampling and terrain preview layers.',
    'Full hydrology processing can be added later without changing the API key workflow.'
  ]
};

if (outputFormat === 'GTiff') {
  manifest.tifPath = `/data/${dataFileName}`;
}

await writeFile(OUTPUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Saved DEM data to ${outputDEM}`);
console.log(`Saved manifest to ${OUTPUT_MANIFEST}`);
console.log('Run npm run build:dem-cache to prepare the browser DEM cache.');

function renderProgress(bytes, totalBytes, startTime) {
  const elapsedMs = Date.now() - startTime;
  const speed = bytes / Math.max(elapsedMs / 1000, 0.001);
  const parts = [];

  if (totalBytes) {
    const ratio = Math.min(bytes / totalBytes, 1);
    const filled = Math.round(ratio * 24);
    parts.push(`[${'#'.repeat(filled)}${'-'.repeat(24 - filled)}]`);
    parts.push(`${(ratio * 100).toFixed(1)}%`);
    parts.push(`${formatBytes(bytes)} / ${formatBytes(totalBytes)}`);
    parts.push(`${formatBytes(speed)}/s`);
    parts.push(`eta ${speed > 0 ? formatDuration(((totalBytes - bytes) / speed) * 1000) : '--:--'}`);
  } else {
    parts.push(`${formatBytes(bytes)} received`);
    parts.push(`${formatBytes(speed)}/s`);
    parts.push(`${formatDuration(elapsedMs)} elapsed`);
  }

  const line = `  ${parts.join('  ')}`;

  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line.padEnd(78)}`);
    progressLineOpen = true;
    return;
  }

  console.log(line);
}

function endProgressLine() {
  if (progressLineOpen) {
    process.stdout.write('\n');
    progressLineOpen = false;
  }
}

function reportAbort(bytes) {
  if (abortCause === 'stall') {
    return (
      `Download stalled: no data for ${Math.round(stallTimeoutMs / 1000)} seconds after ` +
      `${formatBytes(bytes)}. ${SPLIT_HINT}\nRaise DEM_STALL_TIMEOUT_MS if the server is just slow to start.`
    );
  }

  return (
    `OpenTopography request timed out after ${Math.round(timeoutMs / 1000)} seconds ` +
    `(${formatBytes(bytes)} received). Try COP90 first, or rerun with a higher DEM_FETCH_TIMEOUT_MS value.`
  );
}

async function savePartial(buffer) {
  if (!buffer.length) {
    return;
  }

  const partialPath = path.join(OUTPUT_DIR, 'chonburi-dem.partial');
  await writeFile(partialPath, buffer);
  console.error(`Kept the incomplete download at ${partialPath} for inspection.`);
  console.error('Existing DEM files and the manifest were left untouched.');
}

// A short AAIGrid body still parses far enough to look valid, so compare the declared
// grid size against the rows that actually arrived.
function describeGridShortfall(format, buffer) {
  if (format !== 'AAIGrid' || buffer[0] === 0x50) {
    return '';
  }

  const text = buffer.toString('utf8');
  const declaredRows = Number(/^nrows\s+(\d+)/im.exec(text)?.[1] || 0);
  if (!declaredRows) {
    return '';
  }

  const headerEnd = text.search(/^\s*[-\d]/m);
  const dataRows = text.slice(headerEnd).trimEnd().split(/\r?\n/).length;

  if (dataRows >= declaredRows) {
    return '';
  }

  return (
    `Truncated grid: the header declares ${declaredRows} rows but only ${dataRows} arrived ` +
    `(${((dataRows / declaredRows) * 100).toFixed(1)}% of the area, measured from the north edge).`
  );
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  return `${Math.round(bytes)} B`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return '--:--';
  }

  const totalSeconds = Math.max(Math.round(milliseconds / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getEnvValue(name) {
  if (process.env[name]) {
    return process.env[name];
  }

  const envFiles = ['.env.local', '.env'];
  for (const fileName of envFiles) {
    const filePath = path.join(PROJECT_ROOT, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const envValues = parseEnvFile(readFileSync(filePath, 'utf8'));
    if (envValues[name]) {
      return envValues[name];
    }
  }

  return '';
}

function parseEnvFile(contents) {
  const result = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/, '$1');
    result[key] = value;
  }

  return result;
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

function inferResolutionMeters(datasetName) {
  switch (datasetName) {
    case 'COP30':
    case 'NASADEM':
    case 'SRTM_GL1':
    case 'AW3D30':
      return 30;
    case 'COP90':
    case 'SRTM_GL3':
      return 90;
    default:
      return 30;
  }
}

function getDEMFileName(format, buffer) {
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return 'chonburi-dem.zip';
  }

  if (format === 'GTiff') {
    return 'chonburi-dem.tif';
  }

  if (format === 'AAIGrid') {
    return 'chonburi-dem.asc';
  }

  return 'chonburi-dem.dat';
}
