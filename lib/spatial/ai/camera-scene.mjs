/**
 * Scene quality from a live camera stream, in the browser.
 *
 * Draws a few frames of an already-open camera stream into a small canvas
 * (longest side SCENE_SAMPLE_PX), and judges them with the pure functions in
 * ./scene.mjs. The frames live only in that canvas, for the length of the
 * check: nothing is stored or sent (docs/PRIVACY-AR.md).
 */
import { SCENE_SAMPLE_PX } from './config.mjs';
import { lumaFrom, frameStats, frameMotion, judgeScene } from './scene.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * `stream` is an open MediaStream. `angleFromDown()` returns the camera's
 * current angle from straight down (or null). Resolves with the verdicts,
 * or null when no frame could be read — never throws.
 */
export async function sampleScene(stream, { frames = 4, intervalMs = 150, angleFromDown = () => null } = {}) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  try {
    video.srcObject = stream;
    await video.play();
    for (let i = 0; i < 20 && !(video.videoWidth > 0); i += 1) await wait(50);
    if (!(video.videoWidth > 0)) return null;
    const scale = SCENE_SAMPLE_PX / Math.max(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let previous = null;
    let current = null;
    let maxMotion = null;
    for (let i = 0; i < frames; i += 1) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      current = lumaFrom(image.data, canvas.width, canvas.height, SCENE_SAMPLE_PX);
      const motion = frameMotion(previous, current);
      if (motion != null) maxMotion = Math.max(maxMotion ?? 0, motion);
      previous = current;
      if (i < frames - 1) await wait(intervalMs);
    }
    return judgeScene(frameStats(current), { motion: maxMotion, angleFromDown: angleFromDown() });
  } catch {
    return null;
  } finally {
    try { video.pause(); video.srcObject = null; } catch { /* never attached */ }
  }
}
