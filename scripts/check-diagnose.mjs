/**
 * Drives /diagnose against a fake AR device, in a real browser.
 *
 * There is no way to test this page honestly on a laptop: it asks a phone
 * questions only a phone can answer. But the bug it had was not about phones.
 * The page never set a base layer on its XRSession, and an XRSession with no
 * base layer never calls a requestAnimationFrame callback — so the six-second
 * loop that watches for planes, depth and hit-test results simply did not run,
 * and the page printed the initial values ('no', 'no', 0) as if they were
 * findings. It told people their phone could not measure a room without ever
 * having looked.
 *
 * That behaviour IS reproducible on a laptop, because it is a property of the
 * API contract rather than of the hardware. So this installs a fake
 * navigator.xr whose one strict rule is the real one:
 *
 *     requestAnimationFrame does nothing until updateRenderState has been
 *     given a baseLayer.
 *
 * Against the old page the fake device runs zero frames. Against the fixed
 * page it runs many. Run it with the old file restored and every assertion
 * below fails — which is the only reason to trust them.
 *
 *   node scripts/check-diagnose.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4173';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

await page.addInitScript(() => {
  // Counts the page's behaviour, read back at the end.
  const log = { rafBeforeLayer: 0, rafAfterLayer: 0, layerSet: false, configs: [], overlayRoot: null };
  window.__fakeXR = log;

  class FakeXRWebGLLayer {
    constructor(session, gl) { this.session = session; this.context = gl; }
  }
  window.XRWebGLLayer = FakeXRWebGLLayer;

  /* The page legitimately awaits gl.makeXRCompatible(). Chromium ships it,
     but with no XR device attached it rejects with InvalidStateError, which
     would abort the run before the base layer is ever set — a failure of the
     fake rig, not of the page. On the fake device it resolves, as it does on
     a phone that is about to enter AR. */
  for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
    if (proto) proto.makeXRCompatible = function () { return Promise.resolve(); };
  }

  const makeFrame = session => ({
    // Three planes and a hit every frame: a phone that can see the room.
    detectedPlanes: new Set([{}, {}, {}]),
    getHitTestResults: () => [{}],
    getViewerPose: () => ({ views: [] }),
    session
  });

  class FakeSession {
    constructor(features) {
      this.enabledFeatures = features;
      this.hasLayer = false;
      this.ended = false;
    }
    updateRenderState(state) {
      // The rule the page was breaking.
      if (state?.baseLayer) { this.hasLayer = true; log.layerSet = true; }
    }
    requestAnimationFrame(cb) {
      if (!this.hasLayer) { log.rafBeforeLayer += 1; return 0; }   // dropped, exactly as the spec says
      log.rafAfterLayer += 1;
      if (this.ended) return 0;
      return setTimeout(() => cb(performance.now(), makeFrame(this)), 16);
    }
    requestReferenceSpace(kind) {
      if (kind === 'local' || kind === 'viewer' || kind === 'local-floor') return Promise.resolve({ kind });
      return Promise.reject(new DOMException('no such space', 'NotSupportedError'));
    }
    requestHitTestSource() { return Promise.resolve({ fake: true }); }
    end() { this.ended = true; return Promise.resolve(); }
    addEventListener() {}
    removeEventListener() {}
  }

  /* Assigning navigator.xr silently does nothing: it is an accessor on
     Navigator.prototype with a getter and no setter, so in sloppy mode the
     write is discarded without an error and the page keeps talking to the
     real (absent) WebXR. Define an own property over it instead. */
  Object.defineProperty(navigator, 'xr', { configurable: true, value: {
    isSessionSupported: mode => Promise.resolve(mode === 'immersive-ar'),
    requestSession: (mode, init) => {
      log.configs.push(Object.keys(init || {}));
      // A phone that refuses the depth dict but accepts the next rung down —
      // the exact shape that made the scanner look broken.
      if (init?.depthSensing) {
        return Promise.reject(new DOMException(
          'The specified session configuration is not supported.', 'NotSupportedError'));
      }
      if (init?.domOverlay?.root) log.overlayRoot = init.domOverlay.root.className || 'unnamed';
      return Promise.resolve(new FakeSession(
        (init?.requiredFeatures || []).concat(init?.optionalFeatures || [])));
    }
  } });
});

