import L from 'leaflet';

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

export function createBaseMaps() {
  return {
    // Muted greys with light labelling; keeps place names without the clutter.
    'Light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: MAX_ZOOM,
      maxNativeZoom: 19,
      subdomains: 'abcd',
      attribution: `${OSM_ATTRIBUTION} &copy; CARTO`
    }),

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
