/**
 * Room measurement, tested against rooms whose dimensions are known in
 * advance — not against the app's own output.
 *
 * The case that matters most is the rotated room. A real scan never starts
 * square to the walls: the tracking origin is wherever the phone was when the
 * session began. A naive axis-aligned bounding box measures a diagonal and
 * reports a room tens of centimetres too big in both directions, which is
 * exactly the error that makes a fit verdict say yes when the answer is no.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convexHull,
  minimumAreaRectangle,
  classifySurfaces,
  roomDimensions,
  fitInRoom,
  footprintArea
} from '../lib/spatial/room.mjs';

const p = (x, y, z) => ({ x, y, z });

/** A rectangular floor, optionally rotated about the origin by `angle`. */
function floorRect(length, width, { angle = 0, y = 0 } = {}) {
  const half = [[-length / 2, -width / 2], [length / 2, -width / 2],
                [length / 2, width / 2], [-length / 2, width / 2]];
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    orientation: 'horizontal',
    polygon: half.map(([u, v]) => p(u * cos - v * sin, y, u * sin + v * cos))
  };
}

/* ------------------------------------------------------------- basics --- */

test('footprint area of a known rectangle', () => {
  assert.ok(Math.abs(footprintArea(floorRect(4, 3).polygon) - 12) < 1e-9);
});

test('the hull of a square with a point inside it is still the square', () => {
  const points = [p(0, 0, 0), p(4, 0, 0), p(4, 0, 3), p(0, 0, 3), p(2, 0, 1.5)];
  assert.equal(convexHull(points).length, 4);
});

/* ------------------------------------------- the rotated-room property -- */

test('an axis-aligned room measures correctly', () => {
  const rect = minimumAreaRectangle(floorRect(4.81, 3.42).polygon);
  assert.ok(Math.abs(rect.length - 4.81) < 1e-6, `length ${rect.length}`);
  assert.ok(Math.abs(rect.width - 3.42) < 1e-6, `width ${rect.width}`);
});

test('a room rotated off the tracking axes still measures correctly', () => {
  // This is the whole point of the minimum-area rectangle.
  for (const degrees of [5, 17, 30, 45, 63, 88, 120, 175]) {
    const angle = (degrees * Math.PI) / 180;
    const rect = minimumAreaRectangle(floorRect(4.81, 3.42, { angle }).polygon);
    assert.ok(
      Math.abs(rect.length - 4.81) < 1e-6,
      `at ${degrees}deg length came out ${rect.length.toFixed(4)}, expected 4.81`
    );
    assert.ok(
      Math.abs(rect.width - 3.42) < 1e-6,
      `at ${degrees}deg width came out ${rect.width.toFixed(4)}, expected 3.42`
    );
  }
});

test('the naive axis-aligned box really would have been wrong', () => {
  // The negative control for the test above: prove the simpler method fails,
  // so the rotating calipers are demonstrably earning their place.
  const angle = (30 * Math.PI) / 180;
  const polygon = floorRect(4.81, 3.42, { angle }).polygon;
  const xs = polygon.map(q => q.x);
  const zs = polygon.map(q => q.z);
  const naiveLong = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  assert.ok(
    naiveLong > 4.81 + 0.3,
    `an axis-aligned box should badly overstate this room; it gave ${naiveLong.toFixed(2)} m`
  );
  // And the real one does not.
  assert.ok(Math.abs(minimumAreaRectangle(polygon).length - 4.81) < 1e-6);
});

test('a ragged scan is not shrunk by a concave notch', () => {
  // Scans come back with dents where tracking was unsure. The room is still
  // the room.
  const polygon = [
    p(0, 0, 0), p(4, 0, 0), p(4, 0, 3),
    p(2, 0, 2.6),                        // a notch pushed inwards
    p(0, 0, 3)
  ];
  const rect = minimumAreaRectangle(polygon);
  assert.ok(Math.abs(rect.length - 4) < 1e-6);
  assert.ok(Math.abs(rect.width - 3) < 1e-6);
});

test('too few points is null, not a guess', () => {
  assert.equal(minimumAreaRectangle([p(0, 0, 0), p(1, 0, 1)]), null);
});

/* ------------------------------------------------------ classification -- */

test('a coffee table does not become the floor', () => {
  const surfaces = [
    floorRect(4, 3, { y: 0 }),
    { ...floorRect(1.1, 0.6, { y: 0.45 }) }     // a table top, 0.66 m^2
  ];
  const { floor, surfacesAbove } = classifySurfaces(surfaces);
  assert.ok(Math.abs(footprintArea(floor.polygon) - 12) < 1e-6, 'the 12 m^2 plane is the floor');
  assert.equal(surfacesAbove.length, 1, 'the table is kept, but as an obstacle');
});

test('a large low plane under the real floor does not win on height alone', () => {
  // Both are big enough to be floors; the lower one is the floor. This is the
  // documented behaviour, asserted so a change to it is deliberate.
  const surfaces = [floorRect(4, 3, { y: 0 }), floorRect(4, 3, { y: -0.6 })];
  const { floor } = classifySurfaces(surfaces);
  assert.ok(floor.y.min < -0.5);
});

