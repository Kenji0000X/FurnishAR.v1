/**
 * The AI benchmark: how fast THIS phone runs a model, measured.
 *
 * Warm-up inferences first (untimed: shader compilation and first allocation
 * are not the steady state), then N timed inferences, then the average, the
 * p95 and an fps estimate. The level comes from classifyAiPerformance() in
 * ./config.mjs. Nothing here looks at the phone's name or specifications.
 *
 * Pure: `infer` and `now` are injected, so the arithmetic and the failure
 * handling are tested without a model (tests/ai-benchmark.test.js). The
 * browser wiring is in ./runtime.mjs.
 */
import { AI_THRESHOLDS, classifyAiPerformance } from './config.mjs';

/** Mean of a list of numbers; NaN for an empty list. */
export function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile (p in 0..100), the definition that needs no interpolation. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

const round1 = value => Math.round(value * 10) / 10;

/** Races `promise` against a timeout, rejecting with an error named TimeoutError. */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} took longer than ${ms} ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs the benchmark. `infer()` performs one inference and resolves when its
 * output is ready. Returns the measured result, or `{ ok: false, error }`
 * when an inference failed or timed out — never a throw, so the device
 * check can always show a row.
 */
export async function runBenchmark(infer, {
  runs = AI_THRESHOLDS.runs,
  warmupRuns = AI_THRESHOLDS.warmupRuns,
  timeoutMs = AI_THRESHOLDS.inferenceTimeoutMs,
  now = () => performance.now(),
  backend = null
} = {}) {
  const timings = [];
  let warmupMs = 0;
  try {
    const warmStart = now();
    for (let i = 0; i < warmupRuns; i += 1) await withTimeout(Promise.resolve().then(infer), timeoutMs, 'AI warm-up');
    warmupMs = now() - warmStart;
    for (let i = 0; i < runs; i += 1) {
      const start = now();
      await withTimeout(Promise.resolve().then(infer), timeoutMs, 'AI inference');
      timings.push(now() - start);
    }
  } catch (error) {
    return { ok: false, backend, error: classifyAiError(error), timings };
  }
  const avg = mean(timings);
  const p95 = percentile(timings, 95);
  const result = {
    ok: true,
    backend,
    runs: timings.length,
    warmupMs: round1(warmupMs),
    averageMs: round1(avg),
    p95Ms: round1(p95),
    fpsEstimate: avg > 0 ? round1(1000 / avg) : null,
    timings: timings.map(round1)
  };
  return { ...result, mode: classifyAiPerformance(result) };
}

/**
 * An AI failure, in a code the interface can word and the report can carry.
 * The raw message is kept for the technical report only; no ONNX exception
 * text is ever shown as the main message.
 */
export const AI_ERROR = Object.freeze({
  DOWNLOAD_FAILED: 'model-download-failed',
  MODEL_UNSUPPORTED: 'model-unsupported',
  WEBGPU_FAILED: 'webgpu-init-failed',
  WASM_FAILED: 'wasm-init-failed',
  OUT_OF_MEMORY: 'out-of-memory',
  TIMEOUT: 'inference-timeout',
  UNKNOWN: 'ai-unavailable'
});

export function classifyAiError(error, stage = null) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  let code = AI_ERROR.UNKNOWN;
  if (name === 'TimeoutError' || /timed? ?out|took longer/i.test(message)) code = AI_ERROR.TIMEOUT;
  else if (/out of memory|allocation failed|RangeError|memory access out of bounds|OOM/i.test(`${name} ${message}`)) code = AI_ERROR.OUT_OF_MEMORY;
  else if (stage === 'download' || /failed to fetch|NetworkError|404|load model|fetch/i.test(message)) code = AI_ERROR.DOWNLOAD_FAILED;
  else if (stage === 'webgpu' || /webgpu|gpu adapter|requestAdapter/i.test(message)) code = AI_ERROR.WEBGPU_FAILED;
  else if (stage === 'wasm' || /wasm|WebAssembly|backend.*not.*(found|available)/i.test(message)) code = AI_ERROR.WASM_FAILED;
  else if (/unsupported|not implemented|opset|invalid model|protobuf/i.test(message)) code = AI_ERROR.MODEL_UNSUPPORTED;
  return { code, name: name || 'Error', message: message.slice(0, 200) };
}

export const AI_ERROR_COPY = Object.freeze({
  [AI_ERROR.DOWNLOAD_FAILED]: 'The AI model could not be downloaded. Check the connection and try again.',
  [AI_ERROR.MODEL_UNSUPPORTED]: 'This browser cannot run the AI model.',
  [AI_ERROR.WEBGPU_FAILED]: 'The GPU could not run the AI model.',
  [AI_ERROR.WASM_FAILED]: 'This browser could not start the AI runtime.',
  [AI_ERROR.OUT_OF_MEMORY]: 'The phone ran out of memory for the AI model.',
  [AI_ERROR.TIMEOUT]: 'The AI model took too long on this phone.',
  [AI_ERROR.UNKNOWN]: 'AI camera guidance is not available on this phone.'
});

/**
 * Keeps live AI at a sustainable cadence, and backs off as the phone heats.
 *
 * AI never runs on every camera frame: the camera and WebXR tracking keep
 * their own rate, and inference is scheduled at `intervalMs`. The first
 * `baselineSamples` latencies set the baseline median. If the recent median
 * climbs past `slowdownFactor` × baseline, the interval doubles (at most to
 * `maxIntervalMs`); past `stopFactor` × baseline, live AI stops and the
 * caller offers single-frame analysis instead. The camera never freezes to
 * keep an AI icon green.
 */
export class AdaptiveCadence {
  constructor({
    targetFps = 8,
    minIntervalMs = 1000 / 15,
    maxIntervalMs = 1000,
    baselineSamples = 5,
    windowSize = 8,
    slowdownFactor = AI_THRESHOLDS.slowdownFactor,
    stopFactor = AI_THRESHOLDS.stopFactor
  } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.intervalMs = Math.max(minIntervalMs, 1000 / targetFps);
    this.baselineSamples = baselineSamples;
    this.windowSize = windowSize;
    this.slowdownFactor = slowdownFactor;
    this.stopFactor = stopFactor;
    this.baseline = null;
    this.samples = [];
    this.recent = [];
    this.stopped = false;
    this.sinceBackoff = 0;
  }

  /** Records one inference latency; returns the current decision. */
  record(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return this.state();
    if (this.baseline === null) {
      this.samples.push(latencyMs);
      if (this.samples.length >= this.baselineSamples) this.baseline = percentile(this.samples, 50);
      // An inference slower than the interval widens it immediately.
      this.intervalMs = Math.min(this.maxIntervalMs, Math.max(this.intervalMs, latencyMs * 1.2));
      return this.state();
    }
    this.recent.push(latencyMs);
    if (this.recent.length > this.windowSize) this.recent.shift();
    this.sinceBackoff += 1;
    if (this.recent.length >= Math.min(this.windowSize, 4)) {
      const median = percentile(this.recent, 50);
      if (median >= this.baseline * this.stopFactor) {
        this.stopped = true;
      } else if (median >= this.baseline * this.slowdownFactor && this.sinceBackoff >= 4) {
        // Back off at most once per four inferences, so one slow spell
        // does not collapse the cadence to the floor at once.
        this.intervalMs = Math.min(this.maxIntervalMs, this.intervalMs * 2);
        this.sinceBackoff = 0;
      }
    }
    return this.state();
  }

  state() {
    return {
      intervalMs: Math.round(this.intervalMs),
      stopped: this.stopped,
      baselineMs: this.baseline === null ? null : round1(this.baseline)
    };
  }
}
