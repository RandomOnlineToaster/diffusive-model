// Map rendering for the rainfall simulator.
//
// Two parts:
//   1. a canvas layer painting the intensity field across the grid, and
//   2. draggable handles per storm -- a cloud ring, a rain ring, and a centre
//      marker -- so storms can be placed, moved and resized on the map.
//
// The field is drawn by scaling one small offscreen canvas (grid resolution)
// onto the viewport, so a 400x400 grid costs a single drawImage per frame
// rather than 160,000 shapes.

import L from 'leaflet';

const RainfallField = L.Layer.extend({
  initialize(grid) {
    this._grid = grid;
  },

  onAdd(map) {
    this._map = map;

    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer leaflet-zoom-hide rainfall-field');
    this._context = this._canvas.getContext('2d');

    // Offscreen buffer at native grid resolution; the browser scales it.
    this._buffer = document.createElement('canvas');
    this._buffer.width = this._grid.columns;
    this._buffer.height = this._grid.rows;
    this._bufferContext = this._buffer.getContext('2d');
    this._image = this._bufferContext.createImageData(this._grid.columns, this._grid.rows);

    map.getPane('overlayPane').appendChild(this._canvas);
    map.on('moveend zoomend resize', this._reset, this);
    this._reset();
  },

  onRemove(map) {
    map.off('moveend zoomend resize', this._reset, this);
    this._canvas.remove();
  },

  /** Push new cell values into the offscreen buffer and repaint. */
  update(field, scale) {
    if (!this._map) {
      return;
    }

    this._image.data.set(this._grid.toPixels(field, scale));
    this._bufferContext.putImageData(this._image, 0, 0);
    this._draw();
  },

  _reset() {
    if (!this._map) {
      return;
    }

    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
    this._draw();
  },

  _draw() {
    const { bounds } = this._grid;
    const northWest = this._map.latLngToContainerPoint([bounds.north, bounds.west]);
    const southEast = this._map.latLngToContainerPoint([bounds.south, bounds.east]);

    this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
    this._context.drawImage(
      this._buffer,
      northWest.x,
      northWest.y,
      southEast.x - northWest.x,
      southEast.y - northWest.y
    );
  }
});

export function createRainfallField(grid) {
  return new RainfallField(grid);
}

// Storm handles: the editable part. Each storm gets a dashed cloud ring, a
// solid rain ring, a draggable centre, and a radius grip on the rain ring that
// resizes the storm by dragging.
export function createStormHandles({ grid, stormSystem, onChange, onSelect }) {
  const layer = L.layerGroup();
  const handlesByStorm = new Map();
  let selectedId = null;

  function positionOf(storm) {
    const { lat, lng } = grid.toLatLng(storm.x, storm.y);
    return L.latLng(lat, lng);
  }

  // The grip sits due east of the centre, at the rain radius.
  function gripPositionOf(storm) {
    const { lat, lng } = grid.toLatLng(storm.x + storm.rainRadiusMeters, storm.y);
    return L.latLng(lat, lng);
  }

  function build(storm) {
    const centre = positionOf(storm);

    const cloud = L.circle(centre, {
      radius: storm.cloudRadiusMeters,
      color: '#64748b',
      weight: 1.2,
      dashArray: '6 6',
      fill: false,
      interactive: false
    });

    // Not interactive: the filled disc would swallow every click inside the
    // storm, blocking the map's sample-point popup exactly where people most
    // want to probe. Selecting a storm is the centre marker's job.
    const rain = L.circle(centre, {
      radius: storm.rainRadiusMeters,
      color: '#2563eb',
      weight: 1.6,
      fillColor: '#2563eb',
      fillOpacity: 0.05,
      interactive: false
    });

    const centreMarker = L.marker(centre, {
      draggable: true,
      keyboard: false,
      icon: L.divIcon({ className: 'storm-centre', html: '<span></span>', iconSize: [16, 16], iconAnchor: [8, 8] })
    });

    const grip = L.marker(gripPositionOf(storm), {
      draggable: true,
      keyboard: false,
      icon: L.divIcon({ className: 'storm-grip', html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] })
    });

    centreMarker.on('drag', () => {
      const local = grid.toLocal(centreMarker.getLatLng().lat, centreMarker.getLatLng().lng);
      storm.x = local.x;
      storm.y = local.y;
      sync(storm);
      onChange?.(storm);
    });

    // Dragging the grip sets the rain radius from its distance to the centre;
    // the cloud keeps its proportion so it stays the larger of the two.
    grip.on('drag', () => {
      const ratio = storm.cloudRadiusMeters / storm.rainRadiusMeters;
      const distance = positionOf(storm).distanceTo(grip.getLatLng());
      storm.rainRadiusMeters = Math.max(200, distance);
      storm.cloudRadiusMeters = storm.rainRadiusMeters * Math.max(1.05, ratio);
      sync(storm);
      onChange?.(storm);
    });

    centreMarker.on('click', (event) => {
      L.DomEvent.stop(event);
      onSelect?.(storm.id);
    });

    const handles = { cloud, rain, centreMarker, grip };
    handlesByStorm.set(storm.id, handles);
    layer.addLayer(cloud).addLayer(rain).addLayer(centreMarker).addLayer(grip);
    return handles;
  }

  function sync(storm) {
    const handles = handlesByStorm.get(storm.id);
    if (!handles) {
      return;
    }

    const centre = positionOf(storm);
    handles.cloud.setLatLng(centre).setRadius(storm.cloudRadiusMeters);
    handles.rain.setLatLng(centre).setRadius(storm.rainRadiusMeters);

    if (!handles.centreMarker.dragging?._draggable?._moving) {
      handles.centreMarker.setLatLng(centre);
    }

    if (!handles.grip.dragging?._draggable?._moving) {
      handles.grip.setLatLng(gripPositionOf(storm));
    }

    const selected = storm.id === selectedId;
    handles.rain.setStyle({ weight: selected ? 2.6 : 1.6, fillOpacity: selected ? 0.1 : 0.05 });
    const element = handles.centreMarker.getElement();
    if (element) {
      element.classList.toggle('storm-centre--selected', selected);
    }
  }

  return {
    layer,

    setSelected(id) {
      selectedId = id;
      for (const storm of stormSystem.storms) {
        sync(storm);
      }
    },

    /** Rebuild handles for new storms, drop them for removed ones, sync the rest. */
    refresh() {
      const live = new Set(stormSystem.storms.map((storm) => storm.id));

      for (const [id, handles] of handlesByStorm) {
        if (!live.has(id)) {
          for (const handle of Object.values(handles)) {
            layer.removeLayer(handle);
          }
          handlesByStorm.delete(id);
        }
      }

      for (const storm of stormSystem.storms) {
        if (!handlesByStorm.has(storm.id)) {
          build(storm);
        }
        sync(storm);
      }
    }
  };
}
