/**
 * The AI benchmark and its classification (lib/spatial/ai/benchmark.mjs,
 * config.mjs): measured latency in, a level out; failures as codes, never
 * raw runtime exceptions; a cadence that backs off as the phone slows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, mean, percentile, classifyAiError, AI_ERROR, AdaptiveCadence } from '../lib/spatial/ai/benchmark.mjs';
import { AI_VISION, AI_THRESHOLDS, classifyAiPerformance, aiIsRealtime, aiCanAnalyseStill } from '../lib/spatial/ai/config.mjs';

/** A fake clock and an inference that "takes" the next listed duration. */
function fake(durations) {
  let t = 0;
  let i = 0;
  return {
    now: () => t,
    infer: async () => { t += durations[Math.min(i, durations.length - 1)]; i += 1; }
  };
}

test('mean and nearest-rank p95', () => {
  assert.equal(mean([10, 20, 30]), 20);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100], 95), 19);
  assert.equal(percentile([5], 95), 5);
  assert.ok(Number.isNaN(mean([])));
});

test('warm-up is not timed; average, p95 and fps come from the timed runs', async () => {
  const { now, infer } = fake([500, 500, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 60]);
  const r = await runBenchmark(infer, { now, backend: 'wasm' });
  assert.equal(r.ok, true);
  assert.equal(r.warmupMs, 1000, 'two slow warm-ups');
  assert.equal(r.runs, AI_THRESHOLDS.runs);
  assert.ok(r.averageMs > 40 && r.averageMs < 42);
  assert.equal(r.p95Ms, 60);
  assert.equal(r.mode, AI_VISION.REALTIME);
});

test('classification: WebGPU real-time, WASM real-time, single frame, none', () => {
  assert.equal(classifyAiPerformance({ ok: true, backend: 'webgpu', p95Ms: 35 }), AI_VISION.GPU);
  assert.equal(classifyAiPerformance({ ok: true, backend: 'wasm', p95Ms: 35 }), AI_VISION.REALTIME);
  assert.equal(classifyAiPerformance({ ok: true, backend: 'wasm', p95Ms: 180 }), AI_VISION.SINGLE_FRAME,
    'the brief\'s example: WASM at 180 ms is single-frame');
  assert.equal(classifyAiPerformance({ ok: true, backend: 'webgpu', p95Ms: 180 }), AI_VISION.SINGLE_FRAME,
    'a slow GPU is not "GPU real-time"');
  assert.equal(classifyAiPerformance({ ok: true, backend: 'wasm', p95Ms: 4000 }), AI_VISION.NONE);
  assert.equal(classifyAiPerformance({ ok: false }), AI_VISION.NONE);
  assert.equal(classifyAiPerformance(null), AI_VISION.NONE);
  assert.equal(classifyAiPerformance({ ok: true, p95Ms: NaN }), AI_VISION.NONE);
  assert.ok(aiIsRealtime(AI_VISION.GPU) && aiIsRealtime(AI_VISION.REALTIME) && !aiIsRealtime(AI_VISION.SINGLE_FRAME));
  assert.ok(aiCanAnalyseStill(AI_VISION.SINGLE_FRAME) && !aiCanAnalyseStill(AI_VISION.NONE));
});

test('thresholds live in one module and are the ones the classifier uses', () => {
  const t = { ...AI_THRESHOLDS, realtimeP95Ms: 200 };
  assert.equal(classifyAiPerformance({ ok: true, backend: 'wasm', p95Ms: 180 }, t), AI_VISION.REALTIME);
});

test('a failing or hanging inference becomes a coded failure, not a throw', async () => {
  const failed = await runBenchmark(async () => { throw new RangeError('memory access out of bounds'); }, { backend: 'wasm' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, AI_ERROR.OUT_OF_MEMORY);
  const hung = await runBenchmark(() => new Promise(() => {}), { timeoutMs: 20, warmupRuns: 0, runs: 1, backend: 'wasm' });
  assert.equal(hung.ok, false);
  assert.equal(hung.error.code, AI_ERROR.TIMEOUT);
  assert.equal(classifyAiPerformance(hung), AI_VISION.NONE);
});

test('error classification covers every documented failure', () => {
  assert.equal(classifyAiError(new Error('Failed to fetch'), 'download').code, AI_ERROR.DOWNLOAD_FAILED);
  assert.equal(classifyAiError(new Error('no available backend found. ERR: [webgpu] backend not found.'), 'webgpu').code, AI_ERROR.WEBGPU_FAILED);
  assert.equal(classifyAiError(new Error('WebAssembly.instantiate(): Out of memory')).code, AI_ERROR.OUT_OF_MEMORY);
  assert.equal(classifyAiError(new Error('failed to instantiate wasm'), 'wasm').code, AI_ERROR.WASM_FAILED);
  assert.equal(classifyAiError(new Error('Unsupported model IR version: 11, opset 21')).code, AI_ERROR.MODEL_UNSUPPORTED);
  assert.equal(classifyAiError(null).code, AI_ERROR.UNKNOWN);
  assert.ok(classifyAiError(new Error('x'.repeat(500))).message.length <= 200, 'the raw message is truncated for the report');
});

test('cadence: never every frame, backs off as the phone slows, stops when it overheats', () => {
  const c = new AdaptiveCadence({ targetFps: 10 });
  assert.equal(c.state().intervalMs, 100, '10 inferences a second, whatever the camera does');
  for (let i = 0; i < 5; i += 1) c.record(40);
  assert.equal(c.state().baselineMs, 40);
  for (let i = 0; i < 4; i += 1) c.record(40);
  assert.equal(c.state().intervalMs, 100, 'steady latency changes nothing');
  for (let i = 0; i < 8; i += 1) c.record(70);   // 1.75 × baseline: back off
  assert.ok(c.state().intervalMs >= 200 && !c.state().stopped, JSON.stringify(c.state()));
  for (let i = 0; i < 8; i += 1) c.record(120);  // 3 × baseline: stop live AI
  assert.equal(c.state().stopped, true);
});

test('cadence: an inference slower than the interval widens it at once', () => {
  const c = new AdaptiveCadence({ targetFps: 15 });
  c.record(250);
  assert.ok(c.state().intervalMs >= 300);
  assert.ok(c.state().intervalMs <= 1000, 'never slower than once a second');
});
