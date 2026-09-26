/**
 * Drives /diagnose against fake devices, in a real browser.
 *
 * Nothing here can test a phone's camera. What it can test is the page's
 * contract with the WebXR API and with the person reading it:
 *
 *   - frames are only requested once a base layer is set (the spec's rule;
 *     the page once broke it and reported defaults as findings);
 *   - ONE session request per tap, the same minimal request the planner
 *     makes: hit-test required, depth never. The old page walked five
 *     configurations from one tap and read every later refusal — made
 *     without the tap's user activation — as a missing feature;
 *   - a refusal is reported as a refusal: what was observed, possible
 *     causes as possible, what to do. Never "Google Play Services for AR is
 *     missing" as a fact;
 *   - a simpler request is offered only as a second, separate tap;
 *   - Messenger's browser is told to open the page elsewhere, before any AR;
 *   - sensors are counted from real readings, and the report carries no
 *     hardware identifiers.
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

/** A fake WebXR device. `behaviour` decides what requestSession does. */
function fakeXR(behaviour) {
  return ({ behaviour }) => {
    const log = { rafBeforeLayer: 0, rafAfterLayer: 0, layerSet: false, requests: [], overlayRoot: null };
    window.__fakeXR = log;
    window.XRWebGLLayer = class { constructor(session, gl) { this.session = session; this.context = gl; } };
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      if (proto) proto.makeXRCompatible = function () { return Promise.resolve(); };
    }
    const makeFrame = session => ({
      detectedPlanes: new Set(),                     // no planes: like the Infinix
      getHitTestResults: () => (behaviour === 'no-hits' ? [] : [{}]),
      getViewerPose: () => ({ views: [] }),
      session
    });
    class FakeSession {
      constructor(features) { this.enabledFeatures = features; this.hasLayer = false; this.ended = false; }
      updateRenderState(state) { if (state?.baseLayer) { this.hasLayer = true; log.layerSet = true; } }
      requestAnimationFrame(cb) {
        if (!this.hasLayer) { log.rafBeforeLayer += 1; return 0; }
        log.rafAfterLayer += 1;
        if (this.ended) return 0;
        return setTimeout(() => cb(performance.now(), makeFrame(this)), 16);
      }
      requestReferenceSpace(kind) { return Promise.resolve({ kind }); }
      requestHitTestSource() { return Promise.resolve({ fake: true }); }
      end() { this.ended = true; return Promise.resolve(); }
      addEventListener() {}
      removeEventListener() {}
    }
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      isSessionSupported: mode => Promise.resolve(mode === 'immersive-ar'),
      requestSession: (mode, init) => {
        log.requests.push(init || {});
        if (init?.domOverlay?.root) log.overlayRoot = init.domOverlay.root.className || 'unnamed';
        if (behaviour === 'refuse' || (behaviour === 'refuse-first' && log.requests.length === 1)) {
          return Promise.reject(new DOMException('The specified session configuration is not supported.', 'NotSupportedError'));
        }
        // Planes and depth are NOT granted, like the tested Infinix HOT 60i.
        return Promise.resolve(new FakeSession(['hit-test', 'local-floor', 'dom-overlay']));
      }
    } });
  };
}

