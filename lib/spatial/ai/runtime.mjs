/**
 * The on-device AI runtime, in the browser: ONNX Runtime Web.
 *
 * LOADED ONLY WHEN ASKED. Nothing here runs on import. The runtime's
 * JavaScript and WebAssembly live in /ort/ (scripts/copy-ort-assets.mjs) and
 * are imported with webpackIgnore, so they are never part of any Next.js
 * bundle: browsing the catalogue, a product page, the portal or the admin
 * console downloads none of it. /diagnose fetches it after a tap on "Check
 * AI camera capability"; AI-assisted measurement fetches it when it starts.
 *
 * BACKEND ORDER, PROVEN NOT ASSUMED.
 *   1. WebGPU, only if navigator.gpu exists AND requestAdapter() returns an
 *      adapter AND a session actually runs an inference on it.
 *   2. WASM (CPU, SIMD), the fallback that works in every browser that has
 *      WebAssembly.
 * A WebGPU failure at any step falls through to WASM; the report says which
 * backends were tried and why each one failed.
 *
 * ON THE PHONE. The model is downloaded; nothing is uploaded. The benchmark
 * feeds the model a synthetic tensor, not a camera frame.
 */
import { AI_MODELS, AI_THRESHOLDS, aiIsRealtime } from './config.mjs';
import { runBenchmark, classifyAiError, withTimeout } from './benchmark.mjs';

const ORT_BASE = '/ort/';
const ENTRY = { webgpu: 'ort.webgpu.min.mjs', wasm: 'ort.wasm.min.mjs' };

/** Is there a GPU adapter? A real request, not a feature sniff. */
export async function detectWebGpu() {
  if (typeof navigator === 'undefined' || !navigator.gpu?.requestAdapter) return { available: false, reason: 'no navigator.gpu' };
  try {
    const adapter = await withTimeout(navigator.gpu.requestAdapter(), 5000, 'WebGPU adapter');
    if (!adapter) return { available: false, reason: 'no adapter' };
    return { available: true, reason: null };
  } catch (error) {
    return { available: false, reason: `${error?.name || 'Error'}: ${String(error?.message || '').slice(0, 120)}` };
  }
}

/** Imports one ORT build from our own origin, outside the bundle. */
async function importOrt(backend) {
  const url = `${ORT_BASE}${ENTRY[backend]}`;
  const ort = await import(/* webpackIgnore: true */ url);
  // Glue and .wasm are resolved next to the entry; single-threaded unless the
  // page is cross-origin isolated (it is not), which is what phones get anyway.
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.logLevel = 'error';
  return ort;
}

/** A deterministic synthetic input: the benchmark never touches the camera. */
function syntheticInput(ort, shape) {
  const size = shape.reduce((a, b) => a * b, 1);
  const data = new Float32Array(size);
  let seed = 12345;
  for (let i = 0; i < size; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed / 0x7fffffff;
  }
  return new ort.Tensor('float32', data, shape);
}

async function tryBackend(backend, model, onProgress) {
  const stage = backend;
  let ort;
  let session = null;
  let input = null;
  const started = performance.now();
  try {
    onProgress?.(`Starting the ${backend === 'webgpu' ? 'GPU' : 'CPU'} runtime…`);
    ort = await importOrt(backend);
  } catch (error) {
    return { ok: false, backend, error: classifyAiError(error, stage) };
  }
  try {
    onProgress?.('Downloading the AI test model…');
    const response = await withTimeout(fetch(model.url, { cache: 'force-cache' }), AI_THRESHOLDS.loadTimeoutMs, 'model download');
    if (!response.ok) throw Object.assign(new Error(`model ${response.status}`), { name: 'DownloadError' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.('Preparing the model…');
    session = await withTimeout(
      ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: 'all' }),
      AI_THRESHOLDS.loadTimeoutMs, 'model load');
  } catch (error) {
    const code = error?.name === 'DownloadError' || /fetch|model download/i.test(String(error?.message)) ? 'download' : stage;
    return { ok: false, backend, error: classifyAiError(error, code) };
  }
  const loadMs = Math.round(performance.now() - started);
  try {
    input = syntheticInput(ort, model.input.shape);
    onProgress?.('Timing the model on this phone…');
    const result = await runBenchmark(async () => {
      const out = await session.run({ [model.input.name]: input });
      // Reading the output forces a GPU backend to finish the work.
      const tensor = out[model.output];
      if (tensor?.getData) await tensor.getData(); else void tensor?.data;
      tensor?.dispose?.();
    }, { backend });
    return { ...result, loadMs };
  } finally {
    // Release everything: tensors, the session, and with it GPU buffers.
    try { input?.dispose?.(); } catch { /* already released */ }
    try { await session?.release(); } catch { /* already released */ }
  }
}

/**
 * The whole AI check. Returns the facts /diagnose records and the report
 * carries (all measured; nothing inferred from the device). Never throws.
 */
export async function checkAiCapability({ onProgress, model = AI_MODELS[0] } = {}) {
  const facts = {
    aiRuntimeAvailable: false,
    aiBackend: null,
    aiBackendsTried: [],
    aiModel: model.id,
    aiModelLoaded: false,
    sceneAnalysisAvailable: true   // classical scene quality needs no model
  };
  if (typeof WebAssembly === 'undefined') {
    return { ...facts, aiMode: 'ai-none', aiError: { code: 'wasm-init-failed', name: 'Error', message: 'WebAssembly is not available' } };
  }

  const gpu = await detectWebGpu();
  facts.aiWebgpuAdapter = gpu.available;
  const order = gpu.available ? ['webgpu', 'wasm'] : ['wasm'];
  if (!gpu.available) facts.aiBackendsTried.push({ backend: 'webgpu', ok: false, reason: gpu.reason });

  let best = null;
  let last = null;
  for (const backend of order) {
    const result = await tryBackend(backend, model, onProgress);
    facts.aiBackendsTried.push({ backend, ok: result.ok, ...(result.ok ? { p95Ms: result.p95Ms } : { reason: result.error?.code }) });
    last = result;
    if (result.ok && (!best || result.p95Ms < best.p95Ms)) best = result;
    // A GPU that runs in real time ends the search. A GPU that works but is
    // slow does not: on some phones the CPU path is the faster one, so it is
    // measured too and the faster MEASURED backend is kept.
    if (best && aiIsRealtime(best.mode)) break;
  }
  if (best) {
    return {
      ...facts,
      aiRuntimeAvailable: true,
      aiBackend: best.backend,
      aiModelLoaded: true,
      aiLoadMs: best.loadMs,
      aiWarmupMs: best.warmupMs,
      aiAverageInferenceMs: best.averageMs,
      aiP95InferenceMs: best.p95Ms,
      aiFpsEstimate: best.fpsEstimate,
      aiMode: best.mode
    };
  }
  return { ...facts, aiMode: 'ai-none', aiError: last?.error || classifyAiError(null) };
}
