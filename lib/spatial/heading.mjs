/**
 * Keeping the markers still.
 *
 * The first phone test of the aim-and-tap scanner produced markers that
 * shook, lines that swung across the room and walls reported as 7 cm, 20 cm
 * and 27 cm. The trigonometry was not at fault — it is the same formula the
 * unit tests check to nine decimal places. The ANGLES going into it were.
 *
 * Two separate faults, and they need two separate fixes:
 *
 * 1. JITTER. DeviceOrientationEvent fires around 60 times a second and every
 *    sample carries a degree or so of noise. Feeding each one straight into
 *    the projection redraws every marker 60 times a second from a slightly
 *    different angle, which is exactly what "the dots are not stationary"
 *    looks like. A One Euro filter fixes it — and this project already has
 *    one whose constants were swept against a still hand and a moving sweep
 *    rather than guessed, so it is reused rather than reinvented.
 *
 * 2. MAGNETOMETER GLITCHES. alpha is fused from the magnetometer, and indoors
 *    it does not merely drift — it jumps. The recording that prompted this
 *    was filmed next to a steel door frame and an electrical meter box, both
 *    of which bend the local field. A jump of tens of degrees between two
 *    consecutive samples throws a corner to the far side of the room, which
 *    is where the 7 cm walls came from.
 *
 *    A jump like that is physically impossible by hand. At 60 Hz, 20 degrees
 *    between samples is 1200 degrees per second — three and a half full turns
 *    a second. So any step larger than that is not a turn, it is the sensor
 *    lying, and it is dropped. Real turning is continuous and passes through
 *    untouched.
 *
 * What is NOT claimed: this does not give a phone a gyroscope it lacks, and
 * it cannot recover a heading from a compass that is wrong for a sustained
 * period rather than momentarily. It counts what it rejects so the interface
 * can say the compass is unreliable here instead of quietly drawing a wrong
 * room.
 */

import { OneEuroFilter } from './smoothing.mjs';

/**
 * The fastest believable turn, in degrees per SECOND.
 *
 * The first version of this capped the per-sample step at 20 degrees, which
 * quietly assumed a 60 Hz sensor: at that rate 20 degrees per sample is
 * 1200 deg/s and nothing a hand does comes close. But DeviceOrientationEvent
 * is not 60 Hz everywhere — plenty of phones report at 10 or 15 Hz, and a
 * few at 5. At 5 Hz an ordinary 180 deg/s turn is 36 degrees per sample, so
 * the fixed cap would have rejected real turning as a glitch and frozen the
 * heading exactly when the person turned to the next corner.
 *
 * A rate is the honest threshold, because it is the thing that is actually
 * bounded: a wrist can manage perhaps 400 deg/s in a deliberate sweep. A
 * magnetometer glitch is a step change between consecutive samples, which is
 * an effectively unbounded rate however fast the sensor runs.
 */
export const MAX_TURN_RATE = 600;
/**
 * Filter constants for ANGLES, swept rather than inherited.
 *
 * The existing OneEuroFilter defaults (minCutoff 0.10, beta 1.00) were swept
 * for readings in METRES, and beta multiplies the signal's own derivative —
 * so the same number means something completely different here. A hand
 * jittering 1.5 degrees at 60 Hz has a derivative around 90 deg/s, where a
 * hand moving 1.5 m/s has one of 1.5. Carrying beta = 1.0 across opens the
 * filter to about 90 Hz and smooths nothing at all, which is what the first
 * attempt did.
 *
 * Swept over the same two objectives, in degrees:
 *
 *     minCutoff   beta     still spread    lag through a 90 deg/s turn
 *         0.10    0.001           0.142                          13.89
 *      >> 0.10    0.010           0.298                           4.12  <<
 *         0.10    0.050           0.674                           1.55
 *         0.30    0.010           0.458                           3.99
 *         1.00    0.010           0.797                           3.55
 *         1.00    0.200           1.387                           0.56
 *
 * 0.10 / 0.01 is the knee. A 0.3 degree still spread is 1.3 cm of marker
 * wobble at 2.5 m, down from about 6.5 cm raw — the difference between dots
 * that shake and dots that sit still. The 4 degrees of lag is paid only
 * WHILE turning, and nobody taps a corner mid-turn: the filter has settled
 * long before the thumb arrives.
 */
const ANGLE_FILTER = { minCutoff: 0.1, beta: 0.01 };

/* Kept as the floor for the rate test, so a burst of samples sharing one
   timestamp cannot divide by zero and reject everything. */
export const MAX_STEP_DEGREES = 20;

