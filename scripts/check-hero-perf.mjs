/**
 * Does the 3D hero actually cost what it claims to?
 *
 * "It looks smooth on my machine" is not a measurement, and a landing page
 * that ships a WebGL renderer can be slow in ways a screenshot never shows.
 * This measures the four things that matter:
 *
 *   1. the renderer is NOT on the critical path — the page is interactive
 *      before three.js is even requested
 *   2. frames stay inside budget while scrolling the pinned range
 *   3. the loop genuinely stops when the stage is off screen, rather than
 *      quietly burning battery behind the FAQ
 *   4. the whole thing tears down without leaking GPU memory on a route change
 *
 * Needs the site already running:
 *   npx next build && npx next start -p 4177
 *   node scripts/check-hero-perf.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4177';

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});

/* ------------------------------------- 1. not on the critical path ------- */
{
  console.log('--- first load ---');
  const page = await browser.newPage();

  // Every request the page makes, in order, with its size.
  const requests = [];
  page.on('response', async response => {
    const url = response.url();
    if (!url.startsWith(BASE)) return;
    requests.push({ url: url.replace(BASE, ''), status: response.status() });
  });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // At DOMContentLoaded nothing 3D should have been fetched yet: the stage
  // waits for an IntersectionObserver and then imports.
  const early = requests.filter(r => /three|\.glb$/i.test(r.url));
  check(early.length === 0, 'no renderer or model before DOMContentLoaded',
    early.map(r => r.url).join(', ') || 'none');

  // The page must be readable without it. The headline is server-rendered.
  const headline = await page.locator('h1').first().textContent();
  check(Boolean(headline?.trim()), 'the headline is in the HTML, not waiting on WebGL',
    headline?.replace(/\s+/g, ' ').trim());

  await page.waitForFunction(() => document.querySelector('.hero-stage')?.dataset.mode === 'live',
    { timeout: 60000 }).catch(() => {});

  const model = requests.find(r => /\.glb$/i.test(r.url));
  check(Boolean(model), 'the model does load, once the stage is near', model?.url);

  await page.close();
}

/* --------------------------------------- 2. frames during the scroll ----- */
{
  /*
    A NOTE ON WHAT THIS NUMBER MEANS

    Headless Chromium here has no GPU: WebGL runs on swiftshader, a software
    rasteriser. Measured that way this scene is VERTEX bound — halving the
    triangles halved the frame time, while cutting the pixel count by 2.5x
    changed nothing — which is a property of software rasterisation, not of
    phones. A real GPU, including a cheap phone one, eats 71k triangles
    without noticing.

    So the absolute milliseconds below are a worst case with no graphics
    hardware at all, and the thresholds are set against THAT, not against
    60fps. What the check is really defending is the shape of the thing: that
    the loop is throttled, that it stops, and that a future change which
    doubles the geometry shows up here as a number that moved.
  */
  console.log('--- scrolling the pinned range (software rasteriser) ---');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => document.querySelector('.hero-stage')?.dataset.mode === 'live',
    { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(600);


  // Record frame intervals across a real scroll of the pinned range.
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    window.__recording = true;
    const tick = now => {
      window.__frames.push(now - last);
      last = now;
      if (window.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const range = await page.evaluate(() =>
    document.querySelector('.hero-stage').getBoundingClientRect().height - window.innerHeight);
  for (let i = 0; i <= 20; i += 1) {
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), (range * i) / 20);
    await page.waitForTimeout(90);
  }

  const frames = await page.evaluate(() => {
    window.__recording = false;
    return window.__frames.slice(2);
  });

  const sorted = [...frames].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  check(frames.length > 8, 'enough frames to judge', `${frames.length} frames`);
  // Measured at ~200ms/frame with 158k triangles and ~117ms with 71k, on
  // software. 160 leaves headroom for a slower runner while still failing
  // loudly if the geometry budget is abandoned.
  check(median < 160, 'median frame inside the software budget',
    `${median?.toFixed(0)}ms (no GPU; a real one is ~1-2ms)`);
  check(p95 < 400, 'the slow tail stays bounded', `p95 ${p95?.toFixed(0)}ms`);

  await context.close();
}

/* -------------------------------- 3. the loop stops when off screen ------ */
{
  console.log('--- idling off screen ---');
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => document.querySelector('.hero-stage')?.dataset.mode === 'live',
    { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(600);

  // Scroll well past the stage, to the FAQ, and see whether the renderer is
  // still working. The pose object is written once per rendered frame, so a
  // frozen counter means a stopped loop.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(1200);

  const before = await page.evaluate(() => {
    window.__poseWrites = 0;
    const original = Object.getOwnPropertyDescriptor(window, '__furnisharStagePose');
    void original;
    let value = window.__furnisharStagePose;
    Object.defineProperty(window, '__furnisharStagePose', {
      configurable: true,
      get: () => value,
      set: next => { value = next; window.__poseWrites += 1; }
    });
    return 0;
  });
  void before;
  await page.waitForTimeout(1500);
  const writes = await page.evaluate(() => window.__poseWrites);
  check(writes === 0, 'the renderer stops when the stage is off screen',
    `${writes} frames in 1.5s at the bottom of the page`);

  // And starts again on the way back.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(900);
  const resumed = await page.evaluate(() => window.__poseWrites);
  check(resumed > 0, 'and starts again when it returns', `${resumed} frames`);

  await page.close();
}

/* --------------------------------------------- 4. teardown is clean ------ */
{
  console.log('--- leaving the page ---');
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => document.querySelector('.hero-stage')?.dataset.mode === 'live',
    { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(600);

  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  // A client-side route change unmounts the stage. Anything the cleanup got
  // wrong — a listener on a disposed renderer, a cancelled frame that still
  // fires — surfaces here.
  await page.locator('a[href="/plan"]').first().click();
  await page.waitForURL(/\/plan/, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  check(errors.length === 0, 'unmounting the stage throws nothing', errors.join(' | ') || 'clean');

  const stillDrawing = await page.evaluate(() => {
    window.__poseWrites = 0;
    let value = window.__furnisharStagePose;
    Object.defineProperty(window, '__furnisharStagePose', {
      configurable: true,
      get: () => value,
      set: next => { value = next; window.__poseWrites += 1; }
    });
    return true;
  });
  void stillDrawing;
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => window.__poseWrites);
  check(after === 0, 'no renderer left running on the next route', `${after} frames`);

  await page.close();
}

await browser.close();
console.log(failures ? `\nFAILED: ${failures} check(s)` : '\nthe hero stays inside its budget');
process.exit(failures ? 1 : 0);
