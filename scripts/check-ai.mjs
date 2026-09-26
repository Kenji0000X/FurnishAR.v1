/**
 * The on-device AI check, in a real browser.
 *
 *   1. Browsing (home, collection, a product, the portal) and simply opening
 *      /diagnose download NOTHING of the AI: no /ort/ runtime, no /ai/ model,
 *      and no Next.js chunk contains ONNX Runtime.
 *   2. "Check AI camera capability" loads the runtime and the model from our
 *      own origin, times real inferences, and records backend, warm-up,
 *      average, p95 and a level — with no page errors.
 *   3. Without a GPU adapter, WASM is used and the report says why WebGPU
 *      was not.
 *   4. A model that cannot be downloaded is reported as "Unavailable" with a
 *      plain sentence (no ONNX exception text), and the rest of the page and
 *      the recommendation keep working.
 *   5. Scene quality is judged from real camera frames (Chromium's fake
 *      camera), floor/wall confidence stays null without a trained model,
 *      and nothing is uploaded.
 *
 *   BASE_URL=http://localhost:4173 node scripts/check-ai.mjs   (after npm run build && npm start)
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || process.argv[2] || 'http://localhost:4173';
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const isAi = url => /\/ort\/|\/ai\/[^/]+\.onnx/.test(url);
const rowText = (page, label) => page.locator(`.diag-row:has(.diag-q:text-is("${label}")) .diag-a`).textContent().catch(() => '');

try {
  console.log('--- browsing never downloads the AI ---');
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const aiRequests = [];
    const scripts = new Set();
    page.on('request', request => {
      if (isAi(request.url())) aiRequests.push(request.url());
      if (request.resourceType() === 'script') scripts.add(request.url());
    });
    for (const path of ['/', '/collection', '/portal', '/diagnose']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
    }
    check('home, collection, portal and the device check request no runtime or model', aiRequests.length === 0, aiRequests.slice(0, 3).join(', '));
    let bundled = [];
    for (const url of scripts) {
      if (!url.startsWith(BASE)) continue;
      const text = await (await fetch(url)).text().catch(() => '');
      if (/InferenceSession|onnxruntime|ort-wasm-simd/.test(text)) bundled.push(url.replace(BASE, ''));
    }
    check('no Next.js chunk loaded while browsing contains ONNX Runtime', bundled.length === 0, bundled.join(', '));
    await page.close();
  }

  console.log('--- the AI check, on a phone without a GPU adapter ---');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    // Headless Chromium has no usable GPU; make that explicit so the path is deterministic.
    await page.addInitScript(() => {
      if (navigator.gpu) navigator.gpu.requestAdapter = async () => null;
    });
    const errors = [];
    const aiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (isAi(request.url())) aiRequests.push(request.url().replace(BASE, '')); });
    await page.goto(`${BASE}/diagnose`, { waitUntil: 'networkidle' });
    check('the AI row starts as "Not tested"', /Not tested/.test(await rowText(page, 'AI vision')), await rowText(page, 'AI vision'));
    check('nothing AI was fetched before the tap', aiRequests.length === 0);
    const started = Date.now();
    await page.click('button:has-text("Check AI camera capability")');
    await page.waitForFunction(() => !/Not tested/.test(document.querySelector('.diag-row:last-child')?.textContent || '')
      && !document.querySelector('button[aria-busy="true"]'), null, { timeout: 180000 }).catch(() => {});
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const ai = await rowText(page, 'AI vision');
    const report = JSON.parse(await page.locator('.diag-report').textContent());
    console.log(`  (measured in headless Chromium, this server: backend ${report.aiBackend}, load ${report.aiLoadMs} ms, warm-up ${report.aiWarmupMs} ms, average ${report.aiAverageInferenceMs} ms, p95 ${report.aiP95InferenceMs} ms, ~${report.aiFpsEstimate} fps, mode ${report.aiMode}; check took ${seconds} s)`);
    check('the runtime was fetched from our own origin, after the tap', aiRequests.some(u => /^\/ort\/ort\.wasm\.min\.mjs/.test(u)) && aiRequests.some(u => /\.wasm$/.test(u)), aiRequests.join(', '));
    check('only the WASM build was downloaded (no GPU, no GPU build)', !aiRequests.some(u => /asyncify|webgpu/.test(u)), aiRequests.join(', '));
    check('the test model was fetched', aiRequests.some(u => /\/ai\/furnishar-bench-v1\.onnx$/.test(u)));
    check('the backend is WASM, and the report says why not WebGPU',
      report.aiBackend === 'wasm' && (report.aiBackendsTried || []).some(t => t.backend === 'webgpu' && t.ok === false),
      JSON.stringify(report.aiBackendsTried));
    check('it measured real inferences: warm-up, average, p95, fps',
      report.aiModelLoaded === true && report.aiP95InferenceMs > 0 && report.aiAverageInferenceMs > 0 && report.aiWarmupMs >= 0 && report.aiFpsEstimate > 0);
    check('the level is one of the defined levels', ['ai-none', 'ai-single-frame', 'ai-realtime', 'ai-gpu'].includes(report.aiMode), report.aiMode);
    check('the AI row names the result in words, not a percentage', /Available|Unavailable/.test(ai) && !/%/.test(ai), ai);
    check('the report carries no hardware identifiers', !/imei|serial|iccid|meid|mac.?address/i.test(JSON.stringify(report)));
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await context.close();
  }

  console.log('--- the model cannot be downloaded ---');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.addInitScript(() => { if (navigator.gpu) navigator.gpu.requestAdapter = async () => null; });
    await page.route('**/ai/*.onnx', route => route.fulfill({ status: 404, body: 'gone' }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE}/diagnose`, { waitUntil: 'networkidle' });
    await page.click('button:has-text("Check AI camera capability")');
    await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'), null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(300);
    const ai = await rowText(page, 'AI vision');
    check('it says Unavailable, and why, in a plain sentence', /Unavailable/.test(ai) && /could not be downloaded/.test(ai), ai);
    check('no ONNX Runtime error text reaches the page', !/ort\.|onnx|wasm|ERR_|backend not found/i.test(await page.locator('.diag-list').textContent()));
    const summary = await page.locator('.diag-summary').textContent();
    check('the recommendation still stands', /Recommended FurnishAR mode/.test(summary), summary.slice(0, 80));
    check('the other checks still work', await page.locator('button:has-text("Check the camera and motion sensors")').isEnabled());
    check('and it can be tried again', await page.locator('button:has-text("Check AI camera capability again")').count() === 1);
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await context.close();
  }

  console.log('--- scene quality from real camera frames (Chromium\'s fake camera) ---');
  {
    const camBrowser = await chromium.launch({
      executablePath: '/opt/pw-browsers/chromium',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
    });
    const context = await camBrowser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
    const page = await context.newPage();
    const errors = [];
    const outbound = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') outbound.push(`${request.method()} ${request.url()}`); });
    await page.addInitScript(() => {
      let alpha = 0;
      setInterval(() => {
        alpha = (alpha + 1) % 360;
        window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha, beta: 60, gamma: 0, absolute: false }));
      }, 30);
    });
    await page.goto(`${BASE}/diagnose`, { waitUntil: 'networkidle' });
    await page.click('button:has-text("Check the camera and motion sensors")');
    await page.waitForFunction(() => !/Checking/.test(document.body.textContent), null, { timeout: 20000 }).catch(() => {});
    const scene = await rowText(page, 'Scene');
    const report = JSON.parse(await page.locator('.diag-report').textContent());
    check('the scene row reports what the frames showed', /Available|Needs attention/.test(scene) && !/Not tested/.test(scene), scene);
    check('the report has the scene verdicts', ['good', 'dark', 'overexposed'].includes(report.lightingQuality)
      && ['sharp', 'blurred'].includes(report.motionBlur) && ['good', 'featureless'].includes(report.sceneTextureQuality),
      JSON.stringify({ l: report.lightingQuality, b: report.motionBlur, t: report.sceneTextureQuality, m: report.cameraMotion }));
    check('floor and wall confidence stay "not tested" without a trained model',
      !('floorConfidence' in report && report.floorConfidence !== null) && !('wallConfidence' in report && report.wallConfidence !== null));
    check('no frame was sent anywhere (no POST, PUT or other upload)', outbound.length === 0, outbound.slice(0, 2).join(', '));
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await camBrowser.close();
  }
} finally {
  await browser.close();
}

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe AI check loads only when asked, measures real inferences, and fails soft');
process.exit(problems.length ? 1 : 0);
