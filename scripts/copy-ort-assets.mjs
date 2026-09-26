/**
 * Copies ONNX Runtime Web's browser files into public/ort/, so the AI check
 * loads them from FurnishAR's own origin — never a CDN, and never through
 * the Next.js bundle (lib/spatial/ai/runtime.mjs imports them with
 * webpackIgnore, at runtime, only after a tap on /diagnose).
 *
 * Runs before `next build` and `next dev` (package.json pre-scripts). The
 * copies are generated, not source: public/ort/ is git-ignored, and the
 * version is whatever package.json pins.
 *
 * Only the two builds FurnishAR uses are copied:
 *   ort.wasm.min.mjs    + ort-wasm-simd-threaded.{mjs,wasm}            (CPU)
 *   ort.webgpu.min.mjs  + ort-wasm-simd-threaded.asyncify.{mjs,wasm}  (WebGPU)
 * A phone downloads one of the two, never both unless WebGPU fails first.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const TARGET = path.join(ROOT, 'public', 'ort');
const FILES = [
  'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
  'ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'
];

let version = 'unknown';
try { version = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8')).version; } catch {
  console.warn('[ort] onnxruntime-web is not installed; the AI check will report the runtime as unavailable.');
  process.exit(0);
}
mkdirSync(TARGET, { recursive: true });
let bytes = 0;
for (const file of FILES) {
  copyFileSync(path.join(SOURCE, file), path.join(TARGET, file));
  bytes += statSync(path.join(TARGET, file)).size;
}
console.log(`[ort] onnxruntime-web ${version}: ${FILES.length} files, ${(bytes / 1e6).toFixed(1)} MB copied to public/ort/`);
