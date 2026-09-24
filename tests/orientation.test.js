/**
 * The camera's angle from straight down must depend on where the camera
 * POINTS, not on how the phone happens to be turned or which way the screen
 * is rotated. Every test builds a physical pose as a rotation, converts it to
 * the (alpha, beta, gamma) a browser would report, and checks the answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rotationFromEuler, eulerFromRotation, cameraPose, applyCalibration,
  calibrationFrom, rollProblem, normaliseScreenAngle
} from '../lib/spatial/orientation.mjs';
import { distanceFromTilt } from '../lib/spatial/clinometer.mjs';

const RAD = Math.PI / 180;
const close = (a, b, tol = 1e-6, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} expected ${b}, got ${a}`);

/* Rotations about the DEVICE's own axes, composed right to left, starting
   from the phone lying flat, face up, top pointing north. */
const Rx = d => { const c = Math.cos(d * RAD), s = Math.sin(d * RAD); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const Ry = d => { const c = Math.cos(d * RAD), s = Math.sin(d * RAD); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const Rz = d => { const c = Math.cos(d * RAD), s = Math.sin(d * RAD); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
const mul = (a, b) => a.map((row, i) => b[0].map((_, j) => row.reduce((sum, _v, k) => sum + a[i][k] * b[k][j], 0)));

/**
 * A pose described physically:
 *   heading    degrees the person is facing (turn about vertical)
 *   down       degrees the camera is aimed below the horizon
 *   roll       degrees the screen is tipped about the line of sight
 *   screen     screen rotation: 0 portrait, 90 / 270 landscape
 * The phone is held so its SCREEN is upright for the chosen rotation, i.e. in
 * landscape it is first turned on its side about the camera axis.
 */
function pose({ heading = 0, down = 0, roll = 0, screen = 0 }) {
  // Upright portrait facing north: rotate flat phone 90 about device X.
  // Aiming down by `down` degrees means pitching back less: 90 - down.
  let m = Rz(-heading);                 // turn to face the heading (clockwise)
  m = mul(m, Rx(90 - down));            // stand up, then tip the camera down
  m = mul(m, Rz(roll - screen));        // roll about the line of sight; landscape turns the phone on its side
  return eulerFromRotation(m);
}

test('Euler round trip is exact for ordinary poses', () => {
  for (const e of [{ alpha: 10, beta: 30, gamma: 20 }, { alpha: 200, beta: -40, gamma: -70 }, { alpha: 359, beta: 120, gamma: 5 }]) {
    const back = eulerFromRotation(rotationFromEuler(e));
    const again = rotationFromEuler(back);
    const original = rotationFromEuler(e);
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) close(again[r][c], original[r][c], 1e-9);
  }
});

test('flat face up: camera straight down, no direction', () => {
  const p = cameraPose({ alpha: 0, beta: 0, gamma: 0 }, 0);
  close(p.angleFromDown, 0, 1e-9);
  assert.equal(p.heading, null);
});

test('portrait upright: camera at the horizon', () => {
  const p = cameraPose(pose({ down: 0 }), 0);
  close(p.angleFromDown, 90, 1e-6);
  close(p.roll, 0, 1e-6);
});

test('portrait aimed 45 degrees down reads 45, exactly as beta used to', () => {
  const e = pose({ down: 45 });
  close(e.beta, 45, 1e-6);
  close(cameraPose(e, 0).angleFromDown, 45, 1e-6);
});

test('landscape-left and landscape-right read the same angle as portrait for the same aim', () => {
  for (const down of [20, 35, 45, 60, 75]) {
    const portrait = cameraPose(pose({ down, screen: 0 }), 0).angleFromDown;
    const left = cameraPose(pose({ down, screen: 90 }), 90).angleFromDown;
    const right = cameraPose(pose({ down, screen: 270 }), 270).angleFromDown;
    close(portrait, 90 - down, 1e-6, `portrait ${down}`);
    close(left, 90 - down, 1e-6, `landscape-left ${down}`);
    close(right, 90 - down, 1e-6, `landscape-right ${down}`);
  }
});

test('the old beta-as-angle reading was wrong in landscape (the field bug)', () => {
  // Aimed 45 degrees down in landscape: beta is nowhere near 45.
  const e = pose({ down: 45, screen: 90 });
  assert.ok(Math.abs(e.beta - 45) > 20, `beta ${e.beta} would have been used as the angle`);
  close(cameraPose(e, 90).angleFromDown, 45, 1e-6);
  // And the floor distance follows the real angle, not beta.
  const right = distanceFromTilt({ eyeHeight: 1.4, tiltDegrees: cameraPose(e, 90).angleFromDown }).distance;
  close(right, 1.4, 1e-6);
});

test('rolling the phone about the line of sight does not change the angle', () => {
  for (const roll of [-15, -5, 5, 15]) {
    const p = cameraPose(pose({ down: 40, roll }), 0);
    close(p.angleFromDown, 50, 1e-6, `roll ${roll}`);
    close(Math.abs(p.roll), Math.abs(Math.asin(Math.sin(roll * RAD) * Math.cos(40 * RAD)) / RAD), 1e-6, `roll value ${roll}`);
  }
});

test('turning on the spot changes the heading and nothing else', () => {
  const base = cameraPose(pose({ heading: 0, down: 30 }), 0);
  for (const heading of [45, 90, 180, 270, 359]) {
    const p = cameraPose(pose({ heading, down: 30 }), 0);
    close(p.angleFromDown, base.angleFromDown, 1e-6);
    const turned = ((p.heading - base.heading) + 360) % 360;
    close(turned, heading % 360, 1e-6, `heading ${heading}`);
  }
});

test('changing the screen rotation mid-session does not move the angle for the same physical pose', () => {
  // Same physical phone attitude; only what the browser calls "screen angle" differs.
  const e = pose({ down: 50 });
  const a = cameraPose(e, 0).angleFromDown;
  const b = cameraPose(e, 90).angleFromDown;
  close(a, b, 1e-9);
});

test('aiming upward is above 90', () => {
  close(cameraPose(pose({ down: -30 }), 0).angleFromDown, 120, 1e-6);
});

test('roll past the limit disables capture', () => {
  assert.equal(rollProblem(cameraPose(pose({ down: 40, roll: 3 }), 0)), null);
  assert.equal(rollProblem(cameraPose(pose({ down: 20, roll: 25 }), 0)), 'Straighten the phone.');
});

test('calibration removes a constant offset and refuses a phone not held upright', () => {
  const samples = Array.from({ length: 20 }, () => ({ angleFromDown: 88.5, roll: 1.2 }));
  const cal = calibrationFrom(samples);
  assert.ok(cal.ok);
  const corrected = applyCalibration({ angleFromDown: 43.5, roll: 1.2, elevation: 46.5 }, cal);
  close(corrected.angleFromDown, 45, 1e-9);
  close(corrected.roll, 0, 1e-9);

  assert.equal(calibrationFrom(Array.from({ length: 20 }, () => ({ angleFromDown: 70, roll: 0 }))).ok, false);
  assert.equal(calibrationFrom(Array.from({ length: 5 }, () => ({ angleFromDown: 90, roll: 0 }))).ok, false);
  const shaky = Array.from({ length: 20 }, (_, i) => ({ angleFromDown: 88 + (i % 2) * 4, roll: 0 }));
  assert.equal(calibrationFrom(shaky).ok, false);
});

test('screen angles normalise', () => {
  assert.equal(normaliseScreenAngle(-90), 270);
  assert.equal(normaliseScreenAngle(90), 90);
  assert.equal(normaliseScreenAngle(undefined), 0);
});
