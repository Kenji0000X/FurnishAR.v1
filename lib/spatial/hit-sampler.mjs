/**
 * Turning a stream of WebXR hit-test poses into a point worth keeping.
 *
 * Until this module, a room corner was `state.latestHitPose` at the instant of
 * the tap: one frame of a tracker that re-solves the world every frame and
 * moves its answer by a centimetre or two while the phone is perfectly still,
 * and by far more on the frame where the thumb lands. The corner inherited all
 * of that. So did "is this surface flat": any horizontal plane anywhere in the
 * session made the CURRENT target "flat", and otherwise ten frames of steady Y
 * did — which a vertical wall also has.
 *
 * Three pieces, each small and each tested (tests/hit-sampler.test.js):
 *
 *   HitSampler        a rolling window of world-space hits; a robust estimate
 *                     (coordinate-wise median after MAD outlier rejection) and
 *                     the spread that estimate actually has.
 *   evaluateTarget    is the CURRENT hit a floor? From its surface normal,
 *                     its height stability, and the floor already established.
 *                     Unknown orientation is UNCERTAIN, never FLAT.
 *   FloorReference    the floor height, established by the first accepted
 *                     corner and checked against every later one.
 *
 * Thresholds come from measure-config.mjs, not from here.
 */

import { HIT_SAMPLING, FLOOR_TARGET, FLOOR_REFERENCE, ROOM_ACCEPTANCE } from './measure-config.mjs';

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
};

/* ------------------------------------------------------------- sampling -- */

export class HitSampler {
  constructor(config = HIT_SAMPLING) {
    this.config = { ...HIT_SAMPLING, ...config };
    this.samples = [];
  }

  /** One hit: world position in metres, the time in ms, and (optionally) the
      surface normal in world space. A frame with no hit should call miss(). */
  push({ x, y, z }, time, normal = null) {
    if (![x, y, z, time].every(Number.isFinite)) return;
    this.samples.push({ x, y, z, t: time, normal });
    this.trim(time);
  }

  /** A frame with no hit still ages the window, so an old burst of hits
      cannot look like a current steady target. */
  miss(time) { this.trim(time); }

  trim(now) {
    const oldest = now - this.config.windowMs;
    while (this.samples.length && this.samples[0].t < oldest) this.samples.shift();
  }

  reset() { this.samples = []; }

  /**
   * The robust point, with what it is worth.
   *
   *   point     coordinate-wise median of the inliers
   *   spread    90th percentile distance of the inliers from that point (m)
   *   count     samples in the window; inliers how many survived rejection
   *   stable    enough inliers AND a spread inside the configured limit
   *   reason    why not, in words a person can act on
   */
  estimate() {
    const { minSamples, maxSpreadM, outlierMads, minMadM } = this.config;
    const all = this.samples;
    if (all.length === 0) return { point: null, spread: null, count: 0, inliers: 0, stable: false, reason: 'Move slowly to find the floor.' };

    const centre = { x: median(all.map(s => s.x)), y: median(all.map(s => s.y)), z: median(all.map(s => s.z)) };
    const distance = s => Math.hypot(s.x - centre.x, s.y - centre.y, s.z - centre.z);
    const mad = Math.max(median(all.map(distance)), minMadM);
    const inliers = all.filter(s => distance(s) <= outlierMads * mad);

    const point = {
      x: median(inliers.map(s => s.x)),
      y: median(inliers.map(s => s.y)),
      z: median(inliers.map(s => s.z))
    };
    const spread = percentile(inliers.map(s => Math.hypot(s.x - point.x, s.y - point.y, s.z - point.z)), 0.9);

    let reason = null;
    if (all.length < minSamples) reason = 'Hold still…';
    else if (inliers.length < minSamples) reason = 'Hold still. The target keeps jumping.';
    else if (spread > maxSpreadM) reason = `Hold still. The target is moving by about ${Math.round(spread * 100)} cm.`;

    return {
      point, spread, count: all.length, inliers: inliers.length,
      stable: reason === null, reason,
      heightSpread: Math.max(...inliers.map(s => s.y)) - Math.min(...inliers.map(s => s.y)),
      normal: averageNormal(inliers)
    };
  }
}

