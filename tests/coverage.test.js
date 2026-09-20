/**
 * The guided sweep, tested against motions whose coverage is known.
 *
 * The property that matters: the progress bar must not be able to reach a
 * confident-looking number while the scan knows nothing about the room. A
 * coverage meter that reads 82% because somebody waved the phone at the
 * ceiling is the false confidence the feature exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SweepCoverage, scanReadiness, normaliseAngle, SWEEP_RADIANS } from '../lib/spatial/coverage.mjs';
import { roomDimensions } from '../lib/spatial/room.mjs';

const deg = d => (d * Math.PI) / 180;

/** Sweep from `from` to `to` degrees relative to the start, in small steps. */
function sweep(coverage, from, to, { start = 0, step = 1 } = {}) {
  const direction = to >= from ? step : -step;
  for (let d = from; direction > 0 ? d <= to : d >= to; d += direction) {
    coverage.observe(deg(start + d));
  }
}

test('angles wrap to (-pi, pi]', () => {
  assert.ok(Math.abs(normaliseAngle(deg(370)) - deg(10)) < 1e-9);
  assert.ok(Math.abs(normaliseAngle(deg(-370)) - deg(-10)) < 1e-9);
  assert.ok(Math.abs(normaliseAngle(Math.PI) - Math.PI) < 1e-9);
});

test('a full half-circle sweep reaches 100%', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, -90, 90);
  assert.equal(coverage.fraction, 1);
  assert.ok(Math.abs(coverage.degrees - 180) < 1e-9);
  assert.equal(coverage.guidance(), 'Sweep complete.');
});

test('half a sweep reads about half', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, 0, 90);
  assert.ok(coverage.fraction > 0.45 && coverage.fraction <= 0.55, `got ${coverage.fraction}`);
});

test('coverage works regardless of which way the phone started facing', () => {
  // The tracking origin's absolute yaw is arbitrary, so only relative turn
  // can mean anything.
  for (const start of [0, 45, 179, -120, 359]) {
    const coverage = new SweepCoverage();
    sweep(coverage, -90, 90, { start });
    assert.equal(coverage.fraction, 1, `starting at ${start}deg should still complete`);
  }
});

test('a sweep across the +/-180 seam is not counted twice or lost', () => {
  const coverage = new SweepCoverage();
  // Start facing 170deg, turn right through the seam to -160deg: a 30deg turn.
  for (let d = 170; d <= 200; d++) coverage.observe(deg(d));
  assert.ok(coverage.fraction > 0.1 && coverage.fraction < 0.25, `got ${coverage.fraction}`);
});

test('turning past the half-circle is capped, not counted as extra', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, -90, 90);
  assert.equal(coverage.fraction, 1);
  // Keep going all the way round: still 100%, never more.
  sweep(coverage, 90, 270);
  assert.equal(coverage.fraction, 1);
  assert.ok(coverage.degrees <= 180);
});

test('standing still does not accumulate coverage', () => {
  const coverage = new SweepCoverage();
  for (let i = 0; i < 600; i++) coverage.observe(deg(20));
  assert.ok(coverage.fraction < 0.05, `600 frames of standing still gave ${coverage.fraction}`);
});

test('non-finite headings are ignored', () => {
  const coverage = new SweepCoverage();
  assert.equal(coverage.observe(NaN), null);
  assert.equal(coverage.observe(Infinity), null);
  assert.equal(coverage.started, false, 'a bad sample must not start the sweep');
});

test('guidance says to carry on the way you were already turning', () => {
  // Mid-turn, the nearest unswept ground is straight ahead of the direction
  // of travel. Telling someone to reverse would send them back across
  // everything they have already covered.
  //
  // WebXR yaw rises counter-clockwise seen from above, which for the person
  // holding the phone is a turn to their LEFT. These two assertions are what
  // catch that pair of labels being swapped.
  const turningLeft = new SweepCoverage();
  sweep(turningLeft, 0, 80);
  assert.match(turningLeft.guidance(), /left/);

  const turningRight = new SweepCoverage();
  sweep(turningRight, 0, -80);
  assert.match(turningRight.guidance(), /right/);
});

test('a whipped sweep that skips bins is told to go back over it', () => {
  const coverage = new SweepCoverage();
  // Touch both extremes and almost nothing between: big jumps.
  for (const d of [-90, -60, -30, 0, 30, 60, 90]) coverage.observe(deg(d));
  assert.equal(coverage.hasGaps(), true);
  assert.match(coverage.guidance(), /more slowly/);
});

test('an unbroken sweep is not reported as gappy', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, -40, 40);
  assert.equal(coverage.hasGaps(), false);
});

test('reset returns it to the start', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, -90, 90);
  coverage.reset();
  assert.equal(coverage.fraction, 0);
  assert.equal(coverage.origin, null);
});

/* ------------------------------------------------------- the gate ------- */

const p = (x, y, z) => ({ x, y, z });
const floor = { orientation: 'horizontal',
  polygon: [p(-2, 0, -1.5), p(2, 0, -1.5), p(2, 0, 1.5), p(-2, 0, 1.5)] };
const ceiling = { orientation: 'horizontal',
  polygon: [p(-2, 2.7, -1.5), p(2, 2.7, -1.5), p(2, 2.7, 1.5), p(-2, 2.7, 1.5)] };
const wallAt = z => ({ orientation: 'vertical',
  polygon: [p(-2, 0, z), p(2, 0, z), p(2, 2.7, z), p(-2, 2.7, z)] });

test('a complete scan is ready', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, -90, 90);
  const room = roomDimensions([floor, ceiling, wallAt(-1.5), wallAt(1.5)]);
  const readiness = scanReadiness(coverage, room);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blocking, []);
  assert.equal(readiness.progress, 1);
});

test('a perfect sweep that found nothing is NOT ready, and says why', () => {
  // The phone pointed at the ceiling for the whole turn. This is the case the
  // gate exists for: coverage alone must never imply a measured room.
  const coverage = new SweepCoverage();
  sweep(coverage, -90, 90);
  const readiness = scanReadiness(coverage, roomDimensions([]));
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blocking.includes('floor'));
  assert.ok(readiness.blocking.includes('walls'));
  assert.ok(readiness.progress <= 0.25, `progress read ${readiness.progress} on an empty room`);
});

test('a found room with a half-done sweep is not ready either', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, 0, 60);
  const room = roomDimensions([floor, ceiling, wallAt(-1.5), wallAt(1.5)]);
  const readiness = scanReadiness(coverage, room);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blocking, ['sweep']);
});

test('one wall is not enough to call the walls found', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, -90, 90);
  const room = roomDimensions([floor, ceiling, wallAt(-1.5)]);
  assert.ok(scanReadiness(coverage, room).blocking.includes('walls'));
});

test('every check carries equal weight in the bar', () => {
  const coverage = new SweepCoverage();
  sweep(coverage, -90, 90);
  // Floor + height (from walls) + sweep, but only one wall: 3 of 4.
  const room = roomDimensions([floor, wallAt(-1.5)]);
  const readiness = scanReadiness(coverage, room);
  assert.equal(readiness.progress, 0.75);
});
