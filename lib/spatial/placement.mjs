/**
 * Where a piece of furniture actually is, relative to the room it is in.
 *
 * Placing a model on a detected floor is easy; the AR layer has done it for a
 * while. What it could not answer is the question that matters once a room has
 * been scanned:
 *
 *   - is this piece even inside the room, or hanging through a wall?
 *   - how much walking space is left around it?
 *   - is it standing in the same square metre as the other piece?
 *
 * All of that is plane geometry over the room rectangle, so it lives here as
 * pure functions and gets tested properly, rather than being eyeballed through
 * a phone camera nobody else can reproduce.
 *
 * Units are METRES throughout, matching the tracking system. Angles are
 * radians, measured the way WebXR measures yaw.
 */

/* ------------------------------------------------------------ the frame -- */

/**
 * The room's own coordinate system, built from its corners.
 *
 * Working in room-local space turns every question below into a rectangle
 * test: the room becomes the axis-aligned box [0, length] x [0, width], and a
 * piece is a rotated rectangle inside it. Doing it in world space instead
 * would mean re-deriving the room's angle in four different places.
 *
 * Derived from the corners rather than from `rectangle.angle`, because
 * `length` is defined as the longer side and may therefore be either of the
 * rectangle's two axes — assuming it is the first one silently transposes
 * every room whose width happens to exceed its depth.
 */
export function roomFrame(rectangle) {
  if (!rectangle?.corners || rectangle.corners.length < 4) return null;
  const [a, b, , d] = rectangle.corners;

  const uX = b.x - a.x;
  const uZ = b.z - a.z;
  const uLength = Math.hypot(uX, uZ);
  const vX = d.x - a.x;
  const vZ = d.z - a.z;
  const vLength = Math.hypot(vX, vZ);
  if (uLength < 1e-9 || vLength < 1e-9) return null;

  return {
    origin: { x: a.x, z: a.z },
    u: { x: uX / uLength, z: uZ / uLength },
    v: { x: vX / vLength, z: vZ / vLength },
    size: { u: uLength, v: vLength }
  };
}

/** World point -> room-local (u, v). */
export function toRoom(frame, point) {
  const dx = point.x - frame.origin.x;
  const dz = point.z - frame.origin.z;
  return {
    u: dx * frame.u.x + dz * frame.u.z,
    v: dx * frame.v.x + dz * frame.v.z
  };
}

/** Room-local (u, v) -> world point. */
export function toWorld(frame, local) {
  return {
    x: frame.origin.x + local.u * frame.u.x + local.v * frame.v.x,
    z: frame.origin.z + local.u * frame.u.z + local.v * frame.v.z
  };
}

/* ------------------------------------------------------------ footprint -- */

/**
 * The four corners of a piece's footprint, in whatever frame `centre` is in.
 *
 * @param centre  {u, v} or {x, z} — the field names are read positionally
 * @param size    { width, depth } in metres
 * @param yaw     radians, rotation about the vertical axis
 */
export function footprintCorners({ u, v }, { width, depth }, yaw) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const halfW = width / 2;
  const halfD = depth / 2;
  return [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]]
    .map(([x, z]) => ({
      u: u + x * cos - z * sin,
      v: v + x * sin + z * cos
    }));
}

/* ------------------------------------------------------------ the tests -- */

/**
 * How flush is flush.
 *
 * A tenth of a millimetre. `snapInsideRoom` puts a piece exactly against a
 * wall, and the arithmetic that gets it there lands on -8.9e-16 rather than
 * zero — so without this, a piece the app had just corrected reported itself
 * as "0 cm outside the room" the very next frame.
 *
 * Small enough that it cannot hide a real problem: nothing about AR tracking
 * is accurate to a tenth of a millimetre, and the smallest overhang anybody
 * could act on is thousands of times bigger.
 */
const FLUSH_METRES = 1e-4;

/**
 * Is this piece inside the room, and how much room is left around it?
 *
 * @param room    the result of roomDimensions() — needs `rectangle`
 * @param piece   { width, depth, height } in metres
 * @param pose    { x, z, yaw } in WORLD space, where the piece stands
 *
 * @returns
 *   inside      every corner within the walls
 *   overhang    metres the worst corner sticks out, 0 when inside
 *   margins     { u0, u1, v0, v1 } distance from each wall, negative outside
 *   clearance   the smallest of those — the tightest gap to any wall
 *   reason      one sentence, safe to show a person
 */
export function placementInRoom(room, piece, pose) {
  const frame = roomFrame(room?.rectangle);
  if (!frame) {
    return {
      inside: null, overhang: null, margins: null, clearance: null,
      reason: 'The room has not been measured yet, so there is nothing to place it in.'
    };
  }

  const centre = toRoom(frame, pose);
  const corners = footprintCorners(centre, piece, pose.yaw - roomYaw(frame));

  const us = corners.map(c => c.u);
  const vs = corners.map(c => c.v);

  // Distance from each wall to the nearest corner of the piece. Negative means
  // the piece is through that wall.
  const margins = {
    u0: Math.min(...us),
    u1: frame.size.u - Math.max(...us),
    v0: Math.min(...vs),
    v1: frame.size.v - Math.max(...vs)
  };

  const clearance = Math.min(margins.u0, margins.u1, margins.v0, margins.v1);
  const inside = clearance >= -FLUSH_METRES;
  const overhang = inside ? 0 : -clearance;

  return {
    inside,
    overhang,
    margins,
    clearance,
    reason: inside
      ? `Standing in the room with ${(clearance * 100).toFixed(0)} cm to the nearest wall.`
      : `${(overhang * 100).toFixed(0)} cm of this piece is outside the room.`
  };
}