function averageNormal(samples) {
  const withNormal = samples.filter(s => s.normal);
  if (!withNormal.length) return null;
  let x = 0, y = 0, z = 0;
  for (const s of withNormal) { x += s.normal.x; y += s.normal.y; z += s.normal.z; }
  const length = Math.hypot(x, y, z);
  return length > 0 ? { x: x / length, y: y / length, z: z / length } : null;
}

/**
 * The surface normal of a WebXR hit, in world space.
 *
 * A hit-test result's pose is oriented so its +Y axis is the surface normal
 * (WebXR Hit Test, "the Y axis of the pose points along the surface normal").
 * That is the one fact about orientation every hit carries, planes or no
 * planes, depth or no depth — so it is what decides "is this a floor".
 */
export function normalFromOrientation(q) {
  if (!q || ![q.x, q.y, q.z, q.w].every(Number.isFinite)) return null;
  const { x, y, z, w } = q;
  return {
    x: 2 * (x * y - w * z),
    y: 1 - 2 * (x * x + z * z),
    z: 2 * (y * z + w * x)
  };
}

/* --------------------------------------------------------- floor target -- */

export const TARGET = Object.freeze({
  SEARCHING: 'searching',   // no hit: white reticle
  VALID: 'valid',           // a floor, held still: green
  UNCERTAIN: 'uncertain',   // a hit whose floor-ness cannot be confirmed yet: amber
  INVALID: 'invalid'        // confirmed not a floor: red
});

/**
 * Is the surface under the reticle RIGHT NOW a floor that can be placed on
 * or measured from?
 *
 * Decided from the current hit only. "A horizontal plane exists somewhere in
 * this session" is not evidence about the point the reticle is on, and short
 * term Y stability is not evidence of horizontality — a wall is stable too.
 *
 *   estimate      HitSampler.estimate() for the current window
 *   floor         a FloorReference, or null before the first corner
 *   viewerY       camera height in the reference space, when it means
 *                 "above the floor" (local-floor); null otherwise
 *   onHorizontalPlane  true/false when plane detection placed this hit on a
 *                 plane, null when there is no plane information
 */
export function evaluateTarget({ estimate, floor = null, viewerY = null, onHorizontalPlane = null, config = FLOOR_TARGET }) {
  if (!estimate?.point) return { state: TARGET.SEARCHING, reason: 'Move slowly to find the floor.' };

  const normal = estimate.normal;
  if (normal) {
    const tilt = Math.acos(Math.max(-1, Math.min(1, normal.y))) * 180 / Math.PI;
    if (tilt > config.maxNormalTiltDeg) {
      return { state: TARGET.INVALID, reason: 'Point at a flat floor. This surface is sloped or upright.', tilt };
    }
  }

  if (floor?.established) {
    const check = floor.check(estimate.point);
    if (!check.ok) return { state: TARGET.INVALID, reason: check.reason };
  } else if (viewerY !== null && estimate.point.y > viewerY - config.minBelowViewerM) {
    return { state: TARGET.INVALID, reason: 'Point at the floor. That surface is too high to be it.' };
  }

  if (onHorizontalPlane === false) {
    return { state: TARGET.UNCERTAIN, reason: 'Point at a flat floor.' };
  }

  if (!estimate.stable) return { state: TARGET.UNCERTAIN, reason: estimate.reason };
  if (estimate.heightSpread > config.maxHeightSpreadM) {
    return { state: TARGET.UNCERTAIN, reason: 'Hold still. The surface height keeps changing.' };
  }

  /* Without a normal there is no orientation evidence at all. Stable is not
     flat; say so rather than calling it a floor. */
  if (!normal && onHorizontalPlane !== true) {
    return { state: TARGET.UNCERTAIN, reason: 'Point at a flat floor.' };
  }

  return { state: TARGET.VALID, reason: null };
}

/* ------------------------------------------------------- floor reference -- */

/**
 * The height of THE floor, once established, and every later corner checked
 * against it. Replaces "the lowest tap is the floor, and everything is
 * flattened onto it", which let a mis-tapped low point drag the floor down
 * and a 25 cm-high table top pass as floor.
 */
export class FloorReference {
  constructor(config = FLOOR_REFERENCE) {
    this.config = { ...FLOOR_REFERENCE, ...config };
    this.heights = [];
  }

  get established() { return this.heights.length >= this.config.minCorners; }

  /** Median of the accepted corners' heights. */
  get estimatedFloorY() { return median(this.heights); }

