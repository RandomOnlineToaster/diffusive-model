import L from 'leaflet';

// One look for every clickable thing on the map. A marker - pump station,
// sensor, water gate, rain gauge, drainage cover - answers a hover with a
// small name tip and a pointer cursor, and a click with the same detail card:
// a title, an optional sub-line, a label/value table, and a source line.
// The pump-station card set the format; the others follow it through these
// helpers rather than each carrying its own markup.

export const POPUP_OPTIONS = { maxWidth: 300, className: 'detail-popup' };

// Markers rise over their neighbours on hover so the one under the cursor is
// the one that opens; none take keyboard focus (there are thousands).
export const MARKER_OPTIONS = { riseOnHover: true, keyboard: false };

const TIP_OPTIONS = { direction: 'top', className: 'map-tip', opacity: 1 };

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** One table row; a null or undefined value drops the row. */
export function row(label, value) {
  return value === null || value === undefined || value === ''
    ? ''
    : `<tr><td>${label}</td><td>${value}</td></tr>`;
}

/** A quieter aside beside a value: the Thai original, a unit's source. */
export function aside(text) {
  return `<span class="detail-aside">${escapeHtml(text)}</span>`;
}

/**
 * The detail card. `rows` is a list of [label, value] pairs (value may be
 * HTML; pass text through escapeHtml first) or a string of ready rows.
 */
export function detailPopup({ title, subtitle = null, rows = [], source = null }) {
  const body = Array.isArray(rows) ? rows.map(([label, value]) => row(label, value)).join('') : rows;
  return (
    `<strong>${escapeHtml(title)}</strong>` +
    (subtitle ? `<div class="detail-sub">${subtitle}</div>` : '') +
    (body ? `<table class="drain-detail"><tbody>${body}</tbody></table>` : '') +
    (source ? `<small>${source}</small>` : '')
  );
}

/**
 * The hover tip: a name above the marker. `offsetY` lifts it clear of a tall
 * icon; lines use `sticky` so the tip follows the cursor along the run.
 */
export function bindHoverTip(layer, text, { offsetY = -10, sticky = false } = {}) {
  return layer.bindTooltip(text, { ...TIP_OPTIONS, sticky, offset: sticky ? [0, 0] : [0, offsetY] });
}

/**
 * The same tip for things drawn straight onto a canvas, where there is no
 * layer to bind to: one tooltip moved to whatever is under the cursor, and
 * the pointer cursor set on the map while it is over something.
 */
export function createCanvasHoverTip(map) {
  const tip = L.tooltip({ ...TIP_OPTIONS, offset: [0, -8] });
  let shownFor = null;
  return {
    show(key, latlng, text) {
      if (shownFor === key) {
        return;
      }
      shownFor = key;
      tip.setLatLng(latlng).setContent(text);
      if (!map.hasLayer(tip)) {
        tip.addTo(map);
      }
      L.DomUtil.addClass(map.getContainer(), 'canvas-hover');
    },
    hide() {
      if (shownFor === null) {
        return;
      }
      shownFor = null;
      if (map.hasLayer(tip)) {
        map.removeLayer(tip);
      }
      L.DomUtil.removeClass(map.getContainer(), 'canvas-hover');
    }
  };
}
