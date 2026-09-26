/**
 * Scene quality (lib/spatial/ai/scene.mjs): classical measures on synthetic
 * frames with known properties, and the rule that AI never outranks WebXR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lumaFrom, frameStats, frameMotion, judgeScene, combineFloorEvidence } from '../lib/spatial/ai/scene.mjs';

const W = 64;
const H = 48;
/** An RGBA frame from a luminance function f(x, y) → 0..255. */
function frame(f) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const v = f(x, y);
    const i = (y * W + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  return lumaFrom(rgba, W, H, 64);
}
const checker = (on = 200, off = 60, size = 4, shift = 0) => frame((x, y) => ((Math.floor((x + shift) / size) + Math.floor(y / size)) % 2 ? on : off));

test('a well-lit, detailed, sharp view needs no guidance', () => {
  const s = frameStats(checker());
  const v = judgeScene(s, { motion: 2, angleFromDown: 45 });
  assert.equal(v.lightingQuality, 'good');
  assert.equal(v.motionBlur, 'sharp');
  assert.equal(v.sceneTextureQuality, 'good');
  assert.equal(v.ok, true);
  assert.deepEqual(v.guidance, []);
});

test('too dark says so first, in plain words', () => {
  const v = judgeScene(frameStats(checker(30, 5)), { motion: 1 });
  assert.equal(v.lightingQuality, 'dark');
  assert.equal(v.guidance[0], 'The room is too dark for reliable tracking. Turn on a light.');
});

test('overexposed', () => {
  assert.equal(judgeScene(frameStats(frame(() => 252))).lightingQuality, 'overexposed');
});

test('a blank, even surface is featureless and blurred-looking', () => {
  const v = judgeScene(frameStats(frame(() => 128)), { motion: 1, angleFromDown: 40 });
  assert.equal(v.sceneTextureQuality, 'featureless');
  assert.ok(v.guidance.includes('Point toward an area with more visual detail.'));
});

test('fast camera motion from two frames', () => {
  const a = checker(200, 60, 4, 0);
  const b = checker(200, 60, 4, 4);
  const motion = frameMotion(a, b);
  assert.ok(motion > 18, String(motion));
  assert.equal(judgeScene(frameStats(b), { motion }).cameraMotion, 'fast');
  assert.ok(judgeScene(frameStats(b), { motion }).guidance.includes('Move more slowly.'));
  assert.equal(frameMotion(a, null), null);
});

test('camera at the horizon or above: point lower (from the sensor, not a model)', () => {
  const v = judgeScene(frameStats(checker()), { motion: 1, angleFromDown: 88 });
  assert.equal(v.floorOutOfView, true);
  assert.ok(v.guidance.includes('Point lower so the floor is visible.'));
});

test('floor and wall confidence are "not tested" without a model, never guessed', () => {
  const v = judgeScene(frameStats(checker()));
  assert.equal(v.floorConfidence, null);
  assert.equal(v.wallConfidence, null);
});

test('at most two guidance lines, so the camera is never covered', () => {
  const v = judgeScene(frameStats(frame(() => 10)), { motion: 40, angleFromDown: 95 });
  assert.ok(v.guidance.length <= 2);
});

test('WebXR stays the authority: AI can reject a hit, never create one', () => {
  assert.equal(combineFloorEvidence(null, 0.99).accept, false, 'no hit, no placement, whatever the AI says');
  assert.equal(combineFloorEvidence({ hit: false }, 0.99).accept, false);
  assert.equal(combineFloorEvidence({ hit: true, accept: true }, null).accept, true, 'no AI: WebXR decides alone');
  assert.equal(combineFloorEvidence({ hit: true, accept: true }, 0.05).accept, false, 'confidently not floor (a table top)');
  assert.equal(combineFloorEvidence({ hit: true, accept: true }, 0.05).reason, 'not-floor');
  assert.equal(combineFloorEvidence({ hit: true, accept: true }, 0.4).accept, true, 'an unsure AI changes nothing');
  assert.equal(combineFloorEvidence({ hit: true, accept: false, reason: 'unsteady' }, 0.95).accept, false,
    'AI cannot overrule WebXR\'s own refusal');
});
