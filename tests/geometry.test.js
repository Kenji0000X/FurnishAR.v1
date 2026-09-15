/**
 * Validation of the measurement mathematics — the panel's "validation of
 * accurate area measurement", done against shapes whose answers are known in
 * advance rather than against the app's own output.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const geometry = import(pathToFileURL(path.resolve(__dirname, '../public/geometry.js')).href);

/** A point on the floor plane, y = height in metres. */
const p = (x, z, y = 0) => ({ x, y, z });

test('distance: a 3-4-5 triangle closes at 5 m', async () => {
  const { distance3D, distanceOnFloor } = await geometry;
  assert.equal(distance3D(p(0, 0), p(3, 4)), 5);
  assert.equal(distanceOnFloor(p(0, 0), p(3, 4)), 5);
});

test('distance on the floor ignores height, distance in space does not', async () => {
  const { distance3D, distanceOnFloor } = await geometry;
  const a = p(0, 0, 0);
  const b = p(3, 4, 12);            // 5 m across the floor, 12 m up
  assert.equal(distanceOnFloor(a, b), 5);
  assert.equal(distance3D(a, b), 13); // 5-12-13
});

test('area: a 1 m square measures 1.00 m²', async () => {
  const { polygonArea } = await geometry;
  assert.equal(polygonArea([p(0, 0), p(1, 0), p(1, 1), p(0, 1)]), 1);
});

test('area: a 4 m × 3 m room measures 12 m², whichever way it is walked', async () => {
  const { polygonArea } = await geometry;
  const clockwise = [p(0, 0), p(4, 0), p(4, 3), p(0, 3)];
  const anticlockwise = [...clockwise].reverse();
  assert.equal(polygonArea(clockwise), 12);
  assert.equal(polygonArea(anticlockwise), 12, 'winding order must not flip the sign');
});

test('area: an L-shaped room is measured correctly', async () => {
  const { polygonArea } = await geometry;
  // 4×4 square with a 2×2 bite taken out of one corner = 16 - 4 = 12
  const lShape = [p(0, 0), p(4, 0), p(4, 2), p(2, 2), p(2, 4), p(0, 4)];
  assert.equal(polygonArea(lShape), 12);
});

test('area: a triangle is half its bounding rectangle', async () => {
  const { polygonArea } = await geometry;
  assert.equal(polygonArea([p(0, 0), p(4, 0), p(0, 3)]), 6);
});

test('area: fewer than three points has no area', async () => {
  const { polygonArea } = await geometry;
  assert.equal(polygonArea([p(0, 0), p(1, 1)]), 0);
  assert.equal(polygonArea([]), 0);
  assert.equal(polygonArea(null), 0);
});

test('area: floor height does not change the answer', async () => {
  const { polygonArea } = await geometry;
  // Same outline, captured 1.2 m below the phone with a little tracking jitter.
  const room = [p(0, 0, -1.2), p(4, 0, -1.19), p(4, 3, -1.21), p(0, 3, -1.2)];
  assert.equal(polygonArea(room), 12);
});

test('perimeter: a 4 m × 3 m room is 14 m around', async () => {
  const { perimeter } = await geometry;
  assert.equal(perimeter([p(0, 0), p(4, 0), p(4, 3), p(0, 3)]), 14);
});

test('a crossed outline is rejected rather than reported as an area', async () => {
  const { isSimplePolygon } = await geometry;
  assert.equal(isSimplePolygon([p(0, 0), p(4, 0), p(4, 3), p(0, 3)]), true);
  // A bowtie: the taps went in the wrong order.
  assert.equal(isSimplePolygon([p(0, 0), p(4, 0), p(0, 3), p(4, 3)]), false);
});

test('planarity: flat floors read near zero, a tap on a table does not', async () => {
  const { planarityRms } = await geometry;
  const flat = [p(0, 0, -1.2), p(4, 0, -1.2), p(4, 3, -1.2), p(0, 3, -1.2)];
  assert.equal(planarityRms(flat), 0);

  const jittery = [p(0, 0, -1.20), p(4, 0, -1.21), p(4, 3, -1.19), p(0, 3, -1.20)];
  assert.ok(planarityRms(jittery) < 0.02, 'a centimetre of tracking noise stays acceptable');

  const onFurniture = [p(0, 0, -1.2), p(4, 0, -1.2), p(4, 3, -0.45), p(0, 3, -1.2)];
  assert.ok(planarityRms(onFurniture) > 0.05, 'a point 75 cm up must be caught');
});

