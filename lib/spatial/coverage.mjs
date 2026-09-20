/**
 * How much of the room has actually been looked at.
 *
 * "SCAN ROOM" with a camera and no further guidance is the thing §12 rules
 * out, and for a good reason: a plane-detection scan only knows about
 * surfaces the phone has pointed at. Somebody who sweeps a quarter of the
 * room gets a floor polygon covering a quarter of the room, and — without
 * this module — a confident-looking "3.4 m x 2.1 m" that is simply the part
 * they happened to scan.
 *
 * So coverage is tracked as a first-class quantity, the scan says how far
 * through it you are, and the room's dimensions are not offered as final
 * until enough of the arc has been swept.
 *
 * ---------------------------------------------------------------------------
 * Why 180 degrees
 * ---------------------------------------------------------------------------
 *
 * Standing in a room and turning through a half-circle puts every wall in
 * front of the camera at some point, which is what plane detection needs. A
 * full 360 would mean turning your back on where you started for no extra
 * information, and asking for it makes the scan feel endless. The arc is
 * therefore a half-circle centred on wherever the scan began.
 *
 * Headings are yaw in radians as WebXR reports them, and the arc is measured
 * relative to the first heading seen — the tracking origin's absolute yaw is
 * arbitrary, so only the turn relative to the start means anything.
 */

/** The sweep asked for, in radians. A half-circle. */
export const SWEEP_RADIANS = Math.PI;

/** Wrap an angle to (-pi, pi]. */
export function normaliseAngle(angle) {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Coverage is counted over the WHOLE circle, and 180 degrees of it is the
 * target.
 *
 * An earlier version fixed the arc around the first heading seen — the arc
 * ran from 90 degrees left of where you started to 90 degrees right. That is
 * wrong about how people actually sweep a room: you face a wall, then turn.
 * Nobody starts in the middle of their own sweep, so somebody who turned a
 * full half-circle from their starting point filled half the bins and was
 * told they were 50% done.
 *
 * Binning absolute headings instead means the start point stops mattering.
 * Turn 180 degrees from anywhere, in either direction, in several goes if you
 * like, and it counts. Re-covering ground you have already swept adds
 * nothing, which is also correct: it reveals no new surfaces.
 */
export class SweepCoverage {
  /**
   * @param bins       divisions of the full circle. 72 is one per 5 degrees —
   *                   fine enough that a real sweep fills them smoothly,
   *                   coarse enough that a steady hand leaves no gaps it
   *                   cannot close.
   */
  constructor({ bins = 72 } = {}) {
    this.bins = bins;
    this.binsNeeded = Math.round(bins * (SWEEP_RADIANS / (2 * Math.PI)));
    this.seen = new Set();
    this.lastBin = null;
    this.started = false;
  }

  /** Which bin a heading falls in. Absolute, so the seam is just arithmetic. */
  binOf(yaw) {
    const wrapped = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return Math.min(this.bins - 1, Math.floor((wrapped / (2 * Math.PI)) * this.bins));
  }

  /**
   * Record that the camera is pointing along this heading.
   *
   * @param yaw  radians, from the viewer pose
   * @returns the bin index touched, or null for an unusable heading
   */
  observe(yaw) {
    if (!Number.isFinite(yaw)) return null;
    const bin = this.binOf(yaw);
    this.seen.add(bin);
    this.lastBin = bin;
    this.started = true;
    return bin;
  }

  /** How much of the half-circle has been swept, 0..1. */
  get fraction() {
    return Math.min(1, this.seen.size / this.binsNeeded);
  }

  /** The same, in degrees actually covered. Capped at the 180 asked for. */
  get degrees() {
    return this.fraction * 180;
  }

  /** Kept so callers that logged the first heading still work. */
  get origin() {
    return this.started ? this.lastBin : null;
  }

  /** How far, in bins, to the nearest unswept bin going one way round. */
  #gapDistance(direction) {
    if (this.lastBin === null) return Infinity;
    for (let step = 1; step <= this.bins; step++) {
      const bin = (this.lastBin + direction * step + this.bins * step) % this.bins;
      if (!this.seen.has(bin)) return step;
    }
    return Infinity;
  }

  /**
   * Which way to turn, in words the scan panel can show.
   *
   * Points toward the nearer unswept ground, so the instruction is the one
   * that gains soonest — and goes quiet once the sweep is done rather than
   * nagging.
   */
  guidance() {
    if (!this.started) return 'Point the camera at the floor to begin.';
    if (this.fraction >= 1) return 'Sweep complete.';

    // Skipped ground first: somebody who whipped the phone across touched the
    // ends and missed everything between, and telling them to keep turning
    // would walk them further from the gap.
    if (this.hasGaps()) {
      return 'Sweep back across more slowly — some of the room was passed over too fast.';
    }

    /*
       Which way is which.

       WebXR is Y-up and right-handed, so yaw increases counter-clockwise seen
       from above — which, for the person holding the phone, is a turn to
       their LEFT. Rising bin index therefore means "left", and an earlier
       version of this line had the two labels the wrong way round, which is
       the worst possible bug in a instruction whose entire job is to point.
    */
    return this.#gapDistance(1) <= this.#gapDistance(-1)
      ? 'Keep turning slowly to your left.'
      : 'Keep turning slowly to your right.';
  }

  /**
   * True when the swept bins are not one unbroken run.
   *
   * Contiguity is circular: a sweep straddling the seam is one run, not two.
   */
  hasGaps() {
    if (this.seen.size < 2 || this.seen.size >= this.bins) return false;
    // Exactly one boundary from unswept into swept means one run.
    let starts = 0;
    for (const bin of this.seen) {
      const before = (bin - 1 + this.bins) % this.bins;
      if (!this.seen.has(before)) starts++;
    }
    return starts > 1;
  }

  /** Bins as a boolean array, for drawing the arc. */
  toArray() {
    return Array.from({ length: this.bins }, (_, i) => this.seen.has(i));
  }

  reset() {
    this.seen.clear();
    this.lastBin = null;
    this.started = false;
  }
}

/**
 * Is the scan good enough to hand somebody a room measurement?
 *
 * Coverage alone is not it. You can sweep a perfect half-circle with the
 * phone pointed at the ceiling and detect no floor at all, and a scan that
 * reports "82%" while knowing nothing about the room is precisely the false
 * confidence this whole feature is meant to avoid. So the gate is every
 * condition together, and the caller is told which one is unmet.
 *
 * @param coverage  a SweepCoverage
 * @param room      the result of roomDimensions()
 * @returns {{ ready, blocking, progress }} progress is 0..1 for the bar
 */
export function scanReadiness(coverage, room, { minFraction = 0.75 } = {}) {
  const checks = [
    { key: 'floor', ok: Boolean(room?.rectangle), label: 'Floor' },
    { key: 'walls', ok: (room?.walls ?? 0) >= 2, label: 'Walls' },
    { key: 'sweep', ok: coverage.fraction >= minFraction, label: 'Sweep' },
    { key: 'height', ok: room?.height !== null && room?.height !== undefined, label: 'Height' }
  ];

  const blocking = checks.filter(check => !check.ok).map(check => check.key);

  return {
    ready: blocking.length === 0,
    blocking,
    checks,
    // Every check counts equally toward the bar, so it cannot read 90% off
    // sweep alone while the floor is still unknown.
    progress: checks.filter(check => check.ok).length / checks.length
  };
}
