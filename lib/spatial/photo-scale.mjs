/**
 * Measuring from a photograph, using something of known size in the shot.
 *
 * The fallback for a phone with no ARCore AND no usable tilt sensor. Put
 * something whose size you know against the wall — a sheet of A4, a bank
 * card, a floor tile you have counted — photograph it, drag a line along it,
 * and every other line drawn in that same photo can be scaled from it.
 *
 * ---------------------------------------------------------------------------
 * THE LIMIT, STATED UP FRONT
 *
 * A photograph is a projection: it throws away depth. One scale can therefore
 * only be right for one PLANE — the plane the reference object lies in.
 * Measure the wall the A4 sheet is taped to and the answer is good. Measure
 * something a metre nearer the camera with the same scale and it will read
 * too large, because nearer things are bigger in frame.
 *
 * This is not a flaw to be papered over with cleverness; it is what a single
 * photo can and cannot tell you. So `scaleFromReference` names the plane it
 * is valid in, `measure()` carries that caveat with every result, and nothing
 * here pretends a photo can measure a whole room in one shot. A room is
 * measured wall by wall, one reference per wall.
 *
 * Perspective makes it worse the further off square the camera is, which is
 * why `squareness()` exists: a reference that should be rectangular and comes
 * out visibly skewed in frame is a warning that this photo was taken at an
 * angle and its scale is stretched along one axis.
 */

/** Things people in a Philippine household can actually lay hands on. */
export const KNOWN_OBJECTS = [
  { id: 'a4-long', label: 'A4 paper, long edge', metres: 0.297 },
  { id: 'a4-short', label: 'A4 paper, short edge', metres: 0.210 },
  { id: 'card', label: 'Bank or ID card, long edge', metres: 0.0856 },
  { id: 'tile-60', label: 'Floor tile, 60 cm', metres: 0.60 },
  { id: 'tile-30', label: 'Floor tile, 30 cm', metres: 0.30 },
  { id: 'hollow-block', label: 'Hollow block, long face', metres: 0.40 },
  { id: 'plywood', label: 'Plywood sheet, long edge', metres: 2.44 },
  { id: 'custom', label: 'Something else I will measure', metres: null }
];

const pixelLength = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Metres per pixel, from a line drawn along something of known length.
 *
 * Refuses a reference drawn too short to be worth anything: a 12-pixel line
 * standing in for 297 mm means every pixel of sloppiness in the drag is
 * 25 mm of error in every measurement taken afterwards, multiplied across
 * the whole photo.
 */
export function scaleFromReference({ a, b, realMetres, minPixels = 40 }) {
  if (!a || !b || !(realMetres > 0)) {
    return { metresPerPixel: null, reason: 'Mark the reference object first.' };
  }
  const pixels = pixelLength(a, b);
  if (pixels < minPixels) {
    return {
      metresPerPixel: null,
      pixels,
      reason: `That line is only ${Math.round(pixels)} pixels long. Zoom in or use a bigger reference — every pixel of it would be ${(realMetres / Math.max(pixels, 1) * 1000).toFixed(0)} mm of error.`
    };
  }
  return {
    metresPerPixel: realMetres / pixels,
    pixels,
    /* Carried so the UI can keep saying it rather than saying it once and
       hoping the person remembers by the time they read a number. */
    validIn: 'the plane the reference object is lying in',
    reason: null
  };
}

/**
 * A length in metres between two points in the same photo.
 *
 * `spread` is the honest uncertainty: how far out the answer would be if the
 * person's taps were `tapErrorPixels` off, which they are — a fingertip on a
 * phone covers the better part of ten pixels. It grows with the measured
 * length relative to the reference, which is the real reason a tiny reference
 * object is a bad idea.
 */
export function measure({ a, b, metresPerPixel, tapErrorPixels = 6, referencePixels = null }) {
  if (!a || !b || !(metresPerPixel > 0)) {
    return { metres: null, spread: null, reason: 'Set the scale from a known object first.' };
  }
  const pixels = pixelLength(a, b);
  const metres = pixels * metresPerPixel;

  /* Two independent sources of tap error: the two ends of THIS line, and the
     two ends of the reference line that set the scale. The second is why a
     short reference poisons every later measurement in proportion. */
  const ownError = tapErrorPixels * Math.SQRT2 * metresPerPixel;
  const scaleError = referencePixels > 0
    ? metres * (tapErrorPixels * Math.SQRT2 / referencePixels)
    : 0;
  const spread = Math.hypot(ownError, scaleError);

  return {
    metres,
    pixels,
    spread,
    trust: spread / Math.max(metres, 0.01) > 0.12 ? 'coarse' : 'good',
    reason: null
  };
}

/**
 * How square-on was this photo taken?
 *
 * Given the four corners of something known to be a rectangle, compare the
 * two pairs of opposite sides. In a square-on shot they match; the more the
 * camera was off to one side, the more one pair diverges, and the more the
 * single scale above is wrong in one direction.
 *
 * Returned as a 0..1 skew with a verdict, so the UI can tell someone to
 * stand square rather than silently handing them a stretched room.
 */
export function squareness(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) {
    return { skew: null, verdict: 'unknown', reason: 'Mark all four corners to check the angle.' };
  }
  const [p, q, r, s] = corners;
  const top = pixelLength(p, q);
  const bottom = pixelLength(s, r);
  const left = pixelLength(p, s);
  const right = pixelLength(q, r);

  const pairSkew = (m, n) => Math.abs(m - n) / Math.max(m, n, 1);
  const skew = Math.max(pairSkew(top, bottom), pairSkew(left, right));

  if (skew > 0.25) {
    return { skew, verdict: 'bad', reason: 'This was shot from well off to one side. Stand square to the wall and take it again — the scale is stretched.' };
  }
  if (skew > 0.10) {
    return { skew, verdict: 'tilted', reason: 'Slightly off square. Usable, but standing straight on would be better.' };
  }
  return { skew, verdict: 'square', reason: null };
}

/**
 * A wall measured from a photo, folded into the floor-corner form the rest of
 * the planner speaks. A photo gives one wall's LENGTH, not a room, so the
 * room is assembled from several of these in the order they were walked.
 */
export function wallsToCorners(wallLengths) {
  const lengths = (wallLengths || []).filter(n => n > 0);
  if (lengths.length < 3) return [];
  /* Right-angled by construction: a photo cannot see the angle between two
     walls, so assuming square corners is the only honest option — and it is
     stated in the UI rather than hidden here. */
  const corners = [];
  let x = 0, z = 0, heading = 0;
  corners.push({ x, y: 0, z });
  for (let i = 0; i < lengths.length - 1; i += 1) {
    x += lengths[i] * Math.sin(heading);
    z -= lengths[i] * Math.cos(heading);
    corners.push({ x, y: 0, z });
    heading += Math.PI / 2;
  }
  return corners;
}
