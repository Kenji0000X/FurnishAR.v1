import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceFromTilt, heightFromTilt, floorPointFromAim, bearingDelta,
  surfacesFromCorners, cornerReadiness, MAX_TILT_DEGREES, projectFloorPoint
} from '../lib/spatial/clinometer.mjs';
import { roomDimensions } from '../lib/spatial/room.mjs';

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('45 degrees puts the point exactly one phone-height away', () => {
  // The one angle where the answer is checkable without a calculator:
  // tan(45) = 1, so d must equal h.
  const { distance } = distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: 45 });
  assert.ok(close(distance, 1.4, 1e-9), `${distance}`);
});

test('the trigonometry matches h*tan(theta) across the usable range', () => {
  for (const deg of [15, 30, 60, 75]) {
    const { distance } = distanceFromTilt({ eyeHeight: 1.55, tiltDegrees: deg });
    const expected = 1.55 * Math.tan(deg * Math.PI / 180);
    assert.ok(close(distance, expected, 1e-9), `${deg}deg: ${distance} vs ${expected}`);
  }
});

test('aiming near level is refused rather than answered', () => {
  // The whole point of the cap. sec^2(85) is 131, so one degree of hand
  // wobble at h=1.4 is over three metres — a number with no meaning.
  const near = distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: 85 });
  assert.equal(near.distance, null);
  assert.equal(near.trust, 'unusable');
  assert.match(near.reason, /Aim further down/);

  // And the boundary is where it says it is.
  assert.equal(distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: MAX_TILT_DEGREES }).distance, null);
  assert.ok(distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: MAX_TILT_DEGREES - 0.1 }).distance > 0);
});

test('the spread grows with sec squared, which is why the cap exists', () => {
  const at = deg => distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: deg, noiseDegrees: 1 }).spread;
  // Hand-computed from h*sec^2(theta)*1deg-in-radians, so this checks the
  // formula rather than just checking it increases.
  assert.ok(close(at(45), 1.4 * 2 * (Math.PI / 180), 1e-9), `${at(45)}`);
  assert.ok(at(30) < at(45) && at(45) < at(60) && at(60) < at(75));
  // One degree of wobble at 75 degrees costs more than a third of a metre.
  assert.ok(at(75) > 0.35, `${at(75)}`);
  // ...and at 45 it costs under five centimetres.
  assert.ok(at(45) < 0.05, `${at(45)}`);
});

test('a soft reading is labelled soft instead of printed as a number', () => {
  const soft = distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: 78, noiseDegrees: 1.5 });
  assert.ok(soft.distance > 0, 'still answers');
  assert.equal(soft.trust, 'coarse', 'but does not claim to be precise');
  /*
     It is the ABSOLUTE spread that condemns this one: +/- 85 cm on a 6.6 m
     wall. In relative terms it is only 13%, which is why a relative-only
     test let it through as "good" — 2*dtheta/sin(2*theta) does not reach 15%
     until roughly 80 degrees, where the hard cap already applies.
  */
  assert.ok(soft.spread > 0.25, `spread ${soft.spread}`);
  assert.ok(soft.spread / soft.distance < 0.15, 'and relative spread alone would have missed it');
  assert.match(soft.reason, /give or take 85 cm/);

  // The band where the phone is genuinely good: a couple of metres out.
  const sharp = distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: 60, noiseDegrees: 1.5 });
  assert.equal(sharp.trust, 'good');
  assert.ok(sharp.spread < 0.16, `${sharp.spread}`);
});

test('no height means no measurement, not a default height', () => {
  const none = distanceFromTilt({ eyeHeight: 0, tiltDegrees: 45 });
  assert.equal(none.distance, null);
  assert.match(none.reason, /height/i);
});

test('a phone with no tilt reading says so', () => {
  assert.equal(distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: NaN }).distance, null);
  assert.equal(distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: undefined }).trust, 'unusable');
});

test('ceiling height comes out of the rise angle', () => {
  // Standing 3 m from a wall, aiming 30 degrees up from a 1.4 m hold:
  // 1.4 + 3*tan(30) = 1.4 + 1.732 = 3.132 m.
  const { height } = heightFromTilt({ distance: 3, riseDegrees: 30, eyeHeight: 1.4 });
  assert.ok(close(height, 1.4 + 3 * Math.tan(30 * Math.PI / 180), 1e-9), `${height}`);
});

test('bearings subtract across the 360 seam without folding the room', () => {
  // A 20-degree turn through north is 20 degrees, not 340.
  assert.ok(close(bearingDelta(350, 10), 20, 1e-9));
  assert.ok(close(bearingDelta(10, 350), -20, 1e-9));
  assert.ok(close(bearingDelta(0, 90), 90, 1e-9));
});

