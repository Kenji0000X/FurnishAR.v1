/**
 * On-device AI: the capability levels and every threshold, in one place.
 *
 * AI IS A CAPABILITY WITH LEVELS, NOT A VERDICT. A phone does not "support
 * AI"; it runs a given model at a measured speed on a measured backend. The
 * level is decided from that measurement only, never from the phone's name,
 * its RAM, its chipset or its camera. It never decides whether WebXR works:
 * that is proven by an AR session (lib/spatial/capabilities.mjs).
 *
 * The thresholds below are STARTING POINTS, chosen from what each level is
 * for rather than tuned to a phone. Change them here, citing the device data
 * (docs/AR-DEVICE-MATRIX.md) in the comment, when physical tests disagree.
 */

export const AI_VISION = Object.freeze({
  /** No model could run (no runtime, no memory, too slow even for a still). */
  NONE: 'ai-none',
  /** Too slow for a live view, fast enough to analyse one captured frame. */
  SINGLE_FRAME: 'ai-single-frame',
  /** Fast enough for live guidance at a throttled cadence. */
  REALTIME: 'ai-realtime',
  /** Real-time, on the GPU (WebGPU verified by an actual inference). */
  GPU: 'ai-gpu'
});

export const AI_THRESHOLDS = Object.freeze({
  /*
    Live guidance runs AI at 5–15 inferences a second, never every camera
    frame (the camera and WebXR tracking keep their own rate). The p95 must
    fit the slowest useful cadence, 10 per second: 100 ms. p95 rather than
    the mean, because it is the slow inferences that make guidance lag.
  */
  realtimeP95Ms: 100,
  /*
    A still photo analysed after capture: the person is waiting for a tap
    result, and 1.5 s is the longest that still reads as "working" rather
    than "stuck".
  */
  singleFrameP95Ms: 1500,
  /** Timed inferences after warm-up; 12 gives a p95 from real samples. */
  runs: 12,
  /** Warm-up inferences, not timed: shader compilation, first allocation. */
  warmupRuns: 2,
  /** Any single inference slower than this is treated as a failure. */
  inferenceTimeoutMs: 8000,
  /** Model download plus session creation. */
  loadTimeoutMs: 45000,
  /*
    Thermal back-off. If the recent median latency has grown past this
    factor of the first measured median, the cadence is halved; past the
    second factor, live AI stops and single-frame analysis is offered.
  */
  slowdownFactor: 1.5,
  stopFactor: 2.5
});

/**
 * The approved models, smallest first. A model is fetched only on /diagnose
 * (the AI check) or in AI-assisted measurement, never while browsing.
 *
 * `kind: 'benchmark'` is a fixed synthetic workload with the shape and
 * arithmetic of a small segmentation network (depthwise-separable
 * convolutions at 192 × 192). It measures what this phone's runtime can
 * sustain; it does NOT understand scenes, and nothing may present its output
 * as floors or walls. A trained segmentation model would be added here with
 * `kind: 'segmentation'`, its labels and its licence.
 */
export const AI_MODELS = Object.freeze([
  Object.freeze({
    id: 'furnishar-bench-v1',
    kind: 'benchmark',
    url: '/ai/furnishar-bench-v1.onnx',
    input: Object.freeze({ name: 'input', shape: [1, 3, 192, 192] }),
    output: 'output',
    description: 'Synthetic performance probe (not a scene model)'
  })
]);

/**
 * The level a measured benchmark earns. Pure; `result` is what
 * lib/spatial/ai/benchmark.mjs measured, or a failure.
 */
export function classifyAiPerformance(result, thresholds = AI_THRESHOLDS) {
  if (!result || result.ok !== true) return AI_VISION.NONE;
  const p95 = Number(result.p95Ms);
  if (!Number.isFinite(p95) || p95 <= 0) return AI_VISION.NONE;
  if (p95 <= thresholds.realtimeP95Ms) return result.backend === 'webgpu' ? AI_VISION.GPU : AI_VISION.REALTIME;
  if (p95 <= thresholds.singleFrameP95Ms) return AI_VISION.SINGLE_FRAME;
  return AI_VISION.NONE;
}

/** True for both real-time levels. */
export function aiIsRealtime(mode) {
  return mode === AI_VISION.REALTIME || mode === AI_VISION.GPU;
}

/** True for any level that can analyse at least one still frame. */
export function aiCanAnalyseStill(mode) {
  return aiIsRealtime(mode) || mode === AI_VISION.SINGLE_FRAME;
}

export const AI_VISION_LABEL = Object.freeze({
  [AI_VISION.NONE]: 'Unavailable',
  [AI_VISION.SINGLE_FRAME]: 'Available with limitations: one photo at a time',
  [AI_VISION.REALTIME]: 'Available: real-time',
  [AI_VISION.GPU]: 'Available: real-time on the GPU'
});

/**
 * Scene-quality thresholds (lib/spatial/ai/scene.mjs). Classical measures on
 * a downscaled luminance image (longest side SCENE_SAMPLE_PX), 0–255. All are
 * uncalibrated starting points: tune them from recorded frames of the test
 * phones, not from one room.
 */
export const SCENE_SAMPLE_PX = 160;

export const SCENE_THRESHOLDS = Object.freeze({
  /** Mean luminance below this reads as too dark for tracking. */
  darkMeanLuma: 45,
  /** Share of near-black pixels (< 25) above which the view is too dark. */
  darkFraction: 0.6,
  /** Share of clipped pixels (> 245) above which the view is overexposed. */
  clippedFraction: 0.25,
  /** Variance of the Laplacian below this is motion blur or defocus. */
  blurVariance: 60,
  /** Gradient magnitude that counts a pixel as "detail". */
  edgeGradient: 24,
  /** Share of detail pixels below which the view is featureless. */
  featurelessFraction: 0.04,
  /** Mean absolute frame difference (per sample pixel) that is fast motion. */
  fastMotion: 18,
  /** Camera within this many degrees of the horizon or above: floor likely out of view. */
  floorOutOfViewDegreesFromDown: 80
});
