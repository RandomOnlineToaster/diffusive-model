import L from 'leaflet';
import { config } from './config.js';

// Base map choices.
//
// The standard OpenStreetMap style draws every road, building and POI, which
// competes with the overlays (contours, flow arrows, rivers). "Light" is the
// quiet alternative: muted greys that keep place names without the clutter.
//
// maxNativeZoom stops tiles going blank past a provider's deepest zoom: Leaflet
// upscales the last real tile instead, so the map still zooms to MAX_ZOOM.

export const MAX_ZOOM = 19;

const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors';
const ESRI_ATTRIBUTION = 'Tiles &copy; Esri';
const ESRI_CANVAS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ESRI_LIGHT_GRAY_MAX_NATIVE = 16;

// The quiet grey "Light" basemap, from whichever provider is set up.
//
// CARTO's Positron is the first choice - sharp to zoom 20, grey with clean
// labels - but in 2025 CARTO began stamping "API KEY REQUIRED" across every
// keyless tile. With a key (VITE_CARTO_KEY in .env.local; a basemap key is
// meant to live in the client, restricted by domain at carto.com) the
// watermark clears. Without one, Esri's Light Gray Canvas stands in: also
// grey and keyless, though its own service only tiles to zoom 16 and its
// labels ride a separate layer, so they are stacked here with labels on top.
function createLightBasemap() {
  if (config.cartoBasemapKey) {
    return L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${config.cartoBasemapKey}`,
      {
        maxZoom: MAX_ZOOM,
        maxNativeZoom: 19,
        subdomains: 'abcd',
        attribution: `${OSM_ATTRIBUTION} &copy; CARTO`
      }
    );
  }

  return L.layerGroup([
    L.tileLayer(`${ESRI_CANVAS}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: MAX_ZOOM,
      maxNativeZoom: ESRI_LIGHT_GRAY_MAX_NATIVE,
      attribution: ESRI_ATTRIBUTION
    }),
    // Labels, drawn over the base. Added second so it sits on top.
    L.tileLayer(`${ESRI_CANVAS}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: MAX_ZOOM,
      maxNativeZoom: ESRI_LIGHT_GRAY_MAX_NATIVE
    })
  ]);
}

export function createBaseMaps() {
  return {
    // Muted greys with light labelling; keeps place names without the clutter.
    'Light': createLightBasemap(),

    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: MAX_ZOOM,
      maxNativeZoom: 19,
      subdomains: 'abc',
      attribution: OSM_ATTRIBUTION
    }),

    'Satellite': L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: MAX_ZOOM,
        maxNativeZoom: 19,
        attribution: 'Tiles &copy; Esri'
      }
    )
  };
}