test('four aimed corners become a room the existing geometry can read', () => {
  /*
     The integration that matters: a phone standing in the middle of a
     4 x 3 m room, turning to each corner in turn. From the centre, each
     corner is at half the diagonal — hypot(2, 1.5) = 2.5 m — at bearings
     of 53.13, 126.87, 233.13 and 306.87 degrees.

     Tilt for a 2.5 m shot from 1.4 m up: atan(2.5/1.4) = 60.75 degrees.
  */
  const held = 1.4;
  const tilt = Math.atan(2.5 / held) * 180 / Math.PI;
  const bearings = [53.130102, 126.869898, 233.130102, 306.869898];

  const corners = bearings.map(b => {
    const { point, trust } = floorPointFromAim({ eyeHeight: held, tiltDegrees: tilt, bearingDegrees: b });
    assert.ok(point, 'every corner resolves');
    assert.equal(trust, 'good');
    return point;
  });

  const room = roomDimensions(surfacesFromCorners(corners, { ceilingHeight: 2.5 }), { minFloorArea: 0.5 });

  assert.ok(close(Math.max(room.length, room.width), 4, 0.01), `length ${room.length}`);
  assert.ok(close(Math.min(room.length, room.width), 3, 0.01), `width ${room.width}`);
  assert.ok(close(room.floorArea, 12, 0.05), `area ${room.floorArea}`);
  assert.ok(close(room.height, 2.5, 0.01), `height ${room.height}`);
  assert.ok(close(room.volume, 30, 0.2), `volume ${room.volume}`);
});

test('no ceiling measurement means no ceiling surface, so height stays unknown', () => {
  const corners = [
    { x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }
  ];
  const surfaces = surfacesFromCorners(corners);
  assert.equal(surfaces.length, 1, 'floor only — no invented ceiling');
  const room = roomDimensions(surfaces, { minFloorArea: 0.5 });
  assert.equal(room.height, null);
  assert.ok(room.missing.includes('height'));
});

test('readiness names what is still missing', () => {
  assert.deepEqual(cornerReadiness([], {}).blocking, ['3 more corners', 'close the outline']);
  assert.deepEqual(cornerReadiness([1, 2], {}).blocking, ['1 more corner', 'close the outline']);
  assert.deepEqual(cornerReadiness([1, 2, 3], { closed: false }).blocking, ['close the outline']);
  assert.equal(cornerReadiness([1, 2, 3], { closed: true }).ready, true);
});

/* ------------------------------------------- drawing markers on the view -- */

test('the point you are aiming at lands dead centre', () => {
  // The one case that must be exact regardless of any lens estimate: the
  // reticle is the middle of the frame by definition, so whatever floor
  // point the current angles resolve to must project back to (0.5, 0.5).
  const eyeHeight = 1.4, tiltDegrees = 62, bearingDegrees = 30;
  const { point } = floorPointFromAim({ eyeHeight, tiltDegrees, bearingDegrees });
  const { u, v, visible } = projectFloorPoint({ point, eyeHeight, tiltDegrees, bearingDegrees });
  assert.ok(Math.abs(u - 0.5) < 1e-9, `u ${u}`);
  assert.ok(Math.abs(v - 0.5) < 1e-9, `v ${v}`);
  assert.equal(visible, true);
});

test('turning right sweeps the marker left, and vice versa', () => {
  const eyeHeight = 1.4, tilt = 60;
  const { point } = floorPointFromAim({ eyeHeight, tiltDegrees: tilt, bearingDegrees: 0 });
  // Turn the phone 10 degrees to the right: the fixed marker must move left.
  const right = projectFloorPoint({ point, eyeHeight, tiltDegrees: tilt, bearingDegrees: 10 });
  assert.ok(right.u < 0.5, `u ${right.u}`);
  const left = projectFloorPoint({ point, eyeHeight, tiltDegrees: tilt, bearingDegrees: -10 });
  assert.ok(left.u > 0.5, `u ${left.u}`);
  // Symmetric about the centre.
  assert.ok(Math.abs((0.5 - right.u) - (left.u - 0.5)) < 1e-9);
});

test('a further point sits higher in the frame', () => {
  const eyeHeight = 1.4, bearing = 0;
  const near = { x: 0, y: 0, z: -2 };
  const far = { x: 0, y: 0, z: -6 };
  const camera = { eyeHeight, tiltDegrees: 70, bearingDegrees: bearing };
  const a = projectFloorPoint({ point: near, ...camera });
  const b = projectFloorPoint({ point: far, ...camera });
  assert.ok(b.v < a.v, `far ${b.v} should be above near ${a.v}`);
});

test('a marker behind you is not drawn', () => {
  const behind = { x: 0, y: 0, z: 3 };   // directly behind the standing spot
  const { visible } = projectFloorPoint({
    point: behind, eyeHeight: 1.4, tiltDegrees: 60, bearingDegrees: 0
  });
  assert.equal(visible, false);
});

test('projection refuses rather than guessing when a reading is missing', () => {
  const p = { x: 1, y: 0, z: -2 };
  assert.equal(projectFloorPoint({ point: p, eyeHeight: 1.4, tiltDegrees: NaN, bearingDegrees: 0 }).visible, false);
  assert.equal(projectFloorPoint({ point: null, eyeHeight: 1.4, tiltDegrees: 60, bearingDegrees: 0 }).u, null);
});

test('the lens estimate never reaches a measurement', () => {
  /*
     The honest separation: a wrong field of view moves a marker on the
     picture and changes no number. Same point, wildly different lens, same
     distance reported.
  */
  const p = { x: 2, y: 0, z: -2 };
  const camera = { point: p, eyeHeight: 1.4, tiltDegrees: 60, bearingDegrees: 0 };
  const wide = projectFloorPoint({ ...camera, fov: { x: 90, y: 110 } });
  const narrow = projectFloorPoint({ ...camera, fov: { x: 40, y: 50 } });
  assert.notEqual(wide.u, narrow.u, 'the drawing moves');
  assert.equal(wide.distance, narrow.distance, 'the measurement does not');
  assert.ok(Math.abs(wide.distance - Math.hypot(2, 2)) < 1e-9);
});
