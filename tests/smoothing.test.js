/**
 * Measurement stabilisation, tested against synthetic pose streams.
 *
 * There is no XR device in CI, so these drive the filter with signals whose
 * true value is known in advance — a still hand, a moving hand, a dropped
 * frame — and check both halves of the trade §10 asks for:
 *
 *   1. jitter must go down when the reading is still, AND
 *   2. lag must stay small when the reading genuinely moves.
 *
 * Either one alone is trivial. A long moving average nails (1) and fails (2),
 * so it is included below as a negative control: the test proves the filter
 * beats it on lag while matching it on steadiness, which is the entire reason
 * for choosing One Euro over the obvious thing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter, Steadiness, displayPrecision } from '../lib/spatial/smoothing.mjs';

const FRAME = 1000 / 60;

/** A deterministic pseudo-random source, so a failure is reproducible. */
function noise(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;   // -1..1
  };
}

/** The obvious alternative, for comparison. */
class MovingAverage {
  constructor(n) { this.n = n; this.buf = []; }
  filter(v) {
    this.buf.push(v);
    if (this.buf.length > this.n) this.buf.shift();
    return this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }
}

test('a still reading is steadied', () => {
  const rand = noise(7);
  const filter = new OneEuroFilter();
  const TRUE = 2.92;                 // metres
  const JITTER = 0.04;               // +/- 4 cm, the scale §10 describes

  const raw = [];
  const smoothed = [];
  for (let i = 0; i < 180; i++) {
    const sample = TRUE + rand() * JITTER;
    raw.push(sample);
    smoothed.push(filter.filter(sample, i * FRAME));
  }

  // Judge the settled part; the first frames are the filter acquiring.
  const settled = smoothed.slice(60);
  const rawSettled = raw.slice(60);
  const spread = a => Math.max(...a) - Math.min(...a);

  assert.ok(
    spread(settled) < spread(rawSettled) / 5,
    `smoothed spread ${(spread(settled) * 100).toFixed(2)} cm should be far under ` +
    `raw ${(spread(rawSettled) * 100).toFixed(2)} cm`
  );
  // And it must still be centred on the truth, not drifted off it.
  const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
  assert.ok(Math.abs(mean - TRUE) < 0.01, `settled at ${mean.toFixed(4)} m, truth ${TRUE} m`);
});

test('a moving reading is followed without crawling after it', () => {
  // The phone sweeps from 1.0 m to 2.5 m over one second — an ordinary
  // movement while choosing point B.
  const rand = noise(11);
  const filter = new OneEuroFilter();
  const average = new MovingAverage(30);

  let euroErr = 0;
  let avgErr = 0;
  let frames = 0;

  for (let i = 0; i < 120; i++) {
    const t = i / 60;
    const truth = t < 1 ? 1.0 + 1.5 * t : 2.5;
    const sample = truth + rand() * 0.01;
    const e = filter.filter(sample, i * FRAME);
    const a = average.filter(sample);
    if (i > 10) {                       // past acquisition for both
      euroErr += Math.abs(e - truth);
      avgErr += Math.abs(a - truth);
      frames++;
    }
  }

  euroErr /= frames;
  avgErr /= frames;

  // The point of the exercise: less lag than the obvious alternative.
  assert.ok(
    euroErr < avgErr,
    `One Euro mean error ${(euroErr * 100).toFixed(2)} cm should beat ` +
    `a 30-frame average's ${(avgErr * 100).toFixed(2)} cm`
  );
  // And in absolute terms, close enough to be usable while moving.
  assert.ok(euroErr < 0.03, `mean tracking error ${(euroErr * 100).toFixed(2)} cm while moving`);
});

test('it settles onto a new value rather than hanging near the old one', () => {
  const filter = new OneEuroFilter();
  for (let i = 0; i < 120; i++) filter.filter(1.0, i * FRAME);
  let last = null;
  for (let i = 120; i < 240; i++) last = filter.filter(2.0, i * FRAME);
  assert.ok(Math.abs(last - 2.0) < 0.005, `settled at ${last}, expected ~2.0`);
});

test('the first sample passes through untouched', () => {
  const filter = new OneEuroFilter();
  assert.equal(filter.filter(1.234, 0), 1.234);
});

test('a dropped frame or a stalled clock cannot break it', () => {
  const filter = new OneEuroFilter();
  filter.filter(1.0, 0);
  for (const t of [0, -50, 1e9, NaN]) {
    const out = filter.filter(1.5, t);
    assert.ok(Number.isFinite(out), `timestamp ${t} produced ${out}`);
  }
  assert.ok(Number.isFinite(filter.filter(1.5, 1e9 + FRAME)));
});

test('a non-finite reading is ignored, not propagated', () => {
  const filter = new OneEuroFilter();
  filter.filter(2.0, 0);
  filter.filter(2.0, FRAME);
  const before = filter.x.value;
  assert.equal(filter.filter(NaN, 2 * FRAME), before);
  assert.equal(filter.filter(Infinity, 3 * FRAME), before);
});

test('reset returns it to acquiring', () => {
  const filter = new OneEuroFilter();
  for (let i = 0; i < 60; i++) filter.filter(1.0, i * FRAME);
  filter.reset();
  assert.equal(filter.filter(5.0, 0), 5.0, 'after reset the next sample passes through');
});

/* ------------------------------------------------------------ steadiness -- */

test('steadiness reports the spread of recent readings', () => {
  const s = new Steadiness(10);
  assert.equal(s.spread(), null, 'nothing to report from one sample or none');
  for (const v of [1.00, 1.01, 0.99, 1.02, 0.98]) s.push(v);
  assert.ok(Math.abs(s.spread() - 0.04) < 1e-9);
  assert.ok(s.deviation() > 0);
});

test('steadiness forgets old samples', () => {
  const s = new Steadiness(5);
  for (const v of [10, 10, 10, 10, 10]) s.push(v);
  for (const v of [1, 1, 1, 1, 1]) s.push(v);
  assert.equal(s.spread(), 0, 'the window should hold only the recent run');
});

/* ------------------------------------------------- claimed precision ------ */

test('precision offered never exceeds precision observed', () => {
  // Rock steady: a millimetre digit is real.
  assert.deepEqual(displayPrecision(0.001), { decimals: 1, unitHint: 'cm', trustworthy: true });
  // Wobbling by a centimetre: whole centimetres only.
  assert.deepEqual(displayPrecision(0.01), { decimals: 0, unitHint: 'cm', trustworthy: true });
  // Wobbling by five centimetres: not worth quoting.
  assert.equal(displayPrecision(0.05).trustworthy, false);
  // Nothing known yet.
  assert.equal(displayPrecision(null).trustworthy, false);
  assert.equal(displayPrecision(NaN).trustworthy, false);
});

test('a jittery signal is never described as trustworthy', () => {
  const rand = noise(23);
  const s = new Steadiness(30);
  for (let i = 0; i < 40; i++) s.push(2.9 + rand() * 0.05);   // +/- 5 cm
  assert.equal(displayPrecision(s.spread()).trustworthy, false);
});
