import L from 'leaflet';
import { isPointInsideFeature, pointDistance, polylineLength } from './geometry.js';

// The elevation contours as polylines clipped to the province, with a level
// label riding the middle of the longer lines.

export function createContourLayer(contourLines, boundaryFeature) {
  const clippedLines = contourLines.flatMap((line) => clipContourLineToBoundary(line, boundaryFeature));
  const contourPaths = clippedLines.map((segment) =>
    L.polyline(segment.points, {
      color: '#5b3a29',
      weight: 1.15,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }).bindTooltip(`${segment.level} m contour`, { sticky: true })
  );
  const contourLabels = createContourLabels(clippedLines);

  return L.layerGroup([...contourPaths, ...contourLabels]);
}

function createContourLabels(contourLines) {
  const labelsByLevel = new Map();

  return contourLines
    .filter((line) => line.points.length >= 8 && polylineLength(line.points) > 0.025)
    .filter((line) => {
      const labelCount = labelsByLevel.get(line.level) || 0;
      if (labelCount >= 8) {
        return false;
      }

      labelsByLevel.set(line.level, labelCount + 1);
      return true;
    })
    .map((line) => {
      const { point, angle } = contourLabelPlacement(line.points);

      return L.marker(point, {
        interactive: false,
        icon: L.divIcon({
          className: 'contour-label',
          html: `<span style="--angle: ${angle}deg">${line.level}</span>`,
          iconSize: [34, 16],
          iconAnchor: [17, 8]
        })
      });
    });
}

// Halfway along the line, turned to follow it.
function contourLabelPlacement(points) {
  const totalLength = polylineLength(points);
  const targetLength = totalLength / 2;
  let travelled = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const segmentLength = pointDistance(start, end);

    if (travelled + segmentLength >= targetLength) {
      const ratio = segmentLength === 0 ? 0 : (targetLength - travelled) / segmentLength;
      const point = [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
      const dx = end[1] - start[1];
      const dy = end[0] - start[0];

      return {
        point,
        angle: normalizeLabelAngle(Math.atan2(dy, dx) * (180 / Math.PI))
      };
    }

    travelled += segmentLength;
  }

  return {
    point: points[Math.floor(points.length / 2)],
    angle: 0
  };
}

function normalizeLabelAngle(angle) {
  let normalized = angle;
  if (normalized > 90) {
    normalized -= 180;
  }
  if (normalized < -90) {
    normalized += 180;
  }
  return Number(normalized.toFixed(1));
}

// Keep the runs of a line whose segments lie inside the boundary, splitting
// where it crosses out and back.
function clipContourLineToBoundary(line, boundaryFeature) {
  const clippedLines = [];
  let activePoints = [];

  for (let index = 0; index < line.points.length - 1; index += 1) {
    const segment = [line.points[index], line.points[index + 1]];

    if (isSegmentInsideBoundary(segment, boundaryFeature)) {
      if (activePoints.length === 0) {
        activePoints.push(...segment);
      } else {
        activePoints.push(segment[1]);
      }
    } else if (activePoints.length > 1) {
      clippedLines.push({ level: line.level, points: activePoints });
      activePoints = [];
    } else {
      activePoints = [];
    }
  }

  if (activePoints.length > 1) {
    clippedLines.push({ level: line.level, points: activePoints });
  }

  return clippedLines;
}

function isSegmentInsideBoundary([start, end], boundaryFeature) {
  const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  return isPointInsideFeature(midpoint, boundaryFeature);
}