test('two scans are reconciled by the panel\'s 5% rule', async () => {
  const { reconcileReadings } = await geometry;

  const close = reconcileReadings(120, 123);
  assert.equal(close.agrees, true);
  assert.equal(close.value, 121.5, 'accepted readings are averaged');
  assert.ok(close.difference < 5);

  const apart = reconcileReadings(120, 140);
  assert.equal(apart.agrees, false);
  assert.ok(Math.abs(apart.difference - 16.667) < 0.01);

  // Exactly on the boundary is accepted, not rejected.
  assert.equal(reconcileReadings(100, 105).agrees, true);
  assert.equal(reconcileReadings(100, 105.1).agrees, false);
});

test('confidence falls when the scan is unreliable', async () => {
  const { areaConfidence } = await geometry;
  const flat = [p(0, 0, -1.2), p(4, 0, -1.2), p(4, 3, -1.2), p(0, 3, -1.2)];

  assert.equal(areaConfidence({ points: flat, difference: 1 }).level, 'high');
  assert.equal(areaConfidence({ points: flat, difference: 3 }).level, 'medium');
  assert.equal(areaConfidence({ points: flat, difference: 9 }).level, 'low');

  const onFurniture = [p(0, 0, -1.2), p(4, 0, -1.2), p(4, 3, -0.45), p(0, 3, -1.2)];
  const shaky = areaConfidence({ points: onFurniture, difference: 0 });
  assert.equal(shaky.level, 'low');
  assert.match(shaky.reasons.join(' '), /flat surface/);

  const bowtie = areaConfidence({ points: [p(0, 0), p(4, 0), p(0, 3), p(4, 3)], difference: 0 });
  assert.equal(bowtie.level, 'low');
  assert.match(bowtie.reasons.join(' '), /crosses itself/);
});

test('footprint: the armchair occupies 0.546 m²', async () => {
  const { footprintArea } = await geometry;
  // 70 cm × 78 cm
  assert.ok(Math.abs(footprintArea({ width: 70, depth: 78 }) - 0.546) < 1e-9);
});

test('fit against a measured floor area, with the comfort margin', async () => {
  const { fitAgainstArea } = await geometry;
  const armchair = { width: 70, depth: 78 };

  const roomy = fitAgainstArea(armchair, 12);
  assert.equal(roomy.fits, true);
  assert.ok(Math.abs(roomy.shareOfFloor - 0.0455) < 0.001, 'about 4.6% of a 12 m² room');
  assert.ok(Math.abs(roomy.remaining - 11.454) < 1e-6);

  // 0.8 m² of free floor: the chair itself fits, but not with 5 cm around it.
  const tight = fitAgainstArea(armchair, 0.6);
  assert.equal(tight.fits, false);
  assert.ok(tight.withMargin > tight.footprint);

  assert.equal(fitAgainstArea(armchair, 0).fits, false, 'no measurement is not a pass');
});

test('fit against a linear clearance keeps the 5 cm rule', async () => {
  const { fitAgainstClearance } = await geometry;
  const armchair = { width: 70, depth: 78 };
  assert.equal(fitAgainstClearance(armchair, 76).fits, true);
  assert.equal(fitAgainstClearance(armchair, 75).fits, true, '70 + 5 exactly fits');
  assert.equal(fitAgainstClearance(armchair, 74).fits, false);
  assert.equal(fitAgainstClearance(armchair, 90).spare, 20);
});

test('percentage error against a tape measure reads the right way round', async () => {
  const { measurementError } = await geometry;
  assert.ok(Math.abs(measurementError(122, 120) - 1.667) < 0.01, 'reading long is positive');
  assert.ok(measurementError(118, 120) < 0, 'reading short is negative');
  assert.equal(measurementError(120, 120), 0);
});

test('readings are formatted at a sensible precision', async () => {
  const { formatArea, formatLength } = await geometry;
  assert.equal(formatArea(12.34), '12.3 m²');
  assert.equal(formatArea(0.546), '0.55 m²');
  assert.equal(formatArea(0.0546), '546 cm²');
  assert.equal(formatLength(1.234), '1.23 m');
  assert.equal(formatLength(0.76), '76.0 cm');
});
