/**
 * Furniture lengths: one physical size, shown in whatever unit a person reads.
 *
 * The rule this file exists for: a unit is a way of WRITING a length, not a
 * length. 30 cm, 11.811 in and 0.984 ft are the same piece of furniture, and
 * switching between them must never change the piece.
 *
 *   owner types      cm / in / ft
 *        ↓           toCentimeters()
 *   stored as        centimetres  (products.width_cm / height_cm / depth_cm)
 *        ↓           centimetresToMetres()
 *   AR works in      metres       (WebXR's unit, and glTF's)
 *
 * Everything that converts a furniture length goes through here: the store
 * portal form, its 3D preview, the AR size readout and the scale resolver.
 * None of them writes 2.54 or 30.48 itself.
 *
 * The room scanner's m / cm / mm readout (app/plan/ar-engine.js, state.units)
 * is a separate concern and deliberately not merged into this: a room is read
 * in metres and millimetres, a sofa in centimetres, inches or feet.
 */

/** Centimetres in one of each unit. Exact by definition (1 in = 2.54 cm). */
export const CM_PER_UNIT = Object.freeze({ cm: 1, in: 2.54, ft: 30.48 });

/** The units a store owner or shopper can choose, in the order they are offered. */
export const FURNITURE_UNITS = Object.freeze([
  { id: 'cm', label: 'Centimeters (cm)', short: 'cm' },
  { id: 'in', label: 'Inches (in)', short: 'in' },
  { id: 'ft', label: 'Feet (ft)', short: 'ft' }
]);

/** The unit dimensions are persisted in. */
export const CANONICAL_UNIT = 'cm';

/**
 * What the database accepts, per axis, in centimetres.
 *
 * products.width_cm etc. are numeric(6,1) with `> 0 and <= 1000`
 * (supabase/migrations/0001_init.sql). One decimal place means anything under
 * 0.05 cm rounds to 0 and is refused, so the smallest storable length is 0.1 cm.
 */
export const DIMENSION_LIMITS_CM = Object.freeze({ min: 0.1, max: 1000 });

/**
 * Above this on any axis a value is legal but unusual enough to ask about.
 * 5 m covers a long sectional sofa or a wardrobe run; anything larger is
 * usually the wrong unit (900 in typed where 900 cm was meant).
 */
export const DIMENSION_WARNING_CM = 500;

/** Decimal places a length is SHOWN with, per unit. Storage is not rounded here. */
const DISPLAY_DIGITS = Object.freeze({ cm: 1, in: 2, ft: 2 });

/** Decimal places a form field is filled with, per unit: enough to round-trip. */
const INPUT_DIGITS = Object.freeze({ cm: 1, in: 3, ft: 3 });

export function isFurnitureUnit(unit) {
  return Object.hasOwn(CM_PER_UNIT, unit);
}

function assertUnit(unit) {
  if (!isFurnitureUnit(unit)) throw new RangeError(`Unknown furniture unit: ${unit}`);
}

/** A length in `unit`, as centimetres. */
export function toCentimeters(value, unit) {
  assertUnit(unit);
  return Number(value) * CM_PER_UNIT[unit];
}

/** A length in centimetres, as `unit`. */
export function fromCentimeters(centimetres, unit) {
  assertUnit(unit);
  return Number(centimetres) / CM_PER_UNIT[unit];
}

/** The AR boundary: centimetres in, metres out. */
export function centimetersToMeters(centimetres) {
  return Number(centimetres) / 100;
}

/** Width, depth and height together, in centimetres. */
export function dimensionsToCentimeters(dimensions, unit) {
  return {
    width: toCentimeters(dimensions.width, unit),
    depth: toCentimeters(dimensions.depth, unit),
    height: toCentimeters(dimensions.height, unit)
  };
}

/** Width, depth and height in centimetres, as `unit`. */
export function dimensionsFromCentimeters(dimensionsCm, unit) {
  return {
    width: fromCentimeters(dimensionsCm.width, unit),
    depth: fromCentimeters(dimensionsCm.depth, unit),
    height: fromCentimeters(dimensionsCm.height, unit)
  };
}

