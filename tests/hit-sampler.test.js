/**
 * A single hit-test frame is not a room corner, and a stable hit is not a
 * floor. These tests hold the capture and floor logic to both rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HitSampler, evaluateTarget, FloorReference, roomAcceptance, compareScans,
  normalFromOrientation, TARGET
} from '../lib/spatial/hit-sampler.mjs';
import { roomDimensions } from '../lib/spatial/room.mjs';

const UP = { x: 0, y: 1, z: 0 };

// Deterministic noise, so a failure reproduces.
function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }

function fill(sampler, { at = { x: 1, y: 0, z: -2 }, noise = 0.004, count = 14, dt = 33, normal = UP, seed = 7 } = {}) {
  const r = rng(seed);
  for (let i = 0; i < count; i += 1) {
    sampler.push({ x: at.x + r() * 2 * noise, y: at.y + r() * 2 * noise, z: at.z + r() * 2 * noise }, i * dt, normal);
  }
  return count * dt;
}

test('a steady run gives the median point and a small spread', () => {
  const s = new HitSampler();
  fill(s);
  const e = s.estimate();
  assert.ok(e.stable, e.reason);
  assert.ok(Math.abs(e.point.x - 1) < 0.005 && Math.abs(e.point.z + 2) < 0.005);
  assert.ok(e.spread < 0.01);
});

test('one bad frame does not move the corner (outlier rejection)', () => {
  const s = new HitSampler();
  const end = fill(s);
  s.push({ x: 1.4, y: 0.3, z: -1.5 }, end);            // a 50 cm jump on the tap frame
  const e = s.estimate();
  assert.ok(e.stable, e.reason);
  assert.ok(Math.hypot(e.point.x - 1, e.point.z + 2) < 0.01, 'the corner stayed put');
  assert.equal(e.inliers, e.count - 1);
});

test('too few samples is "hold still", not a corner', () => {
  const s = new HitSampler();
  fill(s, { count: 3 });
  const e = s.estimate();
  assert.equal(e.stable, false);
  assert.match(e.reason, /Hold still/);
});

test('a moving target is refused with how much it moved', () => {
  const s = new HitSampler();
  fill(s, { noise: 0.12 });
  const e = s.estimate();
  assert.equal(e.stable, false);
  assert.match(e.reason, /moving by about \d+ cm/);
});

test('old samples age out of the window, even across frames with no hit', () => {
  const s = new HitSampler();
  fill(s);
  s.miss(5000);
  assert.equal(s.estimate().count, 0);
  assert.equal(s.estimate().point, null);
});

test('the hit pose +Y axis is the surface normal', () => {
  const n = normalFromOrientation({ x: 0, y: 0, z: 0, w: 1 });
  assert.deepEqual(n, { x: 0, y: 1, z: 0 });
  // Rotated 90 degrees about X: +Y becomes +Z (a wall facing the viewer).
  const s = Math.SQRT1_2;
  const wall = normalFromOrientation({ x: s, y: 0, z: 0, w: s });
  assert.ok(Math.abs(wall.y) < 1e-9 && Math.abs(wall.z - 1) < 1e-9);
});

test('a steady WALL is not a floor (Y stability alone is not flatness)', () => {
  const s = new HitSampler();
  fill(s, { normal: { x: 0, y: 0, z: 1 }, noise: 0.002 });
  const verdict = evaluateTarget({ estimate: s.estimate() });
  assert.equal(verdict.state, TARGET.INVALID);
});

test('a steady hit with no orientation data is UNCERTAIN, never FLAT', () => {
  const s = new HitSampler();
  fill(s, { normal: null });
  assert.equal(evaluateTarget({ estimate: s.estimate() }).state, TARGET.UNCERTAIN);
});

test('a plane elsewhere in the session does not make this hit a floor', () => {
  const s = new HitSampler();
  fill(s, { normal: null });
  // Only an explicit "this hit is on a horizontal plane" counts.
  assert.equal(evaluateTarget({ estimate: s.estimate(), onHorizontalPlane: false }).state, TARGET.UNCERTAIN);
  assert.equal(evaluateTarget({ estimate: s.estimate(), onHorizontalPlane: true }).state, TARGET.VALID);
});

test('an upward-facing steady hit is a valid floor; no hit is searching', () => {
  const s = new HitSampler();
  fill(s);
  assert.equal(evaluateTarget({ estimate: s.estimate() }).state, TARGET.VALID);
  assert.equal(evaluateTarget({ estimate: new HitSampler().estimate() }).state, TARGET.SEARCHING);
});

test('a flat table top at chest height is not the floor (local-floor)', () => {
  const s = new HitSampler();
  fill(s, { at: { x: 0, y: 0.75, z: -1 } });
  const verdict = evaluateTarget({ estimate: s.estimate(), viewerY: 1.2 });
  assert.equal(verdict.state, TARGET.INVALID);
});

test('floor reference: a corner on a low table is refused, not flattened', () => {
  const floor = new FloorReference();
  floor.accept({ x: 0, y: -1.42, z: 0 });
  assert.equal(floor.check({ x: 2, y: -1.40, z: 0 }).ok, true);
  const table = floor.check({ x: 2, y: -1.00, z: 0 });
  assert.equal(table.ok, false);
  assert.match(table.reason, /42 cm above the floor/);
  // The old rule accepted anything within 25 cm; a 20 cm step is now refused too.
  assert.equal(floor.check({ x: 2, y: -1.22, z: 0 }).ok, false);
});

test('floor reference uses the median, so one low mistap cannot drag the floor down', () => {
  const floor = new FloorReference();
  for (const y of [-1.40, -1.41, -1.39, -1.40]) floor.accept({ y });
  floor.accept({ y: -1.45 });
  assert.ok(Math.abs(floor.estimatedFloorY - -1.40) < 0.005);
  assert.ok(floor.floorUncertainty < 0.061);
});

const square = (side, spread = 0.01) => [
  { x: 0, y: 0, z: 0, spread }, { x: side, y: 0, z: 0, spread },
  { x: side, y: 0, z: side, spread }, { x: 0, y: 0, z: side, spread }
];
const roomOf = corners => roomDimensions([{ orientation: 'horizontal', polygon: corners.map(c => ({ x: c.x, y: 0, z: c.z })) }], { minFloorArea: 0.5 });

test('a room is not usable just because enough points exist', () => {
  const corners = square(3);
  assert.equal(roomAcceptance({ corners, closed: false, room: roomOf(corners) }).ready, false);
  assert.equal(roomAcceptance({ corners, closed: true, room: roomOf(corners) }).ready, true);
  const shaky = square(3, 0.09);
  const verdict = roomAcceptance({ corners: shaky, closed: true, room: roomOf(shaky) });
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /moved by 9 cm/);
});

test('a room with corners at different heights, or of absurd size, is refused', () => {
  const uneven = square(3).map((c, i) => ({ ...c, y: i === 2 ? 0.4 : 0 }));
  assert.equal(roomAcceptance({ corners: uneven, closed: true, room: roomOf(uneven) }).ready, false);
  const tiny = square(0.4);
  assert.equal(roomAcceptance({ corners: tiny, closed: true, room: roomOf(tiny) }).ready, false);
  const huge = square(40);
  assert.equal(roomAcceptance({ corners: huge, closed: true, room: roomOf(huge) }).ready, false);
});

test('repeat scans: agreement is repeatability, and disagreement says by how much', () => {
  const a = roomOf(square(3));
  const b = roomOf(square(3.05));
  const c = roomOf(square(3.4));
  const ok = compareScans(a, b);
  assert.equal(ok.agrees, true);
  assert.equal(ok.kind, 'repeatability');
  const bad = compareScans(a, c);
  assert.equal(bad.agrees, false);
  assert.match(bad.reason, /differ by 40 cm/);
});
