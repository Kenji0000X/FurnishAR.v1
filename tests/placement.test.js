/**
 * Placement in a scanned room, against arrangements whose answers are known.
 *
 * Every case is run in a room ROTATED off the tracking axes, because that is
 * the only kind of room a real scan produces and because a placement test that
 * only ever runs in an axis-aligned room would pass with the room frame
 * transposed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { roomDimensions } from '../lib/spatial/room.mjs';
import {
  roomFrame, toRoom, toWorld, footprintCorners,
  placementInRoom, overlaps, assessPlacement, snapInsideRoom
} from '../lib/spatial/placement.mjs';

const p = (x, y, z) => ({ x, y, z });

/** A room of known size, rotated by `angle`, centred on the origin. */
function scannedRoom(length, width, angle = 0) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const corners = [[-length / 2, -width / 2], [length / 2, -width / 2],
                   [length / 2, width / 2], [-length / 2, width / 2]];
  return roomDimensions([{
    orientation: 'horizontal',
    polygon: corners.map(([u, v]) => p(u * cos - v * sin, 0, u * sin + v * cos))
  }]);
}

const ROOM = scannedRoom(4.81, 3.42, (25 * Math.PI) / 180);
const SOFA = { width: 2.10, depth: 0.90, height: 0.75 };

/* ------------------------------------------------------------- the frame -- */

test('the room frame round-trips a point', () => {
  const frame = roomFrame(ROOM.rectangle);
  const world = { x: 1.3, z: -0.4 };
  const back = toWorld(frame, toRoom(frame, world));
  assert.ok(Math.abs(back.x - world.x) < 1e-9);
  assert.ok(Math.abs(back.z - world.z) < 1e-9);
});

test('the frame spans the room exactly', () => {
  const frame = roomFrame(ROOM.rectangle);
  const sides = [frame.size.u, frame.size.v].sort((a, b) => b - a);
  assert.ok(Math.abs(sides[0] - 4.81) < 1e-6, `long side ${sides[0]}`);
  assert.ok(Math.abs(sides[1] - 3.42) < 1e-6, `short side ${sides[1]}`);
});

test('a room whose width exceeds its length is not transposed', () => {
  // The frame is derived from the corners, not from `rectangle.angle` plus an
  // assumption about which axis `length` refers to. This is the case that
  // catches that assumption.
  for (const [l, w] of [[4.81, 3.42], [3.42, 4.81], [2, 2]]) {
    const frame = roomFrame(scannedRoom(l, w, 0.4).rectangle);
    const sides = [frame.size.u, frame.size.v].sort((a, b) => b - a);
    assert.ok(Math.abs(sides[0] - Math.max(l, w)) < 1e-6);
    assert.ok(Math.abs(sides[1] - Math.min(l, w)) < 1e-6);
  }
});

test('a room with no rectangle has no frame', () => {
  assert.equal(roomFrame(null), null);
  assert.equal(roomFrame({ corners: [] }), null);
});

/* ---------------------------------------------------------- the footprint -- */

test('an unrotated footprint is the piece itself', () => {
  const corners = footprintCorners({ u: 0, v: 0 }, { width: 2, depth: 1 }, 0);
  const us = corners.map(c => c.u), vs = corners.map(c => c.v);
  assert.ok(Math.abs(Math.max(...us) - Math.min(...us) - 2) < 1e-9);
  assert.ok(Math.abs(Math.max(...vs) - Math.min(...vs) - 1) < 1e-9);
});

test('a footprint turned 90 degrees swaps its span', () => {
  const corners = footprintCorners({ u: 0, v: 0 }, { width: 2, depth: 1 }, Math.PI / 2);
  const us = corners.map(c => c.u), vs = corners.map(c => c.v);
  assert.ok(Math.abs(Math.max(...us) - Math.min(...us) - 1) < 1e-9);
  assert.ok(Math.abs(Math.max(...vs) - Math.min(...vs) - 2) < 1e-9);
});

/* ------------------------------------------------------ inside the room --- */

test('a sofa in the middle of the room is inside it', () => {
  const verdict = placementInRoom(ROOM, SOFA, { x: 0, z: 0, yaw: 0 });
  assert.equal(verdict.inside, true);
  assert.equal(verdict.overhang, 0);
  // 0.86 m, not the 1.2 m a first guess suggests: the sofa sits at 25 degrees
  // to the room, so its 2.10 m length eats into the short-axis margin
  // (2.10*sin25 + 0.90*cos25 = 1.70 m of span across a 3.42 m room).
  assert.ok(verdict.clearance > 0.8, `clearance ${verdict.clearance}`);
  assert.match(verdict.reason, /to the nearest wall/);
});

test('a sofa pushed through a wall is reported outside, with how far', () => {
  // Move it well past the far corner along the room's own long axis.
  const frame = roomFrame(ROOM.rectangle);
  const out = toWorld(frame, { u: frame.size.u + 0.5, v: frame.size.v / 2 });
  const verdict = placementInRoom(ROOM, SOFA, { x: out.x, z: out.z, yaw: 0 });
  assert.equal(verdict.inside, false);
  assert.ok(verdict.overhang > 1.0, `overhang ${verdict.overhang}`);
  assert.match(verdict.reason, /outside the room/);
});

