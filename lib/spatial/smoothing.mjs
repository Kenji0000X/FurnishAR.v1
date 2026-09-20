/**
 * Making a live measurement readable without making it a lie.
 *
 * A WebXR hit-test pose moves a little every frame even when the phone is
 * perfectly still — the tracker is continuously re-solving its estimate of
 * where the world is. Rendered straight to a field showing one decimal place
 * of a centimetre at 60 Hz, that produces the flicker §10 describes:
 *
 *     2.91 m   2.96 m   2.88 m   2.94 m   2.92 m
 *
 * which is unreadable, and which makes a measurement that is actually good to
 * a few centimetres look untrustworthy.
 *
 * The obvious fix — a long moving average — trades the flicker for lag. Move
 * the phone to a new spot and the number crawls after it for a second, which
 * is worse: now the display disagrees with where the user is actually
 * pointing, and they will trust the stale number.
 *
 * ---------------------------------------------------------------------------
 * The One Euro filter
 * ---------------------------------------------------------------------------
 *
 * Casiez, Roussel & Vogel (CHI 2012). A low-pass filter whose cutoff
 * frequency rises with the observed speed of the signal:
 *
 *   - when the value is barely moving, the cutoff is low and the filter is
 *     heavy, so jitter is removed;
 *   - when the value is genuinely moving, the cutoff rises and the filter
 *     gets out of the way, so there is almost no lag.
 *
 * That is precisely the trade this display needs, and it is about fifteen
 * lines. The alternative of a fixed window cannot do both.
 */

/** A first-order low-pass filter — the building block, kept separate so it is testable. */
class LowPass {
  constructor() {
    this.value = null;
    this.raw = null;
  }

  filter(value, alpha) {
    this.raw = value;
    this.value = this.value === null ? value : alpha * value + (1 - alpha) * this.value;
    return this.value;
  }

  reset() {
    this.value = null;
    this.raw = null;
  }
}

/**
 * The smoothing coefficient for a given cutoff frequency and sample interval.
 * Standard discrete first-order low-pass: alpha = 1 / (1 + tau/dt).
 */
function alphaFor(cutoffHz, dtSeconds) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

export class OneEuroFilter {
  /**
   * The defaults were swept, not guessed, against the two synthetic signals in
   * tests/smoothing.test.js — a still hand jittering by +/- 4 cm, and a sweep
   * from 1.0 m to 2.5 m over one second. Both objectives at once, in cm:
   *
   *     minCutoff   beta    still spread    error while moving
   *         0.10    0.10           0.39                 10.60
   *         0.10    0.50           0.94                  4.01
   *      >> 0.10    1.00           1.33                  2.68  <<
   *         0.10    2.00           1.83                  1.79
   *         0.50    1.00           1.83                  2.55
   *         0.80    0.05           1.79                  9.33
   *
   * The trade is visible in every row: anything that steadies a still reading
   * further costs responsiveness while moving, and vice versa. 0.10/1.00 is
   * the knee — a 6x reduction in visible wobble for under 3 cm of lag at
   * 1.5 m/s, which is faster than anyone sweeps a phone across a doorway.
   *
   * @param minCutoff  Hz. Lower = steadier when still, laggier to start moving.
   * @param beta       How hard speed opens the filter up. Higher = less lag
   *                   when moving, more jitter passed through.
   * @param dCutoff    Hz for the speed estimate itself, which is noisier than
   *                   the signal and needs its own smoothing.
   */
  constructor({ minCutoff = 0.1, beta = 1.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastTime = null;
  }

  /**
   * @param value       the raw reading, in metres
   * @param timestamp   milliseconds, monotonic (performance.now() or the XR
   *                    frame time — both are)
   * @returns the smoothed reading, in metres
   */
  filter(value, timestamp) {
    if (!Number.isFinite(value)) return this.x.value;

    // The first sample has no interval to work with, so it passes through
    // untouched rather than being blended with an invented previous value.
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      this.x.filter(value, 1);
      return value;
    }

    let dt = (timestamp - this.lastTime) / 1000;
    // A dropped frame, a tab returning from the background, or a clock that
    // did not advance. Clamped rather than allowed to produce a divide-by-zero
    // or an alpha of 1 that defeats the whole filter.
    if (!(dt > 0) || dt > 1) dt = 1 / 60;
    this.lastTime = timestamp;

    // Rate of change, itself low-passed — the raw derivative of a noisy signal
    // is noise.
    const previous = this.x.value ?? value;
    const derivative = (value - previous) / dt;
    const smoothedDerivative = this.dx.filter(derivative, alphaFor(this.dCutoff, dt));

    // The adaptive part: cutoff rises with speed.
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}

/**
 * How much the last little while of readings disagree with each other, in
 * metres. This is the honest input to a confidence display: it is a measure of
 * the tracker's steadiness right now, not a claim about absolute accuracy,
 * which nothing on the device can know.
 */
export class Steadiness {
  constructor(window = 30) {
    this.window = window;
    this.samples = [];
  }

  push(value) {
    if (!Number.isFinite(value)) return;
    this.samples.push(value);
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** Peak-to-peak spread of the window, in the same unit as the samples. */
  spread() {
    if (this.samples.length < 2) return null;
    return Math.max(...this.samples) - Math.min(...this.samples);
  }

  /** Standard deviation, for a less outlier-dominated view than spread(). */
  deviation() {
    if (this.samples.length < 2) return null;
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    const variance = this.samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / this.samples.length;
    return Math.sqrt(variance);
  }

  get ready() {
    return this.samples.length >= Math.min(10, this.window);
  }

  reset() {
    this.samples = [];
  }
}

/**
 * How precisely a reading may be shown.
 *
 * Displaying "2.9174 m" from a signal wobbling by two centimetres invents
 * three digits of precision that do not exist — §32's "do not fake accuracy",
 * in its smallest and most everyday form. The number of decimals offered here
 * follows the observed steadiness, so the display never claims more than the
 * tracker is currently delivering.
 *
 * @param spreadMetres  observed peak-to-peak spread, or null when unknown
 * @returns {{ decimals: number, unitHint: 'mm'|'cm'|'m', trustworthy: boolean }}
 */
export function displayPrecision(spreadMetres) {
  if (spreadMetres === null || !Number.isFinite(spreadMetres)) {
    return { decimals: 0, unitHint: 'cm', trustworthy: false };
  }
  // Steadier than 2 mm: a millimetre digit is real.
  if (spreadMetres < 0.002) return { decimals: 1, unitHint: 'cm', trustworthy: true };
  // Steadier than 2 cm: whole centimetres are real, tenths are not.
  if (spreadMetres < 0.02) return { decimals: 0, unitHint: 'cm', trustworthy: true };
  // Anything looser than that is not a measurement worth quoting yet.
  return { decimals: 0, unitHint: 'cm', trustworthy: false };
}
