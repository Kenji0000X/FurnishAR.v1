import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeadingTracker, TiltTracker, shortestTurn, MAX_STEP_DEGREES, MAX_TURN_RATE } from '../lib/spatial/heading.mjs';

/* A phone reports about 60 times a second. */
const HZ = 60, DT = 1000 / HZ;

/** Feed n samples of a held-still heading with +/- jitter degrees of noise. */
function holdStill(tracker, { heading = 90, jitter = 1.5, samples = 120, seed = 7 } = {}) {
  let rng = seed;
  const readings = [];
  for (let i = 0; i < samples; i += 1) {
    // Deterministic pseudo-noise, so a failure is reproducible.
    rng = (rng * 1103515245 + 12345) % 2147483648;
    const noise = ((rng / 2147483648) * 2 - 1) * jitter;
    tracker.push(heading + noise, i * DT);
    readings.push(tracker.bearing);
  }
  return readings;
}

const spread = xs => Math.max(...xs) - Math.min(...xs);

test('shortestTurn crosses the 360 seam without spinning the room', () => {
  assert.equal(shortestTurn(350, 10), 20);
  assert.equal(shortestTurn(10, 350), -20);
  // 180 either way is genuinely ambiguous, so only the magnitude is fixed.
  assert.equal(Math.abs(shortestTurn(0, 180)), 180);
  assert.equal(shortestTurn(0, 179), 179);
});

test('a held-still heading comes out far steadier than it went in', () => {
  /*
     The headline fix. Raw samples jitter by +/- 1.5 degrees, which at 2.5 m
     swings a marker by about 6.5 cm every frame — visibly shaking dots.
  */
  const tracker = new HeadingTracker();
  const settled = holdStill(tracker).slice(40);   // past the filter warm-up
  const out = spread(settled);
  assert.ok(out < 0.4, `smoothed spread ${out.toFixed(3)}° should be well under the 3° raw band`);
});

test('a real turn still gets through', () => {
  // 90 degrees over one second: a brisk but ordinary turn to the next corner.
  const tracker = new HeadingTracker();
  for (let i = 0; i <= HZ; i += 1) tracker.push(i * (90 / HZ), i * DT);
  // Some filter lag is expected and wanted; losing the turn entirely is not.
  assert.ok(tracker.bearing > 80, `followed to ${tracker.bearing.toFixed(1)}° of 90°`);
  assert.equal(tracker.rejected, 0, 'nothing a hand can do should be rejected');
});

test('a magnetometer jump is dropped instead of throwing a corner across the room', () => {
  /*
     This is what produced the 7 cm and 20 cm "walls": one bad sample next to
     a steel door frame moved the heading by 80 degrees between frames, and
     the corner placed on the next tap landed nowhere near the wall.
  */
  const tracker = new HeadingTracker();
  holdStill(tracker, { heading: 90, samples: 60 });
  const before = tracker.bearing;

  tracker.push(170, 61 * DT);            // an 80 degree step in one frame: 4800 deg/s
  assert.equal(tracker.rejected, 1);
  assert.ok(Math.abs(tracker.bearing - before) < 0.01,
    `heading moved ${(tracker.bearing - before).toFixed(3)}° on a glitch`);
});

test('the rejection threshold is a RATE, so a slow sensor still works', () => {
  /*
     The flaw a fixed per-sample cap had: it assumed 60 Hz. Plenty of phones
     report orientation at 10 Hz or less, where an ordinary 180 deg/s turn is
     18 degrees per sample and a 5 Hz phone sees 36 — both of which a 20
     degree cap would have thrown away as glitches, freezing the heading at
     the exact moment the person turned to the next corner.
  */
  const slow = new HeadingTracker();
  slow.push(0, 0);
  slow.push(36, 200);            // 5 Hz sensor, 180 deg/s turn
  assert.equal(slow.rejected, 0, 'a real turn on a slow sensor is not a glitch');

  // And the rate cap still catches what it is for.
  const glitch = new HeadingTracker();
  glitch.push(0, 0);
  glitch.push(90, 1000 / 60);    // 5400 deg/s at 60 Hz
  assert.equal(glitch.rejected, 1);

  // The floor keeps a batch of same-timestamp samples from rejecting itself.
  const burst = new HeadingTracker();
  burst.push(0, 0);
  burst.push(MAX_STEP_DEGREES - 1, 0);
  assert.equal(burst.rejected, 0);

  assert.ok(MAX_TURN_RATE > 400, 'faster than any wrist, slower than a glitch');
});

test('a compass that keeps glitching is reported as untrustworthy', () => {
  const tracker = new HeadingTracker();
  // Alternate between two headings 90 degrees apart: a field being bent.
  for (let i = 0; i < 120; i += 1) tracker.push(i % 2 ? 10 : 100, i * DT);
  const { verdict, reason } = tracker.reliability;
  assert.equal(verdict, 'bad');
  assert.match(reason, /meter box|steel|magnetic/i);
});

test('a clean compass is not accused of glitching', () => {
  const tracker = new HeadingTracker();
  holdStill(tracker, { samples: 200, jitter: 1.5 });
  assert.equal(tracker.reliability.verdict, 'good', JSON.stringify(tracker.reliability));
});

test('reliability withholds judgement until it has seen enough', () => {
  const tracker = new HeadingTracker();
  holdStill(tracker, { samples: 10 });
  assert.equal(tracker.reliability.verdict, 'unknown');
});

test('heading never averages across the seam', () => {
  /*
     The bug a naive smoother has: readings hovering either side of north
     average to 180 and put the marker on the opposite wall. Filtering the
     unwrapped angle instead keeps it where it belongs.
  */
  const tracker = new HeadingTracker();
  for (let i = 0; i < 120; i += 1) tracker.push(i % 2 ? 359 : 1, i * DT);
  // Relative to the first reading (359), the answer must stay near zero.
  assert.ok(Math.abs(tracker.bearing) < 3, `bearing drifted to ${tracker.bearing.toFixed(2)}°`);
});

test('tilt is steadied the same way', () => {
  const tilt = new TiltTracker();
  let rng = 11;
  const out = [];
  for (let i = 0; i < 120; i += 1) {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    const noise = ((rng / 2147483648) * 2 - 1) * 1.5;
    tilt.push(62 + noise, i * DT);
    out.push(tilt.tilt);
  }
  /* The objective is a large reduction against the 3 degree raw band, not a
     particular decimal: the exact figure depends on which noise realisation
     you feed it (0.30 on the sweep's seed, 0.43 on this one). Six times
     better is the bar, and both clear it comfortably. */
  assert.ok(spread(out.slice(40)) < 0.5, `tilt spread ${spread(out.slice(40)).toFixed(3)}°`);
  assert.ok(Math.abs(tilt.tilt - 62) < 1, `settled at ${tilt.tilt.toFixed(2)}°`);
});

test('no tilt reading yet means null, not zero', () => {
  const tilt = new TiltTracker();
  assert.equal(tilt.tilt, null);
  tilt.push(NaN, 0);
  assert.equal(tilt.tilt, null, 'a junk sample does not count as a reading');
});

test('reset clears the history so a new room starts clean', () => {
  const tracker = new HeadingTracker();
  holdStill(tracker, { heading: 200, samples: 80 });
  tracker.reset();
  assert.equal(tracker.rejected, 0);
  assert.equal(tracker.accepted, 0);
  tracker.push(45, 0);
  assert.equal(tracker.bearing, 0, 'the first reading of a new run is the new zero');
});