/** Width, depth and height in centimetres, as metres for WebXR. */
export function dimensionsToMeters(dimensionsCm) {
  return {
    width: centimetersToMeters(dimensionsCm.width),
    depth: centimetersToMeters(dimensionsCm.depth),
    height: centimetersToMeters(dimensionsCm.height)
  };
}

/** Any unit to any unit, through centimetres. */
export function convertDimensions(dimensions, fromUnit, toUnit) {
  return dimensionsFromCentimeters(dimensionsToCentimeters(dimensions, fromUnit), toUnit);
}

/**
 * Round to the precision the database keeps (0.1 cm), so what is saved is what
 * is shown back. 11.811 in → 29.99994 cm → 30.0 cm.
 */
export function roundForStorage(centimetres) {
  return Math.round(Number(centimetres) * 10) / 10;
}

function trim(value, digits) {
  // Fixed digits, then drop trailing zeros: 30.0 → "30", 11.81 stays.
  return String(Number(value.toFixed(digits)));
}

/** The number a form field shows for a length stored in centimetres. */
export function inputValue(centimetres, unit) {
  if (!Number.isFinite(centimetres)) return '';
  return trim(fromCentimeters(centimetres, unit), INPUT_DIGITS[unit]);
}

/** One length, with its unit: "30 cm", "11.81 in", "0.98 ft". */
export function formatLength(centimetres, unit = CANONICAL_UNIT) {
  assertUnit(unit);
  return `${trim(fromCentimeters(centimetres, unit), DISPLAY_DIGITS[unit])} ${unit}`;
}

/**
 * Width × depth × height, one unit at the end: "30 × 30 × 40 cm".
 * The order matches the product page and the AR readout.
 */
export function formatDimensions(dimensionsCm, unit = CANONICAL_UNIT) {
  assertUnit(unit);
  const digits = DISPLAY_DIGITS[unit];
  const part = axis => trim(fromCentimeters(dimensionsCm[axis], unit), digits);
  return `${part('width')} × ${part('depth')} × ${part('height')} ${unit}`;
}

/** Width × depth only, for a floor footprint: "31 × 35 cm". Same digits as above. */
export function formatFootprint(dimensionsCm, unit = CANONICAL_UNIT) {
  assertUnit(unit);
  const digits = DISPLAY_DIGITS[unit];
  const part = axis => trim(fromCentimeters(dimensionsCm[axis], unit), digits);
  return `${part('width')} × ${part('depth')} ${unit}`;
}

/**
 * Is this a length the database will store?
 *
 * Returns null when it is, or a sentence naming the problem and the limit in
 * the unit the person is typing in, so "999 ft" is refused before it is
 * converted and sent, not after the database rejects it.
 */
export function dimensionProblem(value, unit, axisLabel = 'This size') {
  assertUnit(unit);
  const number = typeof value === 'string' ? Number(value.trim() === '' ? NaN : value) : Number(value);
  if (!Number.isFinite(number)) return `${axisLabel} is needed, as a number.`;
  if (number <= 0) return `${axisLabel} must be more than zero.`;
  const centimetres = toCentimeters(number, unit);
  if (roundForStorage(centimetres) < DIMENSION_LIMITS_CM.min) {
    return `${axisLabel} is too small to store. The smallest is ${formatLength(DIMENSION_LIMITS_CM.min, 'cm')}.`;
  }
  if (centimetres > DIMENSION_LIMITS_CM.max) {
    return `${axisLabel} is over the ${formatLength(DIMENSION_LIMITS_CM.max, unit)} limit (${formatLength(DIMENSION_LIMITS_CM.max, 'cm')}).`;
  }
  return null;
}

/** True when a valid length is large enough to be worth a second look. */
export function isUnusuallyLarge(centimetres) {
  return Number(centimetres) > DIMENSION_WARNING_CM;
}