test('a piece exactly against a wall counts as inside', () => {
  const frame = roomFrame(ROOM.rectangle);
  // Half the sofa's width in from the u=0 wall, aligned with the room.
  const roomHeading = Math.atan2(frame.u.z, frame.u.x);
  const spot = toWorld(frame, { u: SOFA.width / 2, v: frame.size.v / 2 });
  const verdict = placementInRoom(ROOM, SOFA, { x: spot.x, z: spot.z, yaw: roomHeading });
  assert.equal(verdict.inside, true);
  assert.ok(Math.abs(verdict.margins.u0) < 1e-6, `flush against the wall, got ${verdict.margins.u0}`);
});

test('placing into an unmeasured room says so rather than answering', () => {
  const verdict = placementInRoom({ rectangle: null }, SOFA, { x: 0, z: 0, yaw: 0 });
  assert.equal(verdict.inside, null);
  assert.match(verdict.reason, /not been measured/);
});

/* ------------------------------------------------------------ collisions -- */

const piece = (x, z, yaw, width, depth, name) => ({ x, z, yaw, width, depth, name });

test('two pieces in the same spot collide', () => {
  assert.equal(overlaps(piece(0, 0, 0, 2, 1), piece(0, 0, 0, 2, 1)), true);
});

test('two pieces well apart do not', () => {
  assert.equal(overlaps(piece(0, 0, 0, 2, 1), piece(5, 0, 0, 2, 1)), false);
});

test('pieces that only just touch are not a collision', () => {
  // Edge to edge at exactly 2.0 apart for two 2 m pieces.
  assert.equal(overlaps(piece(0, 0, 0, 2, 1), piece(2, 0, 0, 2, 1)), false);
  assert.equal(overlaps(piece(0, 0, 0, 2, 1), piece(1.99, 0, 0, 2, 1)), true);
});

test('rotation is respected, not approximated by a circle', () => {
  // A 3 m x 0.3 m bench and a 3 m x 0.3 m bench, crossed at 90 degrees at the
  // same centre, definitely overlap.
  assert.equal(overlaps(piece(0, 0, 0, 3, 0.3), piece(0, 0, Math.PI / 2, 3, 0.3)), true);

  // The same two, offset along their own lengths so they form an L that does
  // not touch. A bounding-circle test would call this a collision: both
  // circles have radius ~1.5 and their centres are 2.2 apart.
  assert.equal(overlaps(piece(0, 0, 0, 3, 0.3), piece(1.8, 1.3, Math.PI / 2, 3, 0.3)), false);
});

/* ----------------------------------------------------------- assessment --- */

test('a clear spot in an empty room is ok', () => {
  const verdict = assessPlacement(ROOM, SOFA, { x: 0, z: 0, yaw: 0 });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

test('a collision is named, not just counted', () => {
  const others = [piece(0, 0, 0, 1.1, 0.6, 'Coffee table')];
  const verdict = assessPlacement(ROOM, SOFA, { x: 0, z: 0, yaw: 0 }, others);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Coffee table/);
});

test('requested walking space is enforced and quantified', () => {
  const frame = roomFrame(ROOM.rectangle);
  const roomHeading = Math.atan2(frame.u.z, frame.u.x);
  const spot = toWorld(frame, { u: SOFA.width / 2 + 0.1, v: frame.size.v / 2 });
  const verdict = assessPlacement(
    ROOM, SOFA, { x: spot.x, z: spot.z, yaw: roomHeading }, [], { clearance: 0.6 }
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /10 cm to the nearest wall/);
  assert.match(verdict.reason, /60 cm/);
});

test('assessing against an unmeasured room answers null, not false', () => {
  // false would mean "it does not fit", which is a different claim from
  // "nobody has measured anything yet".
  const verdict = assessPlacement({ rectangle: null }, SOFA, { x: 0, z: 0, yaw: 0 });
  assert.equal(verdict.ok, null);
});

/* ---------------------------------------------------------------- snap ---- */

/* The snap lands a piece exactly against a wall, which is where floating-point
   noise decides whether "flush" counts as inside. It does. */
test('a piece hanging through a wall is moved back inside', () => {
  const frame = roomFrame(ROOM.rectangle);
  const out = toWorld(frame, { u: frame.size.u + 0.3, v: frame.size.v / 2 });
  const fixed = snapInsideRoom(ROOM, SOFA, { x: out.x, z: out.z, yaw: 0 });
  assert.equal(placementInRoom(ROOM, SOFA, fixed).inside, true);
});

test('snapping moves but never turns or resizes', () => {
  const frame = roomFrame(ROOM.rectangle);
  const out = toWorld(frame, { u: -1, v: frame.size.v / 2 });
  const pose = { x: out.x, z: out.z, yaw: 1.2 };
  const fixed = snapInsideRoom(ROOM, SOFA, pose);
  assert.equal(fixed.yaw, 1.2, 'the heading the person chose is preserved');
});

test('a piece already inside is left exactly where it is', () => {
  const pose = { x: 0, z: 0, yaw: 0.3 };
  assert.deepEqual(snapInsideRoom(ROOM, SOFA, pose), pose);
});

test('a piece genuinely too big is not clamped into a corner', () => {
  // 6 m in a 4.81 m room. Moving it cannot help, and snapping it to a corner
  // would look like it had been solved.
  const huge = { width: 6, depth: 0.9, height: 0.75 };
  const pose = { x: 0, z: 0, yaw: 0 };
  assert.deepEqual(snapInsideRoom(ROOM, huge, pose), pose);
  assert.equal(placementInRoom(ROOM, huge, pose).inside, false);
});