test('a ceiling is only a ceiling when it is well above the floor', () => {
  const near = classifySurfaces([floorRect(4, 3, { y: 0 }), floorRect(4, 3, { y: 1.0 })]);
  assert.equal(near.ceiling, null, '1.0 m up is a mezzanine or a bunk, not a ceiling');

  const real = classifySurfaces([floorRect(4, 3, { y: 0 }), floorRect(4, 3, { y: 2.7 })]);
  assert.ok(real.ceiling, '2.7 m up is a ceiling');
});

/* --------------------------------------------------------- dimensions --- */

const wall = (height, z) => ({
  orientation: 'vertical',
  polygon: [p(-2, 0, z), p(2, 0, z), p(2, height, z), p(-2, height, z)]
});

test('a fully scanned room reports length, width and height', () => {
  const room = roomDimensions([
    floorRect(4.81, 3.42, { y: 0 }),
    floorRect(4.81, 3.42, { y: 2.70 }),
    wall(2.70, -1.71)
  ]);
  assert.ok(Math.abs(room.length - 4.81) < 1e-6);
  assert.ok(Math.abs(room.width - 3.42) < 1e-6);
  assert.ok(Math.abs(room.height - 2.70) < 1e-6);
  assert.equal(room.heightSource, 'ceiling');
  assert.deepEqual(room.missing, []);
  assert.equal(room.complete, true);
});

test('with no ceiling the height comes from the walls, and says so', () => {
  const room = roomDimensions([floorRect(4, 3, { y: 0 }), wall(2.1, -1.5)]);
  assert.ok(Math.abs(room.height - 2.1) < 1e-6);
  assert.equal(room.heightSource, 'wall-extent', 'not presented as a ceiling measurement');
  assert.equal(room.complete, true);
});

test('with no ceiling and no walls the height is null and named as missing', () => {
  const room = roomDimensions([floorRect(4, 3, { y: 0 })]);
  assert.equal(room.height, null);
  assert.ok(room.missing.includes('height'));
  assert.equal(room.complete, false);
  // But the floor it did measure is still reported.
  assert.ok(Math.abs(room.length - 4) < 1e-6);
});

test('a wall stub from tracking noise does not become a room height', () => {
  const room = roomDimensions([floorRect(4, 3, { y: 0 }), wall(0.3, -1.5)]);
  assert.equal(room.height, null, '30 cm of wall is not a room height');
  assert.ok(room.missing.includes('height'));
});

test('no floor means no room, stated rather than approximated', () => {
  const room = roomDimensions([wall(2.4, -1.5)]);
  assert.equal(room.length, null);
  assert.equal(room.width, null);
  assert.equal(room.height, null);
  assert.ok(room.missing.includes('floor'));
  assert.equal(room.complete, false);
});

test('nothing detected at all is handled', () => {
  const room = roomDimensions([]);
  assert.equal(room.complete, false);
  assert.ok(room.missing.includes('floor'));
});

test('malformed surfaces are skipped, not crashed on', () => {
  const room = roomDimensions([
    null,
    { orientation: 'horizontal' },
    { orientation: 'horizontal', polygon: [p(0, 0, 0)] },
    floorRect(4, 3, { y: 0 })
  ]);
  assert.ok(Math.abs(room.length - 4) < 1e-6);
});

/* --------------------------------------------------------------- fit ---- */

const ROOM = roomDimensions([
  floorRect(4.81, 3.42, { y: 0 }),
  floorRect(4.81, 3.42, { y: 2.70 })
]);

test('a sofa that fits is told so, with the space left over', () => {
  const verdict = fitInRoom(ROOM, { width: 2.10, depth: 0.90, height: 0.75 });
  assert.equal(verdict.fits, true);
  assert.ok(verdict.spare.along > 2.7 && verdict.spare.across > 2.5);
});

test('a piece is allowed to be rotated, because anyone would', () => {
  // 3.3 m long: too long for the 3.42 m side only if you refuse to turn it.
  const verdict = fitInRoom(ROOM, { width: 0.8, depth: 3.3, height: 0.75 });
  assert.equal(verdict.fits, true);
});

test('a piece too big for the room is told which way, and by how much', () => {
  const verdict = fitInRoom(ROOM, { width: 5.5, depth: 0.9, height: 0.75 });
  assert.equal(verdict.fits, false);
  assert.match(verdict.reason, /69 cm/);
  assert.match(verdict.reason, /longest/);
});

test('clearance is counted on both sides', () => {
  const tight = fitInRoom(ROOM, { width: 4.5, depth: 0.9, height: 0.75 }, { clearance: 0.3 });
  assert.equal(tight.fits, false, '4.5 + 0.3 + 0.3 = 5.1 m does not fit 4.81 m');
  assert.match(tight.reason, /clearance/);
});

test('a piece taller than a measured ceiling is refused on height', () => {
  const verdict = fitInRoom(ROOM, { width: 1, depth: 1, height: 3.0 });
  assert.equal(verdict.fits, false);
  assert.match(verdict.reason, /Taller than the room/);
});

test('an unmeasured ceiling is not treated as a low one', () => {
  const noCeiling = roomDimensions([floorRect(4.81, 3.42, { y: 0 })]);
  const verdict = fitInRoom(noCeiling, { width: 1, depth: 1, height: 3.0 });
  assert.equal(verdict.fits, true, 'height cannot disqualify what was never measured');
});

test('fitting against an unmeasured room says so instead of answering', () => {
  const verdict = fitInRoom({ rectangle: null }, { width: 1, depth: 1, height: 1 });
  assert.equal(verdict.fits, null);
  assert.match(verdict.reason, /not been measured/);
});