/** Smallest signed turn from a to b, in degrees. Handles the 360 seam. */
export function shortestTurn(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export class HeadingTracker {
  /**
   * @param maxStep      degrees between samples above which a reading is
   *                     treated as a sensor glitch rather than a turn
   * @param minCutoff    One Euro: lower is steadier when still, laggier to
   *                     start turning
   * @param beta         One Euro: how hard speed opens the filter up
   */
  constructor({ maxRate = MAX_TURN_RATE, maxStep = MAX_STEP_DEGREES, minCutoff = ANGLE_FILTER.minCutoff, beta = ANGLE_FILTER.beta } = {}) {
    this.maxRate = maxRate;
    this.maxStep = maxStep;
    this.lastTime = null;
    this.filter = new OneEuroFilter({ minCutoff, beta });
    this.lastRaw = null;
    /* Heading is filtered as an UNWRAPPED, continuously growing angle.
       Smoothing the raw 0..360 value would average 359 and 1 to 180 — the
       marker would fly to the opposite wall every time you crossed north. */
    this.continuous = 0;
    this.rejected = 0;
    this.accepted = 0;
  }

  /**
   * @param alphaDegrees the raw compass reading, 0..360, or null
   * @param timestamp    milliseconds, monotonic
   * @returns { bearing, rejected } — bearing is relative to the first
   *          accepted reading, which is all the geometry needs: a heading
   *          offset common to every corner rotates the room and changes no
   *          dimension of it.
   */
  push(alphaDegrees, timestamp) {
    if (!Number.isFinite(alphaDegrees)) {
      return { bearing: this.bearing, rejected: true };
    }
    if (this.lastRaw === null) {
      this.lastRaw = alphaDegrees;
      this.lastTime = timestamp;
      this.continuous = 0;
      this.accepted = 1;
      this.filter.filter(0, timestamp);
      return { bearing: 0, rejected: false };
    }

    const step = shortestTurn(this.lastRaw, alphaDegrees);
    /* Judged as a RATE. dt is clamped to a nominal frame so a batch of
       samples sharing a timestamp does not read as infinite speed and get
       the whole batch thrown away. */
    let dt = (timestamp - this.lastTime) / 1000;
    if (!(dt > 0) || dt > 1) dt = 1 / 60;
    this.lastTime = timestamp;
    const allowed = Math.max(this.maxRate * dt, this.maxStep);
    if (Math.abs(step) > allowed) {
      /* A glitch. The raw value is still remembered, because the field may
         have genuinely shifted and refusing to ever follow it again would
         freeze the heading for good — but the step itself is not applied. */
      this.lastRaw = alphaDegrees;
      this.rejected += 1;
      return { bearing: this.bearing, rejected: true };
    }

    this.lastRaw = alphaDegrees;
    this.continuous += step;
    this.accepted += 1;
    this.filter.filter(this.continuous, timestamp);
    return { bearing: this.bearing, rejected: false };
  }

  get bearing() {
    return this.filter.x.value ?? 0;
  }

  /**
   * Is this compass worth trusting here?
   *
   * A handful of rejected samples is ordinary. A steady stream of them means
   * the phone is somewhere the field is being bent — next to a steel frame,
   * a meter box, a fridge — and the interface should say so rather than
   * drawing a confident wrong room.
   */
  get reliability() {
    const total = this.accepted + this.rejected;
    if (total < 30) return { verdict: 'unknown', rejectedFraction: 0 };
    const rejectedFraction = this.rejected / total;
    if (rejectedFraction > 0.25) {
      return {
        verdict: 'bad', rejectedFraction,
        reason: 'The compass is jumping — something magnetic is nearby. Step away from steel door frames, meter boxes and appliances, then start over.'
      };
    }
    if (rejectedFraction > 0.08) {
      return {
        verdict: 'noisy', rejectedFraction,
        reason: 'The compass is a little unsteady here.'
      };
    }
    return { verdict: 'good', rejectedFraction };
  }

  reset() {
    this.filter = new OneEuroFilter({
      minCutoff: this.filter.minCutoff, beta: this.filter.beta
    });
    this.lastRaw = null;
    this.lastTime = null;
    this.continuous = 0;
    this.rejected = 0;
    this.accepted = 0;
  }
}

/**
 * The same treatment for tilt, which needs no unwrapping — beta is already a
 * continuous value over the range that matters — but jitters just as much.
 */
export class TiltTracker {
  constructor({ minCutoff = ANGLE_FILTER.minCutoff, beta = ANGLE_FILTER.beta } = {}) {
    this.filter = new OneEuroFilter({ minCutoff, beta });
    this.seen = 0;
  }

  push(betaDegrees, timestamp) {
    if (!Number.isFinite(betaDegrees)) return this.tilt;
    this.seen += 1;
    this.filter.filter(betaDegrees, timestamp);
    return this.tilt;
  }

  get tilt() {
    return this.seen === 0 ? null : this.filter.x.value;
  }

  reset() {
    this.filter = new OneEuroFilter({
      minCutoff: this.filter.minCutoff, beta: this.filter.beta
    });
    this.seen = 0;
  }
}