  /** Spread of the accepted heights: how sure the floor height is. */
  get floorUncertainty() {
    if (this.heights.length < 2) return null;
    return Math.max(...this.heights) - Math.min(...this.heights);
  }

  check(point) {
    if (!this.established) return { ok: true, deviation: 0 };
    const deviation = point.y - this.estimatedFloorY;
    if (Math.abs(deviation) > this.config.maxDeviationM) {
      return {
        ok: false, deviation,
        reason: deviation > 0
          ? `That point is ${Math.round(deviation * 100)} cm above the floor. Aim at the base of the wall.`
          : `That point is ${Math.round(-deviation * 100)} cm below the floor measured so far. Aim at the floor.`
      };
    }
    return { ok: true, deviation };
  }

  accept(point) { this.heights.push(point.y); }
  remove() { this.heights.pop(); }
  reset() { this.heights = []; }
}

/* -------------------------------------------------------- room acceptance -- */

/**
 * May this tapped room be used? Enough corners is not enough.
 *
 * Returns the checks with a reason for each failure, so the interface can say
 * what is wrong instead of leaving "Use this room" silently disabled.
 */
export function roomAcceptance({ corners = [], closed = false, simple = true, room = null, floor = null }, config = ROOM_ACCEPTANCE) {
  const checks = [];
  const add = (key, ok, reason) => checks.push({ key, ok, reason: ok ? null : reason });

  add('corners', corners.length >= config.minCorners, `Tap ${config.minCorners - corners.length} more corner${config.minCorners - corners.length === 1 ? '' : 's'}.`);
  add('closed', closed, 'Close the outline.');
  add('simple', simple, 'The outline crosses itself. Undo the last corner and tap them in order around the room.');

  const worst = corners.reduce((max, c) => Math.max(max, c.spread ?? 0), 0);
  add('steady', worst <= config.maxCornerSpreadM, `One corner moved by ${Math.round(worst * 100)} cm while it was taken. Undo it and hold still.`);

  const heights = corners.map(c => c.y).filter(Number.isFinite);
  const floorRange = heights.length ? Math.max(...heights) - Math.min(...heights) : 0;
  const floorLimit = (floor?.config?.maxDeviationM ?? FLOOR_REFERENCE.maxDeviationM) * 2;
  add('floor', floorRange <= floorLimit, `The corners are ${Math.round(floorRange * 100)} cm apart in height, so they are not all on the floor.`);

  if (room?.rectangle) {
    const shortSide = Math.min(room.rectangle.length, room.rectangle.width);
    const longSide = Math.max(room.rectangle.length, room.rectangle.width);
    add('size', shortSide >= config.minSideM && longSide <= config.maxSideM,
      longSide > config.maxSideM
        ? `${longSide.toFixed(1)} m is larger than a room. Check the corners.`
        : `${shortSide.toFixed(2)} m is too small for a room. Check the corners.`);
  } else if (closed) {
    add('size', false, 'No floor could be fitted to these corners.');
  }

  const blocking = checks.filter(c => !c.ok);
  return { ready: blocking.length === 0, checks, blocking, reason: blocking[0]?.reason ?? null };
}

/**
 * Do two independent scans of the same room agree?
 *
 * REPEATABILITY, not accuracy: two scans with the same systematic error agree
 * perfectly. The result says so, so nothing downstream can present agreement
 * as "accurate to ±5%".
 */
export function compareScans(first, second, tolerance = ROOM_ACCEPTANCE.repeatTolerance) {
  if (!first?.rectangle || !second?.rectangle) return { agrees: false, reason: 'Two complete scans are needed.' };
  const sides = r => {
    const a = r.rectangle.length, b = r.rectangle.width;
    return [Math.max(a, b), Math.min(a, b)];
  };
  const [l1, w1] = sides(first);
  const [l2, w2] = sides(second);
  const lengthDiff = Math.abs(l1 - l2) / Math.max(l1, l2);
  const widthDiff = Math.abs(w1 - w2) / Math.max(w1, w2);
  const worst = Math.max(lengthDiff, widthDiff);
  const worstMetres = Math.max(Math.abs(l1 - l2), Math.abs(w1 - w2));
  return {
    agrees: worst <= tolerance,
    lengthDiff, widthDiff, worst, worstMetres,
    kind: 'repeatability',
    reason: worst <= tolerance
      ? null
      : `These two scans differ by ${Math.round(worstMetres * 100)} cm. Scan the room once more.`
  };
}
