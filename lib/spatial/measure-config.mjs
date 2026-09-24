/**
 * Every threshold the measuring code decides with, in one place.
 *
 * These numbers are STARTING POINTS, chosen from the physics below and from
 * the phones in docs/AR-DEVICE-MATRIX.md. None of them has yet been calibrated
 * against a tape measure. docs/ROOM-MEASUREMENT-VALIDATION.md is the
 * protocol that will; when its tables are filled in, change the number here,
 * say why in the comment beside it, and every caller follows.
 *
 * What does not belong here: a scale factor. If a method reads 2.6 m on a
 * 3.0 m wall, the fix is to find what is wrong (the angle, the height, the
 * hit) — never to multiply by 3 / 2.6.
 */

/* ------------------------------------------------ tracked (WebXR) capture -- */

export const HIT_SAMPLING = Object.freeze({
  /** How far back a corner looks. Long enough to average several frames of
      tracker noise, short enough that the reticle still under the thumb is
      the one being captured. */
  windowMs: 450,
  /** Fewer hits than this in the window is not "still", it is "barely
      tracking". At 30 fps, 450 ms holds about 13. */
  minSamples: 8,
  /** Largest robust spread (metres, 90th percentile distance from the
      median after outliers are dropped) that still counts as held still.
      A ±3 cm corner is ±3 cm on every wall touching it. */
  maxSpreadM: 0.03,
  /** A single sample further than this many robust deviations from the
      median is an outlier and does not vote. */
  outlierMads: 3.5,
  /** Floor under the MAD, so a perfectly steady run does not make every
      millimetre of noise an "outlier". */
  minMadM: 0.004
});

export const FLOOR_TARGET = Object.freeze({
  /** A floor's normal points up. More than this many degrees off vertical
      and the hit is a wall, a slope, or a sofa back. */
  maxNormalTiltDeg: 15,
  /** Height spread across the sampling window that a floor hit may show. */
  maxHeightSpreadM: 0.02,
  /** How far below the camera the floor must be. A "floor" at chest height
      is a table. Only applied when local-floor gives a real floor origin. */
  minBelowViewerM: 0.5
});

export const FLOOR_REFERENCE = Object.freeze({
  /** A new floor corner more than this above or below the established floor
      height is not on the same floor. The old rule allowed 25 cm, which
      accepts a low coffee table as floor. */
  maxDeviationM: 0.06,
  /** Readings needed before the floor height is treated as established. */
  minCorners: 1
});

export const ROOM_ACCEPTANCE = Object.freeze({
  minCorners: 3,
  /** Smallest and largest room the planner will accept from a scan, metres.
      Smaller is a mistap; larger is not a household room. */
  minSideM: 0.8,
  maxSideM: 20,
  /** The largest per-corner spread any corner may carry. */
  maxCornerSpreadM: 0.04,
  /** Two scans of the same room must agree on length and width within this
      fraction. This is REPEATABILITY: two equally wrong scans can agree. It
      says nothing about real-world accuracy, which only a tape can. */
  repeatTolerance: 0.05
});

/* -------------------------------------------------- aim (tilt) measuring -- */

export const AIM = Object.freeze({
  /** Roll past this refuses capture ("Straighten the phone."). */
  maxRollDeg: 10,
  /** Combined angular movement over the steadiness window that still counts
      as held still. Half a degree is about 2 cm at 2.5 m. */
  maxSteadySpreadDeg: 0.5,
  /** Below this many orientation events per second, the reading is too slow
      to follow a hand and the aim method is not offered. */
  minEventRate: 8,
  /** Heading reliability that allows a compass-built room outline. Poorer
      compasses may still measure a single distance, never a polygon. */
  headingVerdictsForOutline: ['good']
});

/* ------------------------------------------------------ photo measuring -- */

export const PHOTO = Object.freeze({
  /** Assumed fingertip error on a marked point, in image pixels, before zoom. */
  tapErrorPx: 6,
  /** A reference rectangle this skewed (0..1) was shot too far off square. */
  maxSkew: 0.35,
  /** Measuring a line more than this many times the reference's diagonal is
      extrapolating the plane well beyond anything that was calibrated. */
  maxExtrapolation: 12,
  /** Relative uncertainty above which a photo reading is only "coarse". */
  coarseRelativeSpread: 0.08
});
