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
/**
 * Where each storm has been and where it is going.
 *
 * A cell that drifts leaves the map in a couple of hours - at 9 m/s it is
 * 30 km on in an hour - and once the outcome bar jumps to hour five, a storm
 * whose card is still in the panel is nowhere on screen. The track says
 * where it went: a solid line back to where it was placed, a dashed one
 * ahead of it with an arrow, and a translucent ghost of the rain area at a
 * few times to come, each labelled with its hour. It is the same idea as a
 * cyclone forecast track.
 *
 * Only storms that actually move get a track; a parked cell has nowhere to
 * be but where it is.
 */
export function createStormTrackLayer({ grid, stormSystem, onChange }) {
  // Lines and ghosts apart from the drag handles: while the tip is being
  // dragged the shapes are redrawn to follow it, and the handle itself must
  // not be torn out from under the pointer.
  const shapes = L.layerGroup();
  const tips = L.layerGroup();
  const layer = L.layerGroup([shapes, tips]);
  const MIN_SPEED_MS = 0.1;
  // Ghosts at these fractions of the horizon, so a track carries three
  // previews however far ahead it looks.
  const GHOSTS = [1 / 3, 2 / 3, 1];
  // A ghost is drawn as rings at these multiples of sigma (and at the rain
  // edge), each a little more opaque than the one outside it. A single flat
  // disc said where the cell would be but nothing about the shape of it -
  // and out beyond the rain grid, where the field cannot be painted, the
  // rings are the only thing that shows the falloff at all.
  const GHOST_RINGS = [
    { sigmas: Infinity, alpha: 0.05 },
    { sigmas: 2, alpha: 0.07 },
    { sigmas: 1, alpha: 0.1 },
    { sigmas: 0.5, alpha: 0.12 }
  ];
  let horizonSeconds = 2 * 3600;
  let draggingTip = false;
  // Ghosts belong to choosing an hour, not to watching a storm run: they
  // are on while the outcome bar is being aimed and off once it has been
  // gone to, when they would only clutter the water.
  let previewing = false;

  // Nothing is drawn beyond this box. A cell drifting at 9 m/s is 1,300 km
  // away after a two-day forecast span, and a polyline that long - with a
  // ghost of a 14 km rain area on the end of it - is real work for Leaflet
  // on every redraw, for a storm nobody can see. The track is clipped to the
  // study area with a margin, so what is drawn is always about a screen's
  // worth of it.
  const worldWidth = grid.columns * grid.cellWidthMeters;
  const worldHeight = grid.rows * grid.cellHeightMeters;
  const box = {
    minX: -0.25 * worldWidth,
    maxX: 1.25 * worldWidth,
    minY: -0.25 * worldHeight,
    maxY: 1.25 * worldHeight
  };

  function localAt(storm, seconds) {
    return {
      x: storm.x + storm.velocityEastMs * seconds,
      y: storm.y + storm.velocityNorthMs * seconds
    };
  }

  function positionAt(storm, seconds) {
    const { x, y } = localAt(storm, seconds);
    const { lat, lng } = grid.toLatLng(x, y);
    return L.latLng(lat, lng);
  }

  const inside = (x, y) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;

  /**
   * The part of a straight run between two times that lies in the box, as a
   * time range, or null when none of it does (Liang-Barsky).
   */
  function clipRun(storm, fromSeconds, toSeconds) {
    const a = localAt(storm, fromSeconds);
    const b = localAt(storm, toSeconds);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;

    const edges = [
      [-dx, a.x - box.minX],
      [dx, box.maxX - a.x],
      [-dy, a.y - box.minY],
      [dy, box.maxY - a.y]
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) {
          return null;
        }
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) {
          return null;
        }
        if (r > t0) {
          t0 = r;
        }
      } else {
        if (r < t0) {
          return null;
        }
        if (r < t1) {
          t1 = r;
        }
      }
    }

    const span = toSeconds - fromSeconds;
    return [fromSeconds + t0 * span, fromSeconds + t1 * span];
  }

  function clockText(seconds) {
    const total = Math.round(seconds / 60);
    return `+${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /** An arrowhead at the end of the track, as one polyline. */
  function arrowAt(tip, bearingRad, sizeMeters) {
    const wing = (offset) => {
      const angle = bearingRad + offset;
      return positionOffset(tip, Math.sin(angle) * sizeMeters, Math.cos(angle) * sizeMeters);
    };
    return L.polyline([wing(Math.PI * 0.82), tip, wing(-Math.PI * 0.82)], {
      color: '#1d4ed8',
      weight: 2,
      opacity: 0.9,
      interactive: false
    });
  }

  function positionOffset(latlng, east, north) {
    const lat = latlng.lat + north / 110574;
    const lng = latlng.lng + east / (111320 * Math.cos((latlng.lat * Math.PI) / 180));
    return L.latLng(lat, lng);
  }

  function drawStorm(storm) {
    const speed = Math.hypot(storm.velocityEastMs, storm.velocityNorthMs);
    if (speed < MIN_SPEED_MS) {
      return;
    }

    // Where it has been, if it has been anywhere: a thin solid line back to
    // where it was placed. This is what stays on screen when the storm
    // itself has drifted off it.
    if (storm.ageSeconds > 0) {
      const past = clipRun(storm, -storm.ageSeconds, 0);
      if (past) {
        shapes.addLayer(
          L.polyline([positionAt(storm, past[0]), positionAt(storm, past[1])], {
            color: '#1d4ed8',
            weight: 1.4,
            opacity: 0.45,
            interactive: false
          })
        );
      }
    }

    const ahead = clipRun(storm, 0, horizonSeconds);
    if (ahead) {
      shapes.addLayer(
        L.polyline([positionAt(storm, ahead[0]), positionAt(storm, ahead[1])], {
          color: '#1d4ed8',
          weight: 1.6,
          opacity: 0.7,
          dashArray: '7 6',
          interactive: false
        })
      );
      // The arrowhead belongs on the end of the run, not on the edge of the
      // box the line was cut at.
      if (ahead[1] >= horizonSeconds - 1) {
        shapes.addLayer(
          arrowAt(
            positionAt(storm, horizonSeconds),
            Math.atan2(storm.velocityEastMs, storm.velocityNorthMs),
            Math.max(600, speed * 260)
          )
        );
      }
    }

    for (const fraction of previewing ? GHOSTS : []) {
      const seconds = horizonSeconds * fraction;
      const at = localAt(storm, seconds);
      if (!inside(at.x, at.y)) {
        continue;
      }
      const centre = positionAt(storm, seconds);

      // Rings from the rain edge inwards, each a shade denser: the same
      // Gaussian the cell rains by, read as bands of sigma.
      let previous = Infinity;
      for (const ring of GHOST_RINGS) {
        const radius = Math.min(storm.rainRadiusMeters, ring.sigmas * storm.sigmaMeters);
        if (!(radius > 0) || radius >= previous) {
          continue;
        }
        previous = radius;
        const edge = radius === storm.rainRadiusMeters;
        shapes.addLayer(
          L.circle(centre, {
            radius,
            color: '#2563eb',
            weight: edge ? 1 : 0,
            stroke: edge,
            opacity: 0.3 + fraction * 0.2,
            dashArray: '3 4',
            fillColor: '#2563eb',
            fillOpacity: ring.alpha * (0.6 + fraction * 0.4),
            interactive: false
          })
        );
      }

      shapes.addLayer(
        L.marker(centre, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'storm-track-label',
            html: `<span>${clockText(seconds)}</span>`,
            iconSize: [44, 14],
            iconAnchor: [22, 7]
          })
        })
      );
    }

    // The tip is a handle: drag it to say where the cell should be by the
    // horizon, and its speed and bearing follow from that. Aiming a storm
    // at a district is the thing people actually want to do, and doing it
    // on two sliders is guesswork.
    const tipLocal = localAt(storm, horizonSeconds);
    if (draggingTip || !inside(tipLocal.x, tipLocal.y)) {
      return;
    }

    const tipMarker = L.marker(positionAt(storm, horizonSeconds), {
      draggable: true,
      keyboard: false,
      icon: L.divIcon({
        className: 'storm-tip',
        html: '<span></span>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      })
    });
    tipMarker.bindTooltip(`Drag to aim: where this cell is at ${clockText(horizonSeconds)}`, {
      direction: 'top',
      offset: [0, -8]
    });
    tipMarker.on('dragstart', () => {
      draggingTip = true;
    });
    tipMarker.on('drag', () => {
      const target = grid.toLocal(tipMarker.getLatLng().lat, tipMarker.getLatLng().lng);
      storm.velocityEastMs = (target.x - storm.x) / horizonSeconds;
      storm.velocityNorthMs = (target.y - storm.y) / horizonSeconds;
      // The bearing sliders read this back from the vector.
      storm.headingDegrees = undefined;
      onChange?.(storm);
    });
    tipMarker.on('dragend', () => {
      draggingTip = false;
      update();
    });
    tips.addLayer(tipMarker);
  }

  function update() {
    shapes.clearLayers();
    // The handles are left alone mid-drag; the lines and ghosts still follow
    // the pointer, which is the feedback that makes aiming work.
    if (!draggingTip) {
      tips.clearLayers();
    }
    for (const storm of stormSystem.storms) {
      drawStorm(storm);
    }
  }

  return {
    layer,

    /**
     * Show the ghosts of where each cell will be, or just its line and
     * arrow. On while an hour is being picked on the outcome bar; off once
     * the map is showing that hour, where they would sit on top of the very
     * water they predicted.
     */
    setPreview(flag) {
      const next = Boolean(flag);
      if (next !== previewing) {
        previewing = next;
        update();
      }
    },

    get previewing() {
      return previewing;
    },

    /** How far ahead the track looks, in simulated seconds. */
    setHorizon(seconds) {
      const next = Math.max(600, Math.min(24 * 3600, seconds || 0));
      if (next !== horizonSeconds) {
        horizonSeconds = next;
        update();
      }
    },

    get horizonSeconds() {
      return horizonSeconds;
    },

    /** Redraw every track from the storms as they now stand. */
    update
  };
}

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

  // The rain field is painted on a canvas the size of the rain grid, so a
  // cell dragged out past the study area loses its heatmap and reads as a
  // flat disc - exactly where you most want to see what it is, because its
  // rain is not being simulated either. These rings stand in for the field
  // out there: the same bands of sigma the track's ghosts use.
  const SIGMA_RINGS = [
    { sigmas: 2, alpha: 0.07 },
    { sigmas: 1, alpha: 0.1 },
    { sigmas: 0.5, alpha: 0.12 }
  ];

  /** True while the rain grid covers this storm's centre and can paint it. */
  function fieldCovers(storm) {
    const { lat, lng } = grid.toLatLng(storm.x, storm.y);
    return grid.indexAt(lat, lng) >= 0;
  }

  function build(storm) {
    const centre = positionOf(storm);

    // Under everything else, so the rain outline and the handles stay on top.
    const rings = SIGMA_RINGS.map((ring) =>
      L.circle(centre, {
        radius: Math.min(storm.rainRadiusMeters, ring.sigmas * storm.sigmaMeters),
        stroke: false,
        fillColor: '#2563eb',
        fillOpacity: 0,
        interactive: false
      })
    );

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

    const handles = { rings, cloud, rain, centreMarker, grip };
    handlesByStorm.set(storm.id, handles);
    for (const ring of rings) {
      layer.addLayer(ring);
    }
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

    // The rings only show where the field cannot: inside the grid they would
    // be a blue haze over the heatmap that is already there.
    const painted = fieldCovers(storm);
    let previous = Infinity;
    handles.rings.forEach((ring, index) => {
      const radius = Math.min(storm.rainRadiusMeters, SIGMA_RINGS[index].sigmas * storm.sigmaMeters);
      const shown = !painted && radius > 0 && radius < previous;
      if (radius > 0) {
        ring.setLatLng(centre).setRadius(radius);
      }
      ring.setStyle({ fillOpacity: shown ? SIGMA_RINGS[index].alpha : 0 });
      if (shown) {
        previous = radius;
      }
    });

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
          for (const handle of Object.values(handles).flat()) {
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