/** The room frame's own heading, so a piece's world yaw can be made local. */
function roomYaw(frame) {
  return Math.atan2(frame.u.z, frame.u.x);
}

/**
 * Do two placed pieces occupy the same floor?
 *
 * Separating Axis Theorem over the four face normals of the two rectangles.
 * Two convex shapes miss each other exactly when some axis separates them, and
 * for rectangles only those four need testing.
 *
 * A circle-versus-circle approximation would be simpler and would report a
 * 2.1 m sofa as colliding with a stool a comfortable half-metre away, which is
 * the kind of wrong answer that makes people stop trusting the tool.
 */
export function overlaps(a, b) {
  const cornersA = footprintCorners({ u: a.x, v: a.z }, a, a.yaw);
  const cornersB = footprintCorners({ u: b.x, v: b.z }, b, b.yaw);

  const axes = [
    { u: Math.cos(a.yaw), v: Math.sin(a.yaw) },
    { u: -Math.sin(a.yaw), v: Math.cos(a.yaw) },
    { u: Math.cos(b.yaw), v: Math.sin(b.yaw) },
    { u: -Math.sin(b.yaw), v: Math.cos(b.yaw) }
  ];

  for (const axis of axes) {
    const project = corners => {
      const values = corners.map(c => c.u * axis.u + c.v * axis.v);
      return { min: Math.min(...values), max: Math.max(...values) };
    };
    const pa = project(cornersA);
    const pb = project(cornersB);
    // A gap on any one axis means they cannot be touching.
    if (pa.max <= pb.min || pb.max <= pa.min) return false;
  }
  return true;
}

/**
 * Everything a placed piece needs to be told about, in one call.
 *
 * @param room    the scanned room
 * @param piece   { width, depth, height } in metres
 * @param pose    { x, z, yaw } in world space
 * @param others  already-placed pieces: { x, z, yaw, width, depth, name }
 * @param options.clearance  walking space wanted around the piece, metres
 */
export function assessPlacement(room, piece, pose, others = [], { clearance = 0 } = {}) {
  const inRoom = placementInRoom(room, piece, pose);
  const problems = [];

  if (inRoom.inside === null) {
    return { ok: null, inRoom, collisions: [], problems: [inRoom.reason], reason: inRoom.reason };
  }

  if (!inRoom.inside) problems.push(inRoom.reason);
  else if (clearance > 0 && inRoom.clearance < clearance) {
    problems.push(
      `Only ${(inRoom.clearance * 100).toFixed(0)} cm to the nearest wall; ` +
      `you asked for ${(clearance * 100).toFixed(0)} cm.`
    );
  }

  // Collisions are named, because "does not fit" without saying what it hit is
  // an answer somebody has to go and work out for themselves.
  const collisions = others.filter(other =>
    overlaps({ ...piece, ...pose }, { ...other, yaw: other.yaw ?? 0 })
  );
  for (const hit of collisions) {
    problems.push(`Overlaps ${hit.name || 'another piece'}.`);
  }

  const ok = problems.length === 0;
  return {
    ok,
    inRoom,
    collisions,
    problems,
    reason: ok ? inRoom.reason : problems.join(' ')
  };
}

/**
 * Nudge a piece back inside the walls.
 *
 * Only ever moves it — never turns it and never resizes it. A piece that is
 * too big for the room does not become a smaller piece, and a chair does not
 * quietly rotate itself to fit through a gap the person was aiming at.
 *
 * @returns the corrected world pose, or the original when nothing helps.
 */
export function snapInsideRoom(room, piece, pose) {
  const frame = roomFrame(room?.rectangle);
  if (!frame) return pose;

  const centre = toRoom(frame, pose);
  const corners = footprintCorners(centre, piece, pose.yaw - roomYaw(frame));
  const us = corners.map(c => c.u);
  const vs = corners.map(c => c.v);

  const spanU = Math.max(...us) - Math.min(...us);
  const spanV = Math.max(...vs) - Math.min(...vs);
  // Genuinely too big for the room at this angle. Moving it cannot help, and
  // pretending otherwise by clamping it to a corner would look like success.
  if (spanU > frame.size.u || spanV > frame.size.v) return pose;

  let shiftU = 0;
  let shiftV = 0;
  if (Math.min(...us) < 0) shiftU = -Math.min(...us);
  else if (Math.max(...us) > frame.size.u) shiftU = frame.size.u - Math.max(...us);
  if (Math.min(...vs) < 0) shiftV = -Math.min(...vs);
  else if (Math.max(...vs) > frame.size.v) shiftV = frame.size.v - Math.max(...vs);

  if (shiftU === 0 && shiftV === 0) return pose;

  const moved = toWorld(frame, { u: centre.u + shiftU, v: centre.v + shiftV });
  return { x: moved.x, z: moved.z, yaw: pose.yaw };
}
