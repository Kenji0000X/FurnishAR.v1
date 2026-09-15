/**
 * Measurement mathematics for FurnishAR.
 *
 * Kept free of DOM and WebXR so every formula can be checked against known
 * values in tests/geometry.test.js. The panel asked for validation of accurate
 * area measurement; this module is where that accuracy is defined, and the
 * tests are where it is demonstrated.
 *
 * Conventions:
 *   - Points are WebXR world coordinates in METRES: { x, y, z }.
 *   - y is up, so a floor outline lives in the x/z plane.
 *   - Lengths are returned in metres, areas in square metres. The UI converts.
 */

/** Straight-line distance between two points, in metres. */
export function distance3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Distance ignoring height — the honest measure for a floor span. */
export function distanceOnFloor(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Area of the floor polygon described by the captured points, via the
 * shoelace formula on the x/z plane. The outline is treated as closed, so the
 * caller does not repeat the first point. Returns 0 for fewer than 3 points.
 *
 * Self-intersecting outlines (a "bowtie") are not valid rooms; isSimplePolygon
 * detects them so the UI can ask for a rescan rather than report a wrong area.
 */
export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += (current.x * next.z) - (next.x * current.z);
  }
  return Math.abs(sum) / 2;
}

/** Total length of the closed outline, in metres. */
export function perimeter(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += distanceOnFloor(points[i], points[(i + 1) % points.length]);
  }
  return total;
}

/** True when no two non-adjacent edges of the closed outline cross. */
export function isSimplePolygon(points) {
  if (!Array.isArray(points) || points.length < 4) return true;
  const count = points.length;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      // Skip edges that share a vertex.
      if (j === i || (j + 1) % count === i || (i + 1) % count === j) continue;
      if (segmentsIntersect(points[i], points[(i + 1) % count], points[j], points[(j + 1) % count])) {
        return false;
      }
    }
  }
  return true;
}

function orientation(a, b, c) {
  const value = (b.z - a.z) * (c.x - b.x) - (b.x - a.x) * (c.z - b.z);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  return o1 !== o2 && o3 !== o4;
}

/**
 * How flat the captured points are, as the root-mean-square deviation from
 * their mean height, in metres.
 *
 * A floor outline should be nearly planar. A large value means the phone lost
 * tracking or the taps landed on furniture rather than the floor, which is the
 * main way an AR area measurement goes wrong without looking wrong.
 */
export function planarityRms(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const mean = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const variance = points.reduce((sum, point) => sum + (point.y - mean) ** 2, 0) / points.length;
  return Math.sqrt(variance);
}

/** Percentage difference between two readings, relative to the first. */
export function percentDifference(first, second) {
  if (!first) return 0;
  return Math.abs(first - second) / Math.abs(first) * 100;
}

/**
 * The panel's rule, in one place: two independent scans of the same thing are
 * accepted when they agree within `tolerance` percent, and the accepted value
 * is their mean.
 */
export function reconcileReadings(first, second, tolerance = 5) {
  const difference = percentDifference(first, second);
  return {
    agrees: difference <= tolerance,
    difference,
    tolerance,
    value: (first + second) / 2
  };
}

/**
 * Confidence in a completed area scan, used to tell the shopper whether to
 * trust the number or scan again.
 *
 *   planarity   how flat the tapped points were
 *   agreement   how closely the confirmatory scan matched
 *   points      more points describe an irregular room better
 */
export function areaConfidence({ points = [], difference = 0, tolerance = 5 }) {
  const rms = planarityRms(points);
  const reasons = [];
  let level = 'high';

  if (rms > 0.05) { level = 'low'; reasons.push('the tapped points are not on one flat surface'); }
  else if (rms > 0.02) { level = 'medium'; reasons.push('the floor points vary by a few centimetres'); }

  if (difference > tolerance) { level = 'low'; reasons.push(`the two scans differ by ${difference.toFixed(1)}%`); }
  else if (difference > tolerance / 2 && level === 'high') { level = 'medium'; reasons.push('the two scans differ slightly'); }

  if (points.length && points.length < 3) { level = 'low'; reasons.push('an area needs at least three points'); }
  if (points.length >= 3 && !isSimplePolygon(points)) { level = 'low'; reasons.push('the outline crosses itself'); }

  return { level, reasons, planarityRms: rms };
}

/* ------------------------------------------------------------- fit check --- */

/** Floor area a piece occupies, in square metres, from centimetre dimensions. */
export function footprintArea(dimensions) {
  return (dimensions.width / 100) * (dimensions.depth / 100);
}

/**
 * Does the piece fit the measured floor, and how much of it does it take?
 * `clearanceMargin` is the comfort gap kept on each side, in centimetres.
 */
export function fitAgainstArea(dimensions, areaSquareMetres, clearanceMargin = 5) {
  const footprint = footprintArea(dimensions);
  const withMargin = ((dimensions.width + clearanceMargin * 2) / 100) * ((dimensions.depth + clearanceMargin * 2) / 100);
  return {
    footprint,
    withMargin,
    fits: areaSquareMetres > 0 && withMargin <= areaSquareMetres,
    shareOfFloor: areaSquareMetres > 0 ? footprint / areaSquareMetres : 0,
    remaining: Math.max(0, areaSquareMetres - footprint)
  };
}

/** Linear clearance check, in centimetres — the existing two-point rule. */
export function fitAgainstClearance(dimensions, clearanceCm, clearanceMargin = 5) {
  const needed = dimensions.width + clearanceMargin;
  return {
    needed,
    fits: clearanceCm >= needed,
    spare: clearanceCm - dimensions.width
  };
}

/* ------------------------------------------------------------ formatting --- */

export function formatArea(squareMetres) {
  if (squareMetres >= 10) return `${squareMetres.toFixed(1)} m²`;
  if (squareMetres >= 0.1) return `${squareMetres.toFixed(2)} m²`;
  return `${(squareMetres * 10000).toFixed(0)} cm²`;
}

export function formatLength(metres) {
  return metres >= 1 ? `${metres.toFixed(2)} m` : `${(metres * 100).toFixed(1)} cm`;
}

/**
 * Percentage error of a measurement against a known reference — the figure a
 * field validation table reports. Positive means the app read long.
 */
export function measurementError(measured, reference) {
  if (!reference) return 0;
  return (measured - reference) / reference * 100;
}
