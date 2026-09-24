/**
 * A unit is a way of writing a length, not a length.
 *
 * Every assertion here is the same claim from a different side: switching
 * between centimetres, inches and feet changes the numbers people read and
 * never the size of the furniture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toCentimeters, fromCentimeters, centimetersToMeters, dimensionsToMeters,
  convertDimensions, dimensionsToCentimeters, dimensionsFromCentimeters,
  formatDimensions, formatLength, inputValue, roundForStorage, dimensionProblem,
  DIMENSION_LIMITS_CM
} from '../lib/spatial/units.mjs';

const close = (actual, expected, tolerance = 1e-9, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);

test('30 cm is 11.8110236… in and 0.9842519… ft', () => {
  close(fromCentimeters(30, 'in'), 11.811023622047244);
  close(fromCentimeters(30, 'ft'), 0.984251968503937);
});

test('12 in is 30.48 cm, 1 ft is 30.48 cm, 3 ft is 91.44 cm', () => {
  close(toCentimeters(12, 'in'), 30.48);
  close(toCentimeters(1, 'ft'), 30.48);
  close(toCentimeters(3, 'ft'), 91.44);
});

test('cm → in → ft → cm returns the same physical length', () => {
  for (const start of [30, 0.1, 88, 240, 999.9]) {
    const inches = fromCentimeters(start, 'in');
    const feet = fromCentimeters(toCentimeters(inches, 'in'), 'ft');
    const back = toCentimeters(feet, 'ft');
    close(back, start, 1e-9, `${start} cm round trip`);
  }
});

test('the brief\'s example: 30 × 30 × 40 cm, stored, sent to AR, and shown in three units', () => {
  const entered = { width: 30, depth: 30, height: 40 };
  const storedCm = dimensionsToCentimeters(entered, 'cm');
  assert.deepEqual(
    { width_cm: roundForStorage(storedCm.width), depth_cm: roundForStorage(storedCm.depth), height_cm: roundForStorage(storedCm.height) },
    { width_cm: 30, depth_cm: 30, height_cm: 40 }
  );

  const ar = dimensionsToMeters(storedCm);
  close(ar.width, 0.30); close(ar.depth, 0.30); close(ar.height, 0.40);

  const inches = dimensionsFromCentimeters(storedCm, 'in');
  close(inches.width, 11.811, 5e-4); close(inches.depth, 11.811, 5e-4); close(inches.height, 15.748, 5e-4);

  const feet = dimensionsFromCentimeters(storedCm, 'ft');
  close(feet.width, 0.984, 5e-4); close(feet.depth, 0.984, 5e-4); close(feet.height, 1.312, 5e-4);

  // Switching the display never touches what AR receives.
  for (const unit of ['cm', 'in', 'ft']) {
    const shown = dimensionsFromCentimeters(storedCm, unit);
    const backToMetres = dimensionsToMeters(dimensionsToCentimeters(shown, unit));
    close(backToMetres.width, 0.30, 1e-12, unit); close(backToMetres.height, 0.40, 1e-12, unit);
  }
});

test('a field filled in inches, then saved, stores the centimetres it started from', () => {
  // The form shows 3 decimals in inches and feet so that re-reading the field
  // and rounding to the database's 0.1 cm gives back exactly what was stored.
  for (const cm of [30, 40, 70, 78, 88, 0.1, 1000, 123.4]) {
    for (const unit of ['in', 'ft']) {
      const shown = Number(inputValue(cm, unit));
      assert.equal(roundForStorage(toCentimeters(shown, unit)), cm, `${cm} cm via ${unit} (${shown})`);
    }
  }
});

test('convertDimensions goes through centimetres, not around them', () => {
  const inches = convertDimensions({ width: 30, depth: 30, height: 40 }, 'cm', 'in');
  const feet = convertDimensions(inches, 'in', 'ft');
  const cm = convertDimensions(feet, 'ft', 'cm');
  close(cm.width, 30, 1e-9); close(cm.height, 40, 1e-9);
});

test('formatting: one unit at the end, width × depth × height', () => {
  const size = { width: 30, depth: 30, height: 40 };
  assert.equal(formatDimensions(size, 'cm'), '30 × 30 × 40 cm');
  assert.equal(formatDimensions(size, 'in'), '11.81 × 11.81 × 15.75 in');
  assert.equal(formatDimensions(size, 'ft'), '0.98 × 0.98 × 1.31 ft');
  assert.equal(formatLength(30, 'in'), '11.81 in');
  assert.equal(centimetersToMeters(30), 0.3);
});

test('what the database will refuse is refused before it is sent, in the owner\'s unit', () => {
  assert.equal(dimensionProblem('30', 'cm'), null);
  assert.equal(dimensionProblem('11.811', 'in'), null);
  assert.match(dimensionProblem('', 'cm', 'Width'), /Width is needed/);
  assert.match(dimensionProblem('abc', 'cm', 'Width'), /as a number/);
  assert.match(dimensionProblem('0', 'cm', 'Depth'), /more than zero/);
  assert.match(dimensionProblem('-4', 'in', 'Height'), /more than zero/);
  assert.match(dimensionProblem('NaN', 'ft'), /number/);
  assert.match(dimensionProblem('Infinity', 'cm'), /number/);
  // 999 ft is 30 450 cm: over the 1000 cm column limit. Said in feet.
  assert.match(dimensionProblem('999', 'ft', 'Width'), /over the 32\.81 ft limit \(1000 cm\)/);
  // Exactly at the limit is allowed; just under the smallest storable is not.
  assert.equal(dimensionProblem(String(DIMENSION_LIMITS_CM.max), 'cm'), null);
  assert.match(dimensionProblem('0.01', 'cm'), /too small to store/);
  // Decimals are allowed.
  assert.equal(dimensionProblem('45.5', 'cm'), null);
});

test('an unknown unit is an error, never a silent 1:1', () => {
  assert.throws(() => toCentimeters(1, 'm'), RangeError);
  assert.throws(() => fromCentimeters(1, 'yards'), RangeError);
});
