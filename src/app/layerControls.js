import L from 'leaflet';

// The layer-control furniture: titles over each stacked control, hover hints
// on particular rows, equal widths, and the small bottom-left controls.

export { placeholderLabel, wipLabel } from '../layers/labels.js';

// Each control otherwise sizes to its own longest label, so the stacked
// groups end up different widths. Measure them once laid out and take the
// widest.
export function matchLayerControlWidths() {
  requestAnimationFrame(() => {
    const controls = [...document.querySelectorAll('.leaflet-control-layers')];
    if (controls.length < 2) {
      return;
    }

    for (const control of controls) {
      control.style.width = '';
    }

    const widest = Math.max(...controls.map((control) => control.offsetWidth));
    for (const control of controls) {
      control.style.width = `${widest}px`;
    }
  });
}

// Leaflet's layer control has no concept of groups, so several controls are
// stacked and each gets a title injected above its list.
export function labelLayerControl(control, title) {
  const container = control.getContainer();
  const heading = L.DomUtil.create('div', 'layer-control-title');
  heading.textContent = title;
  container.insertBefore(heading, container.firstChild);
}

// The three flow layers have a classic rendering (dashes, or arrows for Flow
// Direction) behind Shift + tick; say so on hover, or nobody would find it.
export function hintClassicToggle(control, layers) {
  const ids = new Set(layers.map((layer) => L.Util.stamp(layer)));
  for (const input of control._layerControlInputs || []) {
    if (ids.has(input.layerId)) {
      input.parentElement.title = 'Shift + click for the classic style';
    }
  }
}

// Say on hover what a row needs or shows, so a layer that only draws once
// zoomed in does not read as a broken toggle.
export function hintLayerToggle(control, layer, text) {
  const id = L.Util.stamp(layer);
  for (const input of control._layerControlInputs || []) {
    if (input.layerId === id) {
      // The whole row is a <label>; put the hover text there, not on the
      // inner wrapper, so it shows over the name as well as the checkbox.
      (input.closest('label') || input.parentElement).title = text;
    }
  }
}

export function createMouseCoordinatesControl() {
  const control = L.control({ position: 'bottomleft' });

  control.onAdd = () => {
    const container = L.DomUtil.create('div', 'mouse-coordinates');
    container.textContent = 'Lat: --, Lng: --';
    return container;
  };

  control.update = (latlng) => {
    control.getContainer().textContent = `Lat: ${latlng.lat.toFixed(5)}, Lng: ${latlng.lng.toFixed(5)}`;
  };

  return control;
}

// Leaflet closes popups when a new one opens, but allows one tooltip per
// layer to stay open at once. With elevation, contours, rivers and flow
// arrows stacked, that leaves several readouts on screen together.
export function keepOneTooltipOpen(map) {
  let openTooltip = null;
  map.on('tooltipopen', (event) => {
    if (openTooltip && openTooltip !== event.tooltip) {
      map.closeTooltip(openTooltip);
    }
    openTooltip = event.tooltip;
  });
  map.on('tooltipclose', (event) => {
    if (openTooltip === event.tooltip) {
      openTooltip = null;
    }
  });
}
