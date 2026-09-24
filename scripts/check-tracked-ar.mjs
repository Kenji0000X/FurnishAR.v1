/**
 * The tracked-AR frame loop, driven by a fake WebXR device in a real browser.
 *
 * CI has no phone. What it can check is everything the engine does with
 * what a phone hands it, frame by frame:
 *
 *   - ONE session request per tap: hit-test required, local-floor /
 *     dom-overlay optional, depth-sensing never (the old ladder asked five
 *     times, depth first, from one tap);
 *   - local-floor is used when granted;
 *   - the reticle judges the CURRENT hit: a steady wall is not a floor, a
 *     steady hit with no orientation is uncertain, a jittering floor is
 *     "hold still", a steady floor is valid — and a plane somewhere else is
 *     not evidence;
 *   - nothing is captured until the target is valid, and a capture is the
 *     window's robust point: one wild frame on the tap does not move it;
 *   - a refused session is reported as a refusal, the room is handed to
 *     Measure without AR, and the NEXT tap makes one minimal request.
 *
 * Runs the floor-area path, whose loop draws nothing with three.js, so the
 * fake device only has to be a WebXR device, not a GPU.
 *
 *   node scripts/check-tracked-ar.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-capture']
});
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

function installFakeXR({ refuse = 0 } = {}) {
  return ({ refuse }) => {
    const log = { requests: [], spaces: [], frames: 0 };
    window.__xr = log;
    // What the camera is pointed at right now. Changed by the check.
    window.__hit = { x: 0.5, y: -1.4, z: -1.2, normal: 'up', jitter: 0.002, spike: null };
    window.XRWebGLLayer = class { constructor() { this.framebuffer = null; } getViewport() { return { x: 0, y: 0, width: 1, height: 1 }; } };
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      if (proto) proto.makeXRCompatible = function () { return Promise.resolve(); };
    }
    const orientationFor = normal => {
      if (normal === 'wall') { const s = Math.SQRT1_2; return { x: s, y: 0, z: 0, w: s }; }   // +Y becomes +Z
      return { x: 0, y: 0, z: 0, w: 1 };                                                      // +Y up
    };
    let n = 0;
    const rnd = () => { n = (n * 16807 + 11) % 2147483647; return n / 2147483647 - 0.5; };
    class Session {
      constructor(features) { this.enabledFeatures = features; this.listeners = {}; this.ended = false; }
      updateRenderState() {}
      requestReferenceSpace(kind) { log.spaces.push(kind); return Promise.resolve({ kind }); }
      requestHitTestSource() { return Promise.resolve({ fake: true }); }
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
      removeEventListener() {}
      end() { this.ended = true; (this.listeners.end || []).forEach(fn => fn()); return Promise.resolve(); }
      requestAnimationFrame(cb) {
        if (this.ended) return 0;
        return setTimeout(() => {
          log.frames += 1;
          const h = window.__hit;
          const frame = {
            getViewerPose: () => ({ transform: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, views: [] }),
            getHitTestResults: () => {
              if (!h) return [];
              let p = { x: h.x + rnd() * 2 * h.jitter, y: h.y + rnd() * 2 * h.jitter, z: h.z + rnd() * 2 * h.jitter };
              if (h.spike) { p = { ...h.spike }; h.spike = null; }
              const q = orientationFor(h.normal);
              const pose = h.normal === 'none'
                ? { transform: { position: p, orientation: { x: NaN, y: NaN, z: NaN, w: NaN }, matrix: new Float32Array(16) } }
                : { transform: { position: p, orientation: q, matrix: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, p.x,p.y,p.z,1]) } };
              return [{ getPose: () => pose }];
            },
            detectedPlanes: undefined
          };
          cb(performance.now(), frame);
        }, 30);
      }
    }
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      isSessionSupported: () => Promise.resolve(true),
      requestSession: (_mode, init) => {
        log.requests.push(JSON.parse(JSON.stringify({ ...init, domOverlay: init.domOverlay ? { root: 'element' } : undefined })));
        if (log.requests.length <= refuse) {
          return Promise.reject(new DOMException('The specified session configuration is not supported.', 'NotSupportedError'));
        }
        const s = new Session(['hit-test', 'local-floor', ...(init.optionalFeatures || []).filter(f => f !== 'plane-detection')]);
        window.__session = s;
        return Promise.resolve(s);
      }
    } });
  };
}

async function openPlanner(options) {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(installFakeXR(options), options);
  await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mode-option[data-measure-mode="area"]', { timeout: 20000 });
  await page.click('.mode-option[data-measure-mode="area"]');
  return { page, errors, context };
}

const reticle = page => page.locator('#ar-reticle').getAttribute('data-state');
const setHit = (page, hit) => page.evaluate(h => { Object.assign(window.__hit, h); }, hit);

console.log('--- a tracked session on a phone with hit-test only (no planes, no depth) ---');
{
  const { page, errors, context } = await openPlanner({ refuse: 0 });
  await page.click('#ar-button');
  await page.waitForSelector('#ar-experience', { timeout: 10000 });
  await page.waitForTimeout(1200);
  const xr = await page.evaluate(() => window.__xr);
  check('one tap, one session request', xr.requests.length === 1, `${xr.requests.length}`);
  const init = xr.requests[0];
  check('hit-test is the only requirement', JSON.stringify(init.requiredFeatures) === '["hit-test"]', JSON.stringify(init.requiredFeatures));
  check('depth-sensing is never requested', !(init.optionalFeatures || []).includes('depth-sensing') && !init.depthSensing, JSON.stringify(init));
  check('local-floor is preferred for room geometry', xr.spaces.includes('local-floor'), xr.spaces.join(', '));
  check('frames run', xr.frames > 10, `${xr.frames}`);

  check('a steady floor is a valid target', await reticle(page) === 'valid', await reticle(page));
  check('the tracking chip says the floor was found', /Floor found/.test(await page.locator('#ar-mode-indicator').textContent()));
  check('the capture button is enabled', !(await page.locator('#place-button').isDisabled()));
  check('and labelled with its action', (await page.locator('#place-button').getAttribute('aria-label')) === 'Add point');

  await setHit(page, { normal: 'wall', x: 0, y: -0.5, z: -2 });
  await page.waitForTimeout(900);
  check('a steady WALL is not a floor', await reticle(page) === 'invalid', await reticle(page));
  check('and nothing can be captured on it', await page.locator('#place-button').isDisabled());
  check('the reason is one short line', /flat floor/i.test(await page.locator('#ar-mode-label').textContent()),
    await page.locator('#ar-mode-label').textContent());
  const overlay = await page.evaluate(() => {
    // No large tinted layer over the camera: only the reticle carries the verdict.
    const big = [...document.querySelectorAll('#ar-experience *')].filter(el => {
      const r = el.getBoundingClientRect();
      const bg = getComputedStyle(el).backgroundColor;
      return r.width * r.height > window.innerWidth * window.innerHeight * 0.25 && /rgba?\((2[0-9]{2}), ?(1[0-4][0-9]|[0-9]{1,2}), ?/.test(bg);
    });
    return big.map(el => el.id || el.className);
  });
  check('the camera is not painted red', overlay.length === 0, overlay.join(', '));

  await setHit(page, { normal: 'none', x: 0.5, y: -1.4, z: -1.2 });
  await page.waitForTimeout(900);
  check('a steady hit with no orientation is UNCERTAIN, not flat', await reticle(page) === 'uncertain', await reticle(page));

  await setHit(page, { normal: 'up', jitter: 0.12 });
  await page.waitForTimeout(900);
  check('a jittering floor is "hold still"', await reticle(page) === 'uncertain' && /Hold still/.test(await page.locator('#ar-mode-label').textContent()),
    await page.locator('#ar-mode-label').textContent());

  await setHit(page, { normal: 'up', jitter: 0.002, x: 1, y: -1.4, z: -1 });
  await page.waitForTimeout(900);
  // One wild frame right on the tap: 60 cm off.
  await setHit(page, { spike: { x: 1.6, y: -1.4, z: -1 } });
  await page.click('#place-button');
  await page.waitForTimeout(200);
  const corners = await page.locator('#live-cm').textContent();
  check('the capture was taken', /1 corner/.test(corners), corners);

  await setHit(page, { x: 3, y: -1.4, z: -1 });
  await page.waitForTimeout(900);
  await page.click('#place-button');
  await setHit(page, { x: 3, y: -1.4, z: -3 });
  await page.waitForTimeout(900);
  await page.click('#place-button');
  await page.waitForTimeout(200);
  const area = await page.locator('#live-m').textContent();
  // Triangle (1,-1) (3,-1) (3,-3): 2.00 m². A capture moved by the spike would read about 1.4 m².
  check('the corner was the window median, not the wild frame', /2\.0\d? m²|2 m²/.test(area), area);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

console.log('--- a session the browser refuses (advertised, then refused) ---');
{
  const { page, errors, context } = await openPlanner({ refuse: 1 });
  let opened = false;
  page.on('dialog', d => d.dismiss());
  await page.evaluate(() => window.addEventListener('furnishar:measure-without-ar', () => { window.__handedOver = true; }));
  await page.click('#ar-button');
  await page.waitForTimeout(1500);
  const xr = await page.evaluate(() => window.__xr);
  check('the refusal made exactly one request', xr.requests.length === 1, `${xr.requests.length}`);
  const status = await page.locator('#ar-status').textContent();
  check('it says the session did not start, not that the phone cannot', /The AR session did not start/.test(status) && !/does not support AR/i.test(status), status.slice(0, 140));
  check('it links the device check', await page.locator('#ar-status a[href="/diagnose"]').count() === 1);
  check('no untracked camera pretends to measure the room', await page.locator('#ar-experience').count() === 0);
  check('Measure without AR is offered in the same line', /Measure without AR/.test(status));
  check('the button offers a retry', /Try tracked AR again/.test(await page.locator('#ar-button').textContent()));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.querySelector('.ms-close')?.click(); });
  await page.waitForTimeout(300);
  await page.click('#ar-button');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => window.__xr);
  check('the retry is a second tap with the minimal request', after.requests.length === 2
    && JSON.stringify(after.requests[1]) === '{"requiredFeatures":["hit-test"]}', JSON.stringify(after.requests[1]));
  check('and the minimal session opens', await page.locator('#ar-experience').count() === 1);
  opened = true;
  check('no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

console.log('--- Messenger\'s in-app browser ---');
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 800 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Infinix X6728 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/480.0.0.0;]'
  });
  const page = await context.newPage();
  await page.addInitScript(installFakeXR({}), { refuse: 0 });
  await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ar-button', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const status = await page.locator('#ar-status').textContent();
  check('the planner says to open the page in the browser', /Open FurnishAR in your browser for camera tracking/.test(status), status.slice(0, 120));
  check('with an Open in Chrome link', await page.locator('#ar-status a.inapp-handoff').count() === 1);
  await page.click('#ar-button');
  await page.waitForTimeout(800);
  const xr = await page.evaluate(() => window.__xr);
  check('and no AR session is attempted', xr.requests.length === 0);
  await context.close();
}

console.log('--- one size, everywhere it is written ---');
{
  // No WebXR here, so placement opens the untracked preview, which still
  // carries the header and the chip.
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, permissions: ['camera'] });
  const page = await context.newPage();
  await page.goto(`${BASE}/collection`, { waitUntil: 'domcontentloaded' });
  const href = await page.locator('a[href^="/furniture/"]').first().getAttribute('href');
  const slug = href.split('/').pop();
  await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
  const productSize = (await page.locator('.detail-specs div:has(dt:text-is("Size")) dd').textContent()).replace(/\s*W × D × H\s*$/, '').trim();
  await page.goto(`${BASE}/plan?product=${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.planner-choice', { timeout: 20000 });
  const card = await page.locator('.planner-choice small').last().textContent();
  await page.goto(`${BASE}/plan?product=${slug}&ar=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ar-product-dims', { timeout: 20000 });
  await page.waitForTimeout(6000);
  const header = await page.locator('#ar-product-dims').textContent();
  const chip = await page.locator('#anchor-primary').textContent().catch(() => '');
  const mode = await page.locator('#ar-mode-indicator').textContent();
  check('the product page states a size', /^\d[\d.]* × \d[\d.]* × \d[\d.]* cm$/.test(productSize), productSize);
  check('the planner card states the same size', card.includes(productSize), card);
  check('the AR header states the same size', header === productSize, header);
  check('the chip over the model states the same size', !chip || chip === productSize, chip);
  check('the untracked preview is labelled as such', /Untracked preview/.test(mode), mode);
  const hint = await page.locator('#ar-mode-label').textContent();
  check('and does not claim true scale or placement', /not anchored/.test(hint) && !/true scale|Placed/.test(hint), hint);
  check('there is no Place step in it', await page.locator('#place-button').isHidden());
  await context.close();
}

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe tracked AR loop judges the current hit and captures only steady floor points');
process.exit(problems.length ? 1 : 0);
