// Leaflet renders layer names as HTML, so a layer's state can be marked with
// a class rather than a suffix cluttering the control.

/** Red: the layer is running on demo geometry. */
export function placeholderLabel(text) {
  return `<span class="layer-placeholder">${text}</span>`;
}

/** Yellow: real data, still being worked on. */
export function wipLabel(text) {
  return `<span class="layer-wip">${text}</span>`;
}
