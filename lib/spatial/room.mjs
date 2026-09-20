/**
 * Turning detected surfaces into a room.
 *
 * WebXR's plane-detection gives a set of flat polygons floating in world
 * space: some floor, some wall, some the top of a table, some spurious. It
 * does not say "this room is 4.81 m by 3.42 m" — that is this module's job,
 * and it is the difference between an AR toy and a measuring tool.
 *
 * Everything here is a pure function over world-space polygons, deliberately
 * knowing nothing about XRPlane, XRFrame or three.js. There is no XR device in
 * CI, so this is the only way the maths gets tested at all: the engine does
 * the XR-specific work of transforming plane polygons into world space, and
 * hands the results here.
 *
 * ---------------------------------------------------------------------------
 * Conventions
 * ---------------------------------------------------------------------------
 *
 * WebXR is Y-up and right-handed, so the floor plane is at low Y and the
 * horizontal extent of a room lives in X and Z. Every length returned by this
 * module is in METRES, matching the tracking system; the display layer
 * converts.
 *
 * A "surface" coming in looks like:
 *
 *     { orientation: 'horizontal' | 'vertical',
 *       polygon: [{ x, y, z }, ...],     // world space, in order
 *       lastSeen: <timestamp> }          // optional
 */

/* -------------------------------------------------------------- helpers -- */

const area2d = points => {
  // Shoelace. Sign tells winding, which is why the caller takes the absolute.
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
};

/** Footprint area in m^2, ignoring height. */
export const footprintArea = polygon =>
  polygon.length < 3 ? 0 : Math.abs(area2d(polygon));

const extentOf = (polygon, axis) => {
  const values = polygon.map(p => p[axis]);
  return { min: Math.min(...values), max: Math.max(...values) };
};

/* --------------------------------------------------------- convex hull -- */

/**
 * Andrew's monotone chain, over the X/Z plane.
 *
 * A detected floor is rarely a tidy rectangle — it arrives as a ragged polygon
 * that grows as the scan continues, sometimes slightly concave where the
 * tracker was unsure. The hull is what the minimum-area rectangle needs, and
 * taking it also means a small concave notch cannot shrink the reported room.
 */
export function convexHull(points) {
  if (points.length < 3) return points.slice();

  const sorted = points
    .slice()
    .sort((a, b) => (a.x - b.x) || (a.z - b.z));

  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const build = list => {
    const stack = [];
    for (const point of list) {
      while (stack.length >= 2 && cross(stack[stack.length - 2], stack[stack.length - 1], point) <= 0) {
        stack.pop();
      }
      stack.push(point);
    }
    stack.pop();          // the last point starts the other chain
    return stack;
  };

  const hull = [...build(sorted), ...build(sorted.slice().reverse())];
  return hull.length >= 3 ? hull : points.slice();
}

/* ----------------------------------------------- minimum-area rectangle -- */

/**
 * The smallest rectangle that contains the floor, at any angle.
 *
 * This is the whole reason the room's dimensions can be trusted. An
 * axis-aligned bounding box is measured against the tracking origin, which is
 * wherever the phone happened to be when the session started — so a room
 * entered at 30 degrees would report a "width" that is a diagonal across it,
 * several tens of centimetres too big, and the fit verdict would happily say a
 * sofa fits when it does not.
 *
 * Rotating calipers: the minimum-area rectangle enclosing a convex polygon
 * always has one side flush with one of the polygon's edges (Freeman &
 * Shapira, 1975). So try each edge as the rectangle's axis, and keep the best.
 *
 * @returns {{ length, width, angle, area, corners }} lengths in metres,
 *          length >= width, angle in radians, corners in world X/Z order.
 */
