import L from 'leaflet';
import { config } from '../config.js';

// Cloud cover: JAXA GSMaP satellite tiles (infrared cloud tops).
//
// GSMaP serves ordinary XYZ tiles with a TMS-style Y, which Leaflet fills in
// through the {-y} placeholder, so the URL templates below are the same ones
// the JAXA viewer uses.

const GSMAP_TILES = 'https://sharaku.eorc.jaxa.jp/cgi-bin/trmm/GSMaP/tilemap';

// GSMaP grids are 0.1 degrees, roughly 11 km. The server will happily upscale
// far past that; capping the native zoom keeps requests honest and lets
// Leaflet do the stretching once the tiles stop carrying new detail.
const GSMAP_MAX_NATIVE_ZOOM = 8;

const ATTRIBUTION_GSMAP =
  '<a href="https://sharaku.eorc.jaxa.jp/GSMaP/">JAXA GSMaP</a>';
const ATTRIBUTION_TMD = '<a href="https://data.tmd.go.th/">Thai Meteorological Department</a>';

/**
 * The most recent GSMaP frame that is likely to exist.
 *
 * The product is hourly and lands a few hours behind real time, so asking for
 * "now" only ever returns empty tiles. The lag is a setting because JAXA's
 * own latest-frame marker is not readable from the browser (no CORS header).
 */
export function latestGsmapFrame(now = new Date()) {
  const stamp = new Date(now.getTime() - config.gsmapLatencyHours * 3600 * 1000);
  return {
    year: stamp.getUTCFullYear(),
    month: String(stamp.getUTCMonth() + 1).padStart(2, '0'),
    day: String(stamp.getUTCDate()).padStart(2, '0'),
    hour: String(stamp.getUTCHours()).padStart(2, '0'),
    minute: '00',
    date: stamp
  };
}

function gsmapUrl(script, product, frame) {
  return (
    `${GSMAP_TILES}/${script}?prod=${product}` +
    `&year=${frame.year}&month=${frame.month}&day=${frame.day}` +
    `&hour=${frame.hour}&min=${frame.minute}` +
    '&z={z}&x={x}&y={-y}'
  );
}

/**
 * Infrared cloud-top imagery: where the cloud is, rain or not.
 *
 * Bounded to the study area. GSMaP tiles are global, and without a bound
 * Leaflet fetches and paints them across the whole visible world - a lot of
 * requests and a lot of compositing for cloud nobody is looking at.
 */
export function createCloudLayer({ bounds } = {}) {
  const frame = latestGsmapFrame();

  // The tiles are white clouds over alpha; on a light basemap that is
  // invisible. The wx-cloud class inverts them, so cloud reads as grey
  // shading whose darkness is the cloud thickness.
  const layer = L.tileLayer(gsmapUrl('gsmap_tile_ir.py', 'ir', frame), {
    className: 'wx-cloud',
    opacity: config.cloudLayerOpacity,
    maxNativeZoom: GSMAP_MAX_NATIVE_ZOOM,
    attribution: ATTRIBUTION_GSMAP,
    bounds: bounds
      ? L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east])
      : undefined,
    // Blank ocean/edge tiles are normal here; a missing tile must not leave a
    // broken-image box on the map.
    errorTileUrl:
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  });

  return {
    layer,
    label: 'Cloud Cover',
    frame,

    /**
     * Soften the 0.1-degree squares by however many pixels one covers at this
     * zoom. The blur lives on the layer container, never per tile, so the
     * mosaic smooths as one image without seams at the tile joins.
     */
    updateBlur(zoom) {
      const cellPx = (Math.pow(2, zoom) * 256) / 3600;
      const blur = Math.min(9, Math.max(1, cellPx / 5));
      document.documentElement.style.setProperty('--wx-blur', blur.toFixed(1) + 'px');
    }
  };
}
