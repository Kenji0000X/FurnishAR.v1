/**
 * Measuring on a plane in a photo, with the perspective taken out.
 *
 * The old photo method drew a line along a reference and divided: metres per
 * pixel. That is only right when the reference and the thing measured lie in
 * the same plane AND the camera is square to it. Off square, one pixel near the
 * camera is fewer millimetres than one pixel far away, and a single ratio
 * cannot know which.
 *
 * A rectangle of known size, marked at all four corners, fixes that. Its four
 * image points and its four real corners define a homography — the one
 * projective transform that maps the photographed plane back onto a flat,
 * metric one. Any two points marked ON THAT SAME PLANE can then be measured in
 * metres, whatever angle the photo was taken at.
 *
 * What it still cannot do, and says so:
 *   - measure anything off the reference's plane (a sofa standing in front of
 *     the wall, the floor below it). One photo, one plane; a room is measured
 *     wall by wall.
 *   - rescue a photo so oblique that the reference is a sliver. The skew and
 *     extrapolation checks refuse those rather than returning a number.
 */

import { PHOTO } from './measure-config.mjs';

/** Rectangles people in a Philippine household actually have to hand. */
export const REFERENCE_RECTANGLES = [
  { id: 'a4', label: 'A4 paper (29.7 × 21.0 cm)', width: 0.297, height: 0.210 },
  { id: 'card', label: 'Bank or ID card (8.56 × 5.40 cm)', width: 0.0856, height: 0.05398 },
  { id: 'tile-60', label: 'Floor tile, 60 × 60 cm', width: 0.60, height: 0.60 },
  { id: 'tile-30', label: 'Floor tile, 30 × 30 cm', width: 0.30, height: 0.30 },
  { id: 'custom', label: 'Another rectangle I will measure', width: null, height: null }
];

/**
 * The 3x3 homography H with H * src[i] ~ dst[i], from exactly four point pairs.
 * Solved directly (8 unknowns, h33 = 1) by Gaussian elimination with partial
 * pivoting. Returns null for a degenerate quadrilateral (three points in a
 * line, repeated points).
 */
export function homographyFrom(src, dst) {
  if (src?.length !== 4 || dst?.length !== 4) return null;
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  if (!h) return null;
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyHomography(H, { x, y }) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  if (Math.abs(w) < 1e-12) return null;
  return { x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w, y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w };
}

/** Signed area; used to reject a crossed (bow-tie) marking. */
function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function isConvexQuad(points) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * How oblique is the reference? 0 for a square-on photo, rising towards 1.
 * The larger of the two opposite-side mismatches, the same measure
 * photo-scale.mjs's squareness() used, so the thresholds carry over.
 */
export function skewOf(corners) {
  const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const [p, q, r, s] = corners;
  const pair = (m, n) => Math.abs(m - n) / Math.max(m, n, 1e-9);
  return Math.max(pair(d(p, q), d(s, r)), pair(d(p, s), d(q, r)));
}

/**
 * The plane of a marked reference rectangle, ready to measure on.
 *
 *   corners   four image points, in order around the rectangle, starting at
 *             any corner. Pixels (or any consistent image units).
 *   width     real length of the side from corners[0] to corners[1], metres
 *   height    real length of the side from corners[1] to corners[2], metres
 */
export function referencePlane({ corners, width, height, tapErrorPx = PHOTO.tapErrorPx, config = PHOTO }) {
  if (!Array.isArray(corners) || corners.length !== 4) {
    return { ok: false, reason: 'Mark all four corners of the reference.' };
  }
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, reason: 'Enter the real size of the reference.' };
  }
  if (!isConvexQuad(corners)) {
    return { ok: false, reason: 'Mark the four corners in order around the edge, not across it.' };
  }
  const skew = skewOf(corners);
  if (skew > config.maxSkew) {
    return { ok: false, skew, reason: 'This photo was taken at too much of an angle. Stand more square to the wall and retake it.' };
  }
  const world = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const H = homographyFrom(corners, world);
  if (!H) return { ok: false, reason: 'Those four points do not make a rectangle. Mark them again.' };

  const imageSize = Math.sqrt(Math.abs(signedArea(corners)));
  return {
    ok: true, H, skew, width, height,
    corners: corners.map(c => ({ ...c })),
    tapErrorPx,
    referenceDiagonal: Math.hypot(width, height),
    imageSize,
    verdict: skew > 0.12 ? 'tilted' : 'square',
    note: skew > 0.12 ? 'The photo is at an angle. The perspective has been corrected, but a squarer photo is more accurate.' : null
  };
}

/**
 * A distance on the reference's plane, in metres, with its uncertainty.
 *
 * The spread is worked out, not guessed: every marked point (the two ends
 * AND the four reference corners) is nudged by the tap error in each
 * direction, the homography rebuilt, the line re-measured, and the worst
 * single-point change kept, combined in quadrature. A fingertip is not a
 * precision cursor, and a small reference makes its corners' error matter
 * more — this is where that shows.
 */
export function measureOnPlane(plane, a, b, config = PHOTO) {
  if (!plane?.ok || !a || !b) return { metres: null, reason: plane?.reason || 'Mark both ends.' };
  const pa = applyHomography(plane.H, a);
  const pb = applyHomography(plane.H, b);
  if (!pa || !pb) return { metres: null, reason: 'That point is outside the plane of the reference.' };
  const metres = Math.hypot(pb.x - pa.x, pb.y - pa.y);

  const e = plane.tapErrorPx;
  const nudges = [{ x: e, y: 0 }, { x: -e, y: 0 }, { x: 0, y: e }, { x: 0, y: -e }];
  const worst = [];
  const lengthWith = (corners, p, q) => {
    const world = [{ x: 0, y: 0 }, { x: plane.width, y: 0 }, { x: plane.width, y: plane.height }, { x: 0, y: plane.height }];
    const H = homographyFrom(corners, world);
    if (!H) return null;
    const u = applyHomography(H, p), v = applyHomography(H, q);
    return u && v ? Math.hypot(v.x - u.x, v.y - u.y) : null;
  };
  // The two measured ends.
  for (const which of ['a', 'b']) {
    let max = 0;
    for (const n of nudges) {
      const p = which === 'a' ? { x: a.x + n.x, y: a.y + n.y } : a;
      const q = which === 'b' ? { x: b.x + n.x, y: b.y + n.y } : b;
      const m = lengthWith(plane.corners, p, q);
      if (m !== null) max = Math.max(max, Math.abs(m - metres));
    }
    worst.push(max);
  }
  // The four reference corners.
  for (let i = 0; i < 4; i += 1) {
    let max = 0;
    for (const n of nudges) {
      const corners = plane.corners.map((c, j) => (j === i ? { x: c.x + n.x, y: c.y + n.y } : c));
      const m = lengthWith(corners, a, b);
      if (m !== null) max = Math.max(max, Math.abs(m - metres));
    }
    worst.push(max);
  }
  const spread = Math.sqrt(worst.reduce((sum, w) => sum + w * w, 0));

  const extrapolation = metres / plane.referenceDiagonal;
  let trust = spread / Math.max(metres, 0.01) > config.coarseRelativeSpread ? 'coarse' : 'good';
  let reason = null;
  if (extrapolation > config.maxExtrapolation) {
    trust = 'coarse';
    reason = `That line is ${Math.round(extrapolation)} times the size of the reference. Use a bigger reference, such as a floor tile, for something this long.`;
  }
  return { metres, spread, trust, reason, extrapolation, method: 'photo-homography' };
}