export function minimumAreaRectangle(polygon) {
  const hull = convexHull(polygon);
  if (hull.length < 3) return null;

  let best = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeX = b.x - a.x;
    const edgeZ = b.z - a.z;
    const edgeLength = Math.hypot(edgeX, edgeZ);
    if (edgeLength < 1e-9) continue;          // duplicate points

    // Unit vectors along this edge and perpendicular to it.
    const ux = edgeX / edgeLength;
    const uz = edgeZ / edgeLength;
    const vx = -uz;
    const vz = ux;

    // Project every hull point onto that frame; the extents are the rectangle.
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const point of hull) {
      const u = point.x * ux + point.z * uz;
      const v = point.x * vx + point.z * vz;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const sideU = maxU - minU;
    const sideV = maxV - minV;
    const area = sideU * sideV;

    if (!best || area < best.area) {
      // Back to world space, so the caller can draw the rectangle it was told.
      const toWorld = (u, v) => ({ x: u * ux + v * vx, z: u * uz + v * vz });
      best = {
        area,
        length: Math.max(sideU, sideV),
        width: Math.min(sideU, sideV),
        angle: Math.atan2(uz, ux),
        corners: [
          toWorld(minU, minV), toWorld(maxU, minV),
          toWorld(maxU, maxV), toWorld(minU, maxV)
        ]
      };
    }
  }

  return best;
}

/* ------------------------------------------------------ classification -- */

/**
 * Sort detected surfaces into the parts of a room.
 *
 * Deliberately conservative. A plane is only the floor if it is horizontal,
 * low, and big enough to stand on — otherwise the top of a coffee table
 * becomes "the floor" and every height in the room is measured from it.
 *
 * @param surfaces  detected planes, world space
 * @param options.minFloorArea  m^2 below which a horizontal plane is furniture,
 *                              not floor. 1.0 m^2 is about a small rug; a
 *                              coffee table or a stool is under it.
 */
export function classifySurfaces(surfaces, { minFloorArea = 1.0 } = {}) {
  const horizontal = [];
  const vertical = [];

  for (const surface of surfaces) {
    if (!surface?.polygon || surface.polygon.length < 3) continue;
    const entry = {
      ...surface,
      area: footprintArea(surface.polygon),
      y: extentOf(surface.polygon, 'y')
    };
    (surface.orientation === 'vertical' ? vertical : horizontal).push(entry);
  }

  // The floor is the lowest horizontal plane large enough to be one. Taking
  // "lowest" alone would pick a stray plane detected under the real floor;
  // taking "largest" alone would pick a big table in a small room. Both.
  const floorCandidates = horizontal
    .filter(plane => plane.area >= minFloorArea)
    .sort((a, b) => a.y.min - b.y.min);
  const floor = floorCandidates[0] || null;

  // A ceiling is a large horizontal plane well above the floor. Without a
  // floor there is no "above", so there is no ceiling either.
  const ceiling = floor
    ? horizontal
        .filter(plane => plane.area >= minFloorArea && plane.y.min - floor.y.max > 1.5)
        .sort((a, b) => b.y.min - a.y.min)[0] || null
    : null;

  // Everything horizontal that is neither: tables, counters, the seat of a
  // chair. Kept, because they are obstacles for placement even though they
  // are not the room.
  const surfacesAbove = horizontal.filter(plane => plane !== floor && plane !== ceiling);

  return { floor, ceiling, walls: vertical, surfacesAbove };
}

/* ------------------------------------------------------ room dimensions -- */

/**
 * How big is this room?
 *
 * Returns what can be derived and says plainly what cannot. Every field is
 * either a number in metres or null, and `missing` names each null — because
 * "Unable to determine wall height" is a useful answer and 2.70 m invented
 * from nothing is not.
 */