console.log('--- the page loads and answers the cheap questions ---');
await page.goto(`${BASE}/diagnose`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.diag-row', { timeout: 10000 });
check('the basic checks ran', await page.locator('.diag-row').count() >= 5,
  `${await page.locator('.diag-row').count()} rows`);
check('and it offers the deep check when AR is available',
  await page.locator('.diag-deep button').isVisible());

console.log('--- the deep check, against a device that can see the room ---');
await page.click('.diag-deep button');
/* Six seconds of fake frames plus teardown. Tolerated rather than awaited:
   with the old page restored there is no verdict element at all, and a hard
   timeout here would crash the run instead of reporting which assertions the
   old code fails — which is the whole point of being able to run it. */
await page.waitForSelector('.diag-verdict', { timeout: 20000 })
  .catch(() => page.waitForTimeout(12000));

const fake = await page.evaluate(() => window.__fakeXR);

/* The heart of it. Frames must have been requested AFTER a base layer was
   set; any frame requested before one is a frame the real browser throws
   away. The old page had rafAfterLayer === 0 and layerSet === false. */
check('the page set a base layer on the session', fake.layerSet === true);
check('and only asked for frames once it had', fake.rafBeforeLayer === 0,
  `${fake.rafBeforeLayer} frame(s) requested with no layer`);
check('frames actually ran', fake.rafAfterLayer > 10, `${fake.rafAfterLayer} frames`);

/* The engine passes a DOM overlay root. A check that asks for 'dom-overlay'
   without one is asking a different question than the scanner asks, and can
   fail for a reason that has nothing to do with the phone. */
check('it asked for dom-overlay with a real root, like the scanner does',
  fake.overlayRoot !== null, fake.overlayRoot || 'no root passed');

console.log('--- what it reported ---');
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('.diag-row')].map(r => ({
    q: r.querySelector('.diag-q').textContent,
    a: r.querySelector('.diag-a b').textContent,
    d: r.querySelector('.diag-a small')?.textContent || ''
  })));
const row = needle => rows.find(r => r.q.toLowerCase().includes(needle));

for (const [needle, label] of [
  ['frames actually ran', 'frames'],
  ['hit-test', 'hit-test'],
  ['found a real surface', 'a real surface'],
  ['plane detection', 'planes']
]) {
  const r = row(needle);
  check(`it reports "${label}" as Yes`, r?.a === 'Yes', r ? `${r.a} — ${r.d}` : 'row missing');
}

const framesDetail = row('frames actually ran')?.d || '';
check('and says how many frames, so a zero-frame run is visible',
  /\d+ frames/.test(framesDetail), framesDetail);

const planes = row('plane detection');
check('plane count is a real count, not a default', /Planes seen: 3/.test(planes?.d || ''), planes?.d);

console.log('--- the headline verdict ---');
const verdict = await page.locator('.diag-verdict').textContent().catch(() => '');
check('it answers the question in one sentence', /Can this phone measure a room\?/.test(verdict));
check('and the answer is Yes for a device that found surfaces',
  /Yes\./.test(verdict), verdict.slice(0, 120));
check('the verdict is marked as good', await page.locator('.diag-verdict.is-ok').count() === 1);

console.log('--- the configuration ladder is reported honestly ---');
const config = row('session configuration');
check('it names the rung this device accepted', /no depth config/.test(config?.d || ''), config?.d);
check('and says the depth config was refused first', /refused first/.test(config?.d || ''), config?.d);
check('the first attempt really did carry a depth dict',
  fake.configs[0]?.includes('depthSensing'), JSON.stringify(fake.configs[0]));

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe device check actually checks the device');
process.exit(problems.length ? 1 : 0);
