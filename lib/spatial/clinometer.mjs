/**
 * Measuring a room with a tilt sensor, when there is no ARCore.
 *
 * A phone that is not on ARCore's supported device list will never run WebXR
 * AR, and a native Android app would sit on the same ARCore, so "measure by
 * AR tracking" is simply off the table for those phones. What is still
 * available is the oldest surveying instrument there is: an angle.
 *
 *          phone at height h
 *                |\
 *                | \
 *              h |  \          theta = tilt from straight down
 *                |   \
 *                |____\
 *                  d           d = h * tan(theta)
 *
 * Stand still. Hold the phone at a height you know. Aim the camera at the
 * point where a wall meets the floor. The tilt angle and the height give the
 * horizontal distance to that point. Add the compass bearing and the point
 * has a position on the floor around you; tap the corners in turn and the
 * floor polygon is complete.
 *
 * That polygon then goes through the SAME minimumAreaRectangle and
 * roomDimensions this project already uses for the AR path, so everything
 * downstream — the fit check, the placement rules, the panel — works
 * unchanged. This module's whole job is to turn angles into floor points.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ERROR BARS ARE NOT OPTIONAL
 *
 * d = h*tan(theta) is exact. The measurement is not, because theta is not:
 * a hand-held phone wobbles a degree or so, and tan() amplifies that by
 * sec^2(theta):
 *
 *     dd/dtheta = h * sec^2(theta)
 *
 * At h = 1.4 m, one degree of wobble costs:
 *
 *     theta = 30 deg  ->  3.3 cm
 *     theta = 45 deg  ->  4.9 cm
 *     theta = 60 deg  ->  9.8 cm
 *     theta = 75 deg  ->  36 cm
 *     theta = 85 deg  ->  3.2 m      <- the number on screen is fiction
 *
 * So this module never returns a bare distance. It returns the distance WITH
 * the spread that tilt uncertainty puts on it, and refuses outright past
 * MAX_TILT_DEGREES. A scanner that prints "4.87 m" when it means "somewhere
 * between 3.1 and 8.4 m" is worse than one that says it cannot tell.
 */

/* Past this, sec^2 makes a degree of hand-wobble worth more than a third of
   a metre, and the far wall of an ordinary room is already within reach at a
   sane angle. Aiming closer to horizontal is how these apps produce their
   most confident-looking nonsense. */
export const MAX_TILT_DEGREES = 80;

/* Below this you are measuring your own feet: d < 0.25 h. Allowed, but there
   is nothing to aim at that close, so it usually means the phone is pointing
   at the floor instead of at the corner. */
export const MIN_TILT_DEGREES = 12;

/* What a hand-held phone's tilt is actually worth. Not a guess pulled from
   nowhere: DeviceOrientationEvent on a mid-range Android reports beta to
   about a degree, and holding still adds roughly another. Raise it and every
   spread below widens honestly. */
export const TILT_NOISE_DEGREES = 1.5;

const RAD = Math.PI / 180;

/* --------------------------------------------------------------- distance -- */

/**
 * Horizontal distance to the floor point the phone is aimed at.
 *
 * `tiltDegrees` is measured from straight DOWN, which is what a phone's beta
 * already is: face-up flat on a table is 0 and the rear camera points at the
 * floor directly below; held upright it is 90 and the camera points at the
 * horizon, where the distance is genuinely infinite.
 *
 * Returns the distance, the +/- spread that tilt noise puts on it, and a
 * plain verdict. `distance` is null whenever the angle cannot support one,
 * so a caller that ignores `trust` still cannot print a fictional number.
 */
export function distanceFromTilt({ eyeHeight, tiltDegrees, noiseDegrees = TILT_NOISE_DEGREES }) {
  if (!(eyeHeight > 0)) {
    return { distance: null, spread: null, trust: 'unusable', reason: 'No phone height given — the trigonometry has nothing to scale by.' };
  }
  if (!Number.isFinite(tiltDegrees)) {
    return { distance: null, spread: null, trust: 'unusable', reason: 'No tilt reading from this phone.' };
  }
  if (tiltDegrees >= MAX_TILT_DEGREES) {
    return {
      distance: null, spread: null, trust: 'unusable',
      reason: `Too close to level (${tiltDegrees.toFixed(0)}°). Aim further down — past ${MAX_TILT_DEGREES}° a degree of wobble moves the answer by metres.`
    };
  }
  if (tiltDegrees <= 0) {
    return { distance: null, spread: null, trust: 'unusable', reason: 'Aimed straight down or behind you.' };
  }

  const theta = tiltDegrees * RAD;
  const distance = eyeHeight * Math.tan(theta);

  // dd/dtheta = h * sec^2(theta), converted to the spread from one noise band.
  const sec2 = 1 / (Math.cos(theta) ** 2);
  const spread = eyeHeight * sec2 * (noiseDegrees * RAD);

  /*
     Graded on BOTH the relative and the absolute spread, because either one
     alone lets a useless reading through.

     Relative spread works out as 2*dtheta/sin(2*theta): it is smallest at 45
     degrees and climbs either side. That is the right shape, but it only
     crosses 15% at about 80 degrees — which is where the hard cap already
     is — so a relative test alone never fires. At 78 degrees it calls
     +/- 85 cm on a 6.6 m wall "good", and 85 cm is not good for deciding
     whether a sofa fits.

     So the absolute spread is checked too. A quarter of a metre of doubt is
     roughly the width of a sofa arm; past that the number stops being usable
     for the only thing this app does with it.
  */
  const relative = spread / distance;
  let trust = 'good';
  let reason = null;
  if (tiltDegrees < MIN_TILT_DEGREES) {
    trust = 'coarse';
    reason = 'Aimed almost straight down — that is the floor at your feet, not the far corner.';
  } else if (spread > 0.25) {
    trust = 'coarse';
    reason = `Soft reading: give or take ${(spread * 100).toFixed(0)} cm. Stand closer, or hold the phone higher.`;
  } else if (relative > 0.10) {
    trust = 'coarse';
    reason = 'Aim lower, or stand further back: at this angle the reading is soft.';
  }

  return { distance, spread, trust, reason };
}

