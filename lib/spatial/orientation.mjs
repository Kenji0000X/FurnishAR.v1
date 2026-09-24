/**
 * Where is the rear camera actually pointing?
 *
 * The aim-and-tap measurer turns a camera angle into a floor distance with
 * d = h * tan(theta), theta measured from straight down. Until this module,
 * theta was DeviceOrientationEvent.beta read straight off the event. That is
 * only right in one pose: phone in portrait, not rolled, screen not rotated.
 *
 *   - beta is a rotation about the device's X axis in an intrinsic Z-X'-Y''
 *     Euler sequence. When the phone is also rolled (gamma != 0), the camera's
 *     angle from vertical is acos(cos(beta) * cos(gamma)), not beta.
 *   - In landscape the phone is turned on its side: beta sits near 0 while
 *     the camera points at the horizon, so "beta = angle from down" reads a
 *     wall at the horizon as the floor at your feet.
 *   - alpha is the rotation about the vertical only while the phone lies flat.
 *     Used as a heading while the phone is upright and rolled, it swings with
 *     the roll.
 *
 * So this builds the full rotation (W3C DeviceOrientation, intrinsic Z-X'-Y'',
 * earth frame x = east, y = north, z = up), rotates the rear camera's forward
 * vector (device -Z, the same in every screen orientation because the lens is
 * part of the phone) into the earth frame, and reads the angles off that
 * vector. The screen orientation only decides what "roll" means: the tilt of
 * the screen's own left-right axis, which is what the person sees as a crooked
 * picture.
 *
 * Nothing here filters or calibrates. It is a pure conversion, tested by
 * building physical poses and checking that equal poses give equal answers
 * whichever way the screen is turned (tests/orientation.test.js).
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Rotation matrix, device frame to earth frame, from the W3C angles in degrees.
 * Row-major 3x3: m[r][c]. R = Rz(alpha) * Rx(beta) * Ry(gamma).
 */
export function rotationFromEuler({ alpha = 0, beta = 0, gamma = 0 }) {
  const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg]
  ];
}

/**
 * The W3C Euler angles for a rotation matrix. Only needed to build test poses
 * from physical descriptions ("portrait, aimed 45 degrees down, rolled 10").
 * beta is kept in [-180, 180) and gamma in [-90, 90), as the spec requires.
 */
export function eulerFromRotation(m) {
  const sb = Math.max(-1, Math.min(1, m[2][1]));
  let beta = Math.asin(sb);
  let cb = Math.cos(beta);
  let alpha, gamma;
  if (Math.abs(cb) > 1e-9) {
    alpha = Math.atan2(-m[0][1], m[1][1]);
    gamma = Math.atan2(-m[2][0], m[2][2]);
    // The spec keeps gamma in [-90, 90); asin alone keeps beta in [-90, 90],
    // so fold the other solution in when gamma falls outside its range.
    if (gamma >= Math.PI / 2 || gamma < -Math.PI / 2) {
      beta = (beta >= 0 ? Math.PI : -Math.PI) - beta;
      cb = Math.cos(beta);
      alpha = Math.atan2(-m[0][1] / cb, m[1][1] / cb);
      gamma = Math.atan2(-m[2][0] / cb, m[2][2] / cb);
    }
  } else {
    // Gimbal lock: beta = +-90. alpha and gamma share one axis; put it all in alpha.
    gamma = 0;
    alpha = Math.atan2(m[1][0], m[0][0]);
  }
  const wrap = x => ((x % 360) + 360) % 360;
  let betaDeg = beta * DEG;
  if (betaDeg >= 180) betaDeg -= 360;
  return { alpha: wrap(alpha * DEG), beta: betaDeg, gamma: gamma * DEG };
}

const apply = (m, [x, y, z]) => [
  m[0][0] * x + m[0][1] * y + m[0][2] * z,
  m[1][0] * x + m[1][1] * y + m[1][2] * z,
  m[2][0] * x + m[2][1] * y + m[2][2] * z
];

/** Normalises screen.orientation.angle (or window.orientation) to 0/90/180/270. */
export function normaliseScreenAngle(angle) {
  const n = Number(angle);
  if (!Number.isFinite(n)) return 0;
  return ((Math.round(n / 90) * 90) % 360 + 360) % 360;
}

