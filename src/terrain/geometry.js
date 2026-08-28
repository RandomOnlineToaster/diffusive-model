// Small planar geometry on [lat, lng] points and GeoJSON polygons.

export function pointDistance(start, end) {
  return Math.hypot(end[0] - start[0], end[1] - start[1]);
}

export function polylineLength(points) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += pointDistance(points[index], points[index + 1]);
  }
  return length;
}

/** Point-in-feature for a Feature, FeatureCollection, Polygon or MultiPolygon. */
export function isPointInsideFeature(point, feature) {
  if (feature?.type === 'FeatureCollection') {
    return feature.features.some((item) => isPointInsideFeature(point, item));
  }

  if (!feature?.geometry) {
    return false;
  }

  if (feature.geometry.type === 'Polygon') {
    return isPointInsidePolygon(point, feature.geometry.coordinates);
  }

  if (feature.geometry.type === 'MultiPolygon') {
    return feature.geometry.coordinates.some((polygon) => isPointInsidePolygon(point, polygon));
  }

  return false;
}

/** Inside the exterior ring and outside every hole. */
export function isPointInsidePolygon(point, polygonCoordinates) {
  const [lat, lng] = point;
  const exteriorRing = polygonCoordinates[0] || [];

  if (!isPointInsideRing(lat, lng, exteriorRing)) {
    return false;
  }

  for (let index = 1; index < polygonCoordinates.length; index += 1) {
    if (isPointInsideRing(lat, lng, polygonCoordinates[index])) {
      return false;
    }
  }

  return true;
}

/** Ray casting over a GeoJSON ring ([lng, lat] pairs). */
export function isPointInsideRing(lat, lng, ring) {
  let inside = false;

  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [currentLng, currentLat] = ring[current];
    const [previousLng, previousLat] = ring[previous];
    const intersects =
      currentLat > lat !== previousLat > lat &&
      lng < ((previousLng - currentLng) * (lat - currentLat)) / (previousLat - currentLat) + currentLng;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}