export function roomDimensions(surfaces, options = {}) {
  const { floor, ceiling, walls } = classifySurfaces(surfaces, options);
  const missing = [];

  if (!floor) {
    return {
      length: null, width: null, height: null, floorArea: null,
      rectangle: null, corners: [], walls: 0,
      missing: ['floor', 'length', 'width', 'height'],
      complete: false
    };
  }

  const rectangle = minimumAreaRectangle(floor.polygon);
  if (!rectangle) missing.push('length', 'width');

  /*
     Height, in order of how much it can be trusted:

     1. Floor to ceiling, when a ceiling plane was actually detected. This is
        the real answer.
     2. Floor to the top of the tallest wall. Usually short of the truth,
        because a wall is rarely scanned all the way up — so it is reported
        as a floor-to-wall-top measurement rather than as the room's height.
     3. Nothing. Said out loud.
  */
  let height = null;
  let heightSource = null;
  if (ceiling) {
    height = ceiling.y.min - floor.y.max;
    heightSource = 'ceiling';
  } else if (walls.length) {
    const tallest = Math.max(...walls.map(wall => extentOf(wall.polygon, 'y').max));
    const candidate = tallest - floor.y.max;
    // A wall stub 20 cm tall is tracking noise, not a room.
    if (candidate > 0.5) {
      height = candidate;
      heightSource = 'wall-extent';
    }
  }
  if (height === null) missing.push('height');

  return {
    length: rectangle?.length ?? null,
    width: rectangle?.width ?? null,
    height,
    heightSource,
    floorArea: footprintArea(floor.polygon),
    rectangle,
    corners: rectangle?.corners ?? [],
    walls: walls.length,
    missing,
    // A room is only "complete" when nothing had to be left out. The scan UI
    // uses this to decide whether it may offer a "use this room" button.
    complete: missing.length === 0
  };
}

/* ----------------------------------------------------------- fitting ----- */

/**
 * Does this piece fit in this room, and where is the tightest part?
 *
 * Operates on the floor rectangle rather than a single typed span, which is
 * the point of scanning the room at all: a sofa that clears the doorway can
 * still be impossible to stand anywhere.
 *
 * @param room      the result of roomDimensions()
 * @param piece     { width, depth, height } in METRES
 * @param clearance metres to leave around the piece for walking space
 */
export function fitInRoom(room, piece, { clearance = 0 } = {}) {
  if (!room?.rectangle) {
    return { fits: null, reason: 'The room has not been measured yet.', spare: null };
  }

  const needLong = Math.max(piece.width, piece.depth) + clearance * 2;
  const needShort = Math.min(piece.width, piece.depth) + clearance * 2;
  const roomLong = room.length;
  const roomShort = room.width;

  // Rotating the piece is free and something anyone would do, so the test is
  // "does it fit in either orientation", not "does it fit as listed".
  const fits = needLong <= roomLong && needShort <= roomShort;

  // Height only disqualifies a piece when the room's height is actually known.
  // An unmeasured ceiling is not a short one.
  const tooTall = room.height !== null && piece.height > room.height;

  if (tooTall) {
    return {
      fits: false,
      reason: `Taller than the room: the piece is ${(piece.height * 100).toFixed(0)} cm and ` +
        `the ceiling measured ${(room.height * 100).toFixed(0)} cm.`,
      spare: null
    };
  }

  if (fits) {
    return {
      fits: true,
      reason: clearance > 0
        ? `Fits with ${(clearance * 100).toFixed(0)} cm of walking space around it.`
        : 'Fits within the measured floor.',
      spare: {
        along: roomLong - needLong,
        across: roomShort - needShort
      }
    };
  }

  // Say which way it is too big, and by how much — "too large" alone leaves
  // somebody re-measuring to find out what to change.
  const shortfallLong = needLong - roomLong;
  const shortfallShort = needShort - roomShort;
  const worst = Math.max(shortfallLong, shortfallShort);
  const axis = shortfallLong >= shortfallShort ? 'longest' : 'shortest';

  return {
    fits: false,
    reason: `Too big by ${(worst * 100).toFixed(0)} cm across the room's ${axis} side` +
      (clearance > 0 ? `, including the ${(clearance * 100).toFixed(0)} cm of clearance asked for.` : '.'),
    spare: {
      along: roomLong - needLong,
      across: roomShort - needShort
    }
  };
}