/**
 * The camera's pose, in the terms the measurer needs.
 *
 *   angleFromDown  degrees between the rear camera's line of sight and
 *                  straight down: 0 = at your feet, 90 = the horizon,
 *                  above 90 = aiming upward. This is the theta of
 *                  d = h * tan(theta).
 *   elevation      90 - angleFromDown: degrees above the horizon (negative
 *                  when aiming down). Used for the ceiling.
 *   roll           degrees the screen's left-right axis is tipped from level,
 *                  whichever way the screen is turned. 0 = level.
 *   heading        compass-style bearing of the line of sight, degrees
 *                  clockwise from the frame's north, or null when the camera
 *                  points so close to vertical that it has no direction.
 *                  Relative only unless the event was absolute.
 */
export function cameraPose({ alpha, beta, gamma }, screenAngle = 0) {
  if (![beta, gamma].every(Number.isFinite)) return null;
  const m = rotationFromEuler({ alpha: Number.isFinite(alpha) ? alpha : 0, beta, gamma });
  const forward = apply(m, [0, 0, -1]);
  const down = -forward[2];                         // dot(forward, (0,0,-1))
  const angleFromDown = Math.acos(Math.max(-1, Math.min(1, down))) * DEG;

  // The screen's own right-hand direction, in device coordinates, for the
  // current screen rotation: 0 -> +X, 90 -> -Y, 180 -> -X, 270 -> +Y.
  const s = normaliseScreenAngle(screenAngle) * RAD;
  const screenRight = apply(m, [Math.cos(s), -Math.sin(s), 0]);
  const roll = Math.asin(Math.max(-1, Math.min(1, screenRight[2]))) * DEG;

  const horizontal = Math.hypot(forward[0], forward[1]);
  const heading = horizontal > Math.sin(3 * RAD)
    ? ((Math.atan2(forward[0], forward[1]) * DEG) + 360) % 360
    : null;

  return { angleFromDown, elevation: 90 - angleFromDown, roll, heading, alphaKnown: Number.isFinite(alpha) };
}

/* ------------------------------------------------------------ calibration -- */

/**
 * A session-only correction for a sensor stack that does not report exactly
 * zero where it should.
 *
 * The person holds the phone upright and level against something vertical (a
 * door frame) and taps Calibrate. In that pose the camera's true angleFromDown
 * is 90 and its roll is 0; whatever the sensor says instead is its offset, and
 * the same offset is removed from every later reading.
 *
 * It corrects a CONSTANT bias only. An offset larger than MAX_CALIBRATION is
 * refused rather than applied: that is not a sensor zero, it is a phone that
 * was not held upright, and baking it in would bend every later measurement.
 * It is never multiplied into a distance, so it cannot become a fudge factor.
 */
export const MAX_CALIBRATION_DEGREES = 8;

export function calibrationFrom(samples) {
  const usable = (samples || []).filter(p => p && Number.isFinite(p.angleFromDown) && Number.isFinite(p.roll));
  if (usable.length < 10) {
    return { ok: false, reason: 'Hold the phone still for a moment while it calibrates.' };
  }
  const median = values => {
    const sorted = [...values].sort((x, y) => x - y);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const pitchOffset = 90 - median(usable.map(p => p.angleFromDown));
  const rollOffset = -median(usable.map(p => p.roll));
  const spread = Math.max(...usable.map(p => p.angleFromDown)) - Math.min(...usable.map(p => p.angleFromDown));
  if (spread > 2) {
    return { ok: false, reason: 'The phone moved while calibrating. Hold it still against something upright and try again.' };
  }
  if (Math.abs(pitchOffset) > MAX_CALIBRATION_DEGREES || Math.abs(rollOffset) > MAX_CALIBRATION_DEGREES) {
    return {
      ok: false,
      reason: `The phone reads ${Math.abs(pitchOffset).toFixed(0)}° from upright. Hold it straight up and level, for example flat against a door frame, and calibrate again.`
    };
  }
  return { ok: true, pitchOffset, rollOffset };
}

/** A pose with the session calibration removed. */
export function applyCalibration(pose, calibration) {
  if (!pose || !calibration?.ok) return pose;
  const angleFromDown = pose.angleFromDown + calibration.pitchOffset;
  return { ...pose, angleFromDown, elevation: 90 - angleFromDown, roll: pose.roll + calibration.rollOffset };
}

/* ------------------------------------------------------------------ roll -- */

/**
 * Past this roll, "the point under the crosshair" is no longer the point the
 * distance formula assumes, and the heading is no longer the heading of the
 * line of sight in any useful sense. Capture is refused, not corrected.
 * Uncalibrated; see lib/spatial/measure-config.mjs for where it is recorded.
 */
export const MAX_ROLL_DEGREES = 10;

export function rollProblem(pose, maxRoll = MAX_ROLL_DEGREES) {
  if (!pose) return null;
  return Math.abs(pose.roll) > maxRoll ? 'Straighten the phone.' : null;
}
