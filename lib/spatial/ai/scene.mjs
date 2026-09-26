/**
 * Scene quality: WHY tracking or measuring may fail, from the camera image.
 *
 * The highest-value use of vision here is explaining a failure before it
 * happens: too dark, overexposed, blurred by movement, a blank wall or floor
 * with nothing to track, the floor out of view. These are measured with
 * classical image statistics on a small luminance copy of one frame. They
 * need no trained model, cost a few milliseconds, and run entirely on the
 * phone: the frame is never stored or sent anywhere (docs/PRIVACY-AR.md).
 *
 * WHAT THIS DOES NOT DO: find floors, walls or corners, or measure anything.
 * Floor and wall confidence need a trained segmentation model, which is not
 * shipped yet (lib/spatial/ai/config.mjs AI_MODELS); until one is, they are
 * reported as null ("not tested"), never guessed from brightness. And no
 * result here supplies metric scale: that comes from WebXR, a reference
 * object, calibrated sensors or a tape measure.
 *
 * Pure: frames are passed in as RGBA arrays, so every rule is tested without
 * a camera (tests/ai-scene.test.js).
 */
import { SCENE_THRESHOLDS } from './config.mjs';

/**
 * Luminance of an RGBA image, point-sampled down so the longest side is at
 * most `maxSide`. Returns { luma: Float32Array, width, height }.
 */
export function lumaFrom(rgba, width, height, maxSide = 160) {
  const scale = Math.max(1, Math.max(width, height) / maxSide);
  const w = Math.max(1, Math.floor(width / scale));
  const h = Math.max(1, Math.floor(height / scale));
  const luma = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(height - 1, Math.floor(y * scale));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x * scale));
      const i = (sy * width + sx) * 4;
      // Rec. 601 luma: what "bright" means to a tracker as much as to an eye.
      luma[y * w + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  return { luma, width: w, height: h };
}

/** Exposure, sharpness and detail of one luminance frame. */
export function frameStats({ luma, width, height }, t = SCENE_THRESHOLDS) {
  const n = width * height;
  let sum = 0;
  let dark = 0;
  let clipped = 0;
  for (let i = 0; i < n; i += 1) {
    const v = luma[i];
    sum += v;
    if (v < 25) dark += 1;
    if (v > 245) clipped += 1;
  }
  // Laplacian variance (sharpness) and gradient density (texture), interior pixels.
  let lapSum = 0;
  let lapSq = 0;
  let edges = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const c = luma[i];
      const lap = luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width] - 4 * c;
      lapSum += lap;
      lapSq += lap * lap;
      const gx = luma[i + 1] - luma[i - 1];
      const gy = luma[i + width] - luma[i - width];
      if (Math.hypot(gx, gy) > t.edgeGradient) edges += 1;
      count += 1;
    }
  }
  const lapMean = count ? lapSum / count : 0;
  return {
    meanLuma: n ? sum / n : 0,
    darkFraction: n ? dark / n : 0,
    clippedFraction: n ? clipped / n : 0,
    sharpness: count ? lapSq / count - lapMean * lapMean : 0,
    detailFraction: count ? edges / count : 0
  };
}

/** Mean absolute difference between two same-sized luminance frames. */
export function frameMotion(previous, current) {
  if (!previous || !current || previous.luma.length !== current.luma.length) return null;
  let diff = 0;
  for (let i = 0; i < current.luma.length; i += 1) diff += Math.abs(current.luma[i] - previous.luma[i]);
  return diff / current.luma.length;
}

/**
 * The verdicts and at most two short sentences of guidance, most important
 * first. `motion` is frameMotion() (or null); `angleFromDown` is the camera
 * axis's angle from straight down in degrees (lib/spatial/orientation.mjs
 * cameraPose), or null when there is no sensor.
 */
export function judgeScene(stats, { motion = null, angleFromDown = null } = {}, t = SCENE_THRESHOLDS) {
  const lightingQuality = stats.meanLuma < t.darkMeanLuma || stats.darkFraction > t.darkFraction ? 'dark'
    : stats.clippedFraction > t.clippedFraction ? 'overexposed' : 'good';
  const motionBlur = stats.sharpness < t.blurVariance ? 'blurred' : 'sharp';
  const sceneTextureQuality = stats.detailFraction < t.featurelessFraction ? 'featureless' : 'good';
  const cameraMotion = motion == null ? 'unknown' : motion > t.fastMotion ? 'fast' : 'steady';
  const floorOutOfView = Number.isFinite(angleFromDown) && angleFromDown >= t.floorOutOfViewDegreesFromDown;

  const guidance = [];
  if (lightingQuality === 'dark') guidance.push('The room is too dark for reliable tracking. Turn on a light.');
  if (lightingQuality === 'overexposed') guidance.push('Too much glare. Turn away from the window or bright light.');
  if (cameraMotion === 'fast') guidance.push('Move more slowly.');
  else if (motionBlur === 'blurred' && lightingQuality === 'good') guidance.push('Hold the phone steady for a moment.');
  if (floorOutOfView) guidance.push('Point lower so the floor is visible.');
  if (sceneTextureQuality === 'featureless' && lightingQuality === 'good') guidance.push('Point toward an area with more visual detail.');

  return {
    lightingQuality,
    motionBlur,
    sceneTextureQuality,
    cameraMotion,
    floorOutOfView,
    // Not measurable without a trained segmentation model: null, not a guess.
    floorConfidence: null,
    wallConfidence: null,
    guidance: guidance.slice(0, 2),
    ok: guidance.length === 0
  };
}

/**
 * Combines WebXR's hit with an AI floor estimate, when one exists.
 *
 * WebXR stays the authority on WHERE: without a hit there is no placement,
 * whatever the AI thinks. The AI can only make a hit LESS trusted, when it
 * is confident the reticle is not on the floor (a table top, a bed, a
 * chair). A low-confidence AI answer changes nothing. `floorProbability` is
 * the model's probability that the reticle's pixel is floor, or null.
 */
export function combineFloorEvidence(xrTarget, floorProbability, { rejectBelow = 0.15, minConfidence = 0.7 } = {}) {
  if (!xrTarget || !xrTarget.hit) return { accept: false, reason: 'no-hit', source: 'webxr' };
  if (floorProbability == null || !Number.isFinite(floorProbability)) {
    return { accept: xrTarget.accept !== false, reason: xrTarget.reason || 'webxr', source: 'webxr' };
  }
  const aiSaysNotFloor = floorProbability <= rejectBelow && (1 - floorProbability) >= minConfidence;
  if (aiSaysNotFloor) return { accept: false, reason: 'not-floor', source: 'webxr+ai' };
  return { accept: xrTarget.accept !== false, reason: xrTarget.reason || 'webxr', source: 'webxr+ai' };
}
