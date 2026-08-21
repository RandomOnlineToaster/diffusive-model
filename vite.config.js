import { defineConfig } from 'vite';

// The Thai Meteorological Department allows only its own site in CORS
// (access-control-allow-origin: https://wxmap.tmd.go.th), so the browser
// cannot call it directly. The dev and preview servers proxy it instead;
// weather.js requests the /tmd path and never sees the difference.
//
// A static production deploy has no proxy, so the forecast layer reports
// itself unavailable rather than failing silently.
const tmdProxy = {
  '/tmd': {
    target: 'https://data.tmd.go.th',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/tmd/, '')
  }
};

export default defineConfig({
  server: { proxy: tmdProxy },
  preview: { proxy: tmdProxy }
});