async function open(behaviour, { userAgent } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, ...(userAgent ? { userAgent } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeXR(behaviour), { behaviour });
  await page.goto(`${BASE}/diagnose`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.diag-row', { timeout: 15000 });
  return { page, errors, context };
}

const rowText = async (page, label) => page.locator(`.diag-row:has(.diag-q:text-is("${label}")) .diag-a`).textContent().catch(() => '');

console.log('--- a phone that tracks and finds the floor, with no planes and no depth ---');
{
  const { page, errors, context } = await open('works');
  check('it reads as a health check, with the nine rows', await page.locator('.diag-row').count() === 9);
  check('before the check, tracked AR is "not tested", not "yes"',
    /Not tested/.test(await rowText(page, 'Tracked AR')), await rowText(page, 'Tracked AR'));
  await page.click('button:has-text("Run the AR check")');
  await page.waitForFunction(() => /Available/.test(document.querySelector('.diag-row')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  const fake = await page.evaluate(() => window.__fakeXR);
  check('one tap, one session request', fake.requests.length === 1, `${fake.requests.length} requests`);
  check('hit-test required, depth never asked for',
    JSON.stringify(fake.requests[0].requiredFeatures) === '["hit-test"]' && !('depthSensing' in fake.requests[0])
    && !(fake.requests[0].optionalFeatures || []).includes('depth-sensing'), JSON.stringify(fake.requests[0]));
  check('frames only after a base layer', fake.layerSet && fake.rafBeforeLayer === 0 && fake.rafAfterLayer > 10,
    `${fake.rafAfterLayer} frames, ${fake.rafBeforeLayer} before the layer`);
  check('dom-overlay is asked for with a real root', fake.overlayRoot !== null);
  check('tracked AR: available', /Available/.test(await rowText(page, 'Tracked AR')), await rowText(page, 'Tracked AR'));
  check('hit testing: available', /Available/.test(await rowText(page, 'Hit testing')));
  check('floor tracking: found, with the frame count', /Available.*surface was found in \d+ of \d+ frames/.test(await rowText(page, 'Floor tracking')),
    await rowText(page, 'Floor tracking'));
  const summary = await page.locator('.diag-summary').textContent();
  check('the summary says tracked AR works', /Tracked AR works on this phone/.test(summary), summary.slice(0, 80));
  check('recommended mode: tracked AR', /Recommended FurnishAR mode\s*Tracked AR/.test(summary));
  await page.click('.diag-ua summary');
  const report = await page.locator('.diag-report').textContent();
  check('the technical report has the session facts', /"hitFrames": \d+/.test(report) && /"sessionFeatures"/.test(report));
  check('and no private identifiers', !/imei|serial|iccid|meid|mac/i.test(report));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

console.log('--- a phone that says yes and then refuses the session (TECNO / vivo class) ---');
{
  const { page, errors, context } = await open('refuse-first');
  await page.click('button:has-text("Run the AR check")');
  await page.waitForSelector('button:has-text("Try a simpler AR session")', { timeout: 15000 }).catch(() => {});
  let fake = await page.evaluate(() => window.__fakeXR);
  check('still one request per tap after a refusal', fake.requests.length === 1, `${fake.requests.length} requests`);
  const summary = await page.locator('.diag-summary').textContent();
  check('it reports a refused session, not a verdict on the phone', /The AR session did not start/.test(summary), summary.slice(0, 90));
  check('Play Services is a POSSIBLE cause, not a stated fact',
    /Possible causes/.test(summary) && /Which one is not known/.test(summary), summary.slice(0, 400));
  check('it never says the phone does not support AR', !/does not support AR|not good enough/i.test(summary));
  check('photo and tape are still offered',
    /Tape measure/.test(await page.locator('.diag-methods').textContent().catch(() => '')));
  await page.click('button:has-text("Try a simpler AR session")');
  await page.waitForFunction(() => window.__fakeXR.requests.length === 2, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(7500);
  fake = await page.evaluate(() => window.__fakeXR);
  check('the simpler session is a second tap, and minimal', fake.requests.length === 2
    && JSON.stringify(fake.requests[1]) === '{"requiredFeatures":["hit-test"]}', JSON.stringify(fake.requests[1]));
  check('and when it opens, tracked AR is confirmed', /Available/.test(await rowText(page, 'Tracked AR')), await rowText(page, 'Tracked AR'));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

console.log('--- a session that opens but never finds a surface ---');
{
  const { page, context } = await open('no-hits');
  await page.click('button:has-text("Run the AR check")');
  await page.waitForTimeout(8000);
  check('floor tracking needs attention, not "unavailable"', /Needs attention/.test(await rowText(page, 'Floor tracking')), await rowText(page, 'Floor tracking'));
  const summary = await page.locator('.diag-summary').textContent();
  check('it blames the conditions, not the phone', /no surface found yet/i.test(summary) && /light/.test(summary), summary.slice(0, 160));
  await context.close();
}

console.log('--- Messenger\'s in-app browser ---');
{
  const ua = 'Mozilla/5.0 (Linux; Android 14; Infinix X6728 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/480.0.0.0;]';
  const { page, context } = await open('works', { userAgent: ua });
  const callout = await page.locator('.diag-callout').textContent().catch(() => '');
  check('it says to open FurnishAR in the browser', /Open FurnishAR in your browser for camera tracking/.test(callout), callout.slice(0, 80));
  check('and that this says nothing about the phone', /nothing about your phone/.test(callout));
  const href = await page.locator('.diag-callout a').getAttribute('href').catch(() => '');
  check('with an Open in Chrome hand-off', /^intent:\/\/.*package=com\.android\.chrome/.test(href || ''), href);
  check('and no AR check is attempted in the webview', await page.locator('button:has-text("Run the AR check")').count() === 0);
  const fake = await page.evaluate(() => window.__fakeXR);
  check('not a single session was requested', fake.requests.length === 0);
  await context.close();
}

console.log('--- camera and motion sensors ---');
{
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.resolve({
      getVideoTracks: () => [{ getSettings: () => ({ width: 1920, height: 1080 }) }],
      getTracks: () => [{ stop() {} }]
    });
    let alpha = 0;
    setInterval(() => {
      alpha = (alpha + 1.5) % 360;   // turning slowly
      window.dispatchEvent(Object.assign(new Event('deviceorientation'), { alpha, beta: 70, gamma: 0, absolute: false }));
    }, 30);
  });
  await page.goto(`${BASE}/diagnose`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.diag-row');
  await page.click('button:has-text("Check the camera and motion sensors")');
  await page.waitForFunction(() => !/Checking/.test(document.body.textContent), null, { timeout: 12000 }).catch(() => {});
  check('the camera row gives the real resolution', /1920x1080/.test(await rowText(page, 'Camera')), await rowText(page, 'Camera'));
  check('the motion row counts readings and their rate', /\d+ readings, about [\d.]+ per second/.test(await rowText(page, 'Motion sensor')), await rowText(page, 'Motion sensor'));
  check('heading quality is judged from the readings', /Available|Needs attention/.test(await rowText(page, 'Heading quality')), await rowText(page, 'Heading quality'));
  await context.close();
}

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe device check reports what it observed, and no more');
process.exit(problems.length ? 1 : 0);