/**
 * The inverse: how high is the thing I am aiming UP at, from a distance I
 * already know? Used for ceiling height once a wall's distance is measured.
 * `riseDegrees` is measured up from horizontal.
 */
export function heightFromTilt({ distance, riseDegrees, eyeHeight = 0, noiseDegrees = TILT_NOISE_DEGREES }) {
  if (!(distance > 0) || !Number.isFinite(riseDegrees)) {
    return { height: null, spread: null, trust: 'unusable', reason: 'Measure the distance to the wall first.' };
  }
  if (Math.abs(riseDegrees) >= MAX_TILT_DEGREES) {
    return { height: null, spread: null, trust: 'unusable', reason: 'Aimed too steeply up to be reliable.' };
  }
  const phi = riseDegrees * RAD;
  const height = eyeHeight + distance * Math.tan(phi);
  const spread = distance * (1 / Math.cos(phi) ** 2) * (noiseDegrees * RAD);
  return {
    height,
    spread,
    trust: spread / Math.max(height, 0.01) > 0.15 ? 'coarse' : 'good',
    reason: null
  };
}

/* ------------------------------------------------------------ floor point -- */

/**
 * Where on the floor, relative to where you are standing, is the point the
 * phone is aimed at?
 *
 * The bearing only ever has to be RELATIVE — the room's shape is the same
 * whichever way north is — so a drifting indoor compass costs an overall
 * rotation, which no dimension depends on, rather than an error in the
 * dimensions themselves. Bearings are taken as degrees clockwise from
 * wherever the first reading pointed.
 *
 * y is 0 because this is a floor point, which is what classifySurfaces()
 * needs to see in order to call the polygon a floor.
 */
export function floorPointFromAim({ eyeHeight, tiltDegrees, bearingDegrees, noiseDegrees = TILT_NOISE_DEGREES }) {
  const shot = distanceFromTilt({ eyeHeight, tiltDegrees, noiseDegrees });
  if (shot.distance === null) return { point: null, ...shot };
  if (!Number.isFinite(bearingDegrees)) {
    return { point: null, distance: null, spread: null, trust: 'unusable', reason: 'No compass bearing from this phone.' };
  }
  const bearing = bearingDegrees * RAD;
  return {
    point: {
      x: shot.distance * Math.sin(bearing),
      y: 0,
      z: -shot.distance * Math.cos(bearing)
    },
    ...shot
  };
}

/**
 * The smallest turn from a to b, in degrees, signed. Bearings wrap at 360 and
 * a naive subtraction across the seam reports 350 degrees for a 10 degree
 * turn, which would fold one corner of the room onto another.
 */
export function bearingDelta(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/* ------------------------------------------------- a room from the corners -- */

/**
 * Turn tapped floor corners into the surface list roomDimensions() consumes.
 *
 * Deliberately the same hand-off the AR tap path uses: a single horizontal
 * polygon at y = 0, plus — only if a ceiling height was actually measured —
 * a matching polygon at that height, so height comes from a real second
 * measurement rather than from a number this module made up.
 */
export function surfacesFromCorners(corners, { ceilingHeight = null } = {}) {
  if (!Array.isArray(corners) || corners.length < 3) return [];
  const floor = corners.map(c => ({ x: c.x, y: 0, z: c.z }));
  const surfaces = [{ orientation: 'horizontal', polygon: floor }];
  if (ceilingHeight > 0.5) {
    surfaces.push({
      orientation: 'horizontal',
      polygon: corners.map(c => ({ x: c.x, y: ceilingHeight, z: c.z }))
    });
  }
  return surfaces;
}

/**
 * How far is the outline from being a room?
 *
 * Separate from the geometry so the button's enabled state and the hint text
 * cannot disagree about it.
 */
export function cornerReadiness(corners, { closed = false } = {}) {
  const blocking = [];
  if (!Array.isArray(corners) || corners.length < 3) {
    blocking.push(`${3 - (corners?.length || 0)} more corner${3 - (corners?.length || 0) === 1 ? '' : 's'}`);
  }
  if (!closed) blocking.push('close the outline');
  return { ready: blocking.length === 0, blocking };
}
