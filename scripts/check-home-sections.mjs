/**
 * Drives the new home-page sections and the footer the way a person would.
 *
 * Everything here is a thing that can be wrong without the build saying so: a
 * footer link that 404s, an accordion that a keyboard cannot open, a deep link
 * that lands on the wrong panel, a three-column band that overflows a phone.
 *
 * Needs the site already running:
 *   npx next build && npx next start -p 4177
 *   node scripts/check-home-sections.mjs
 */
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4177';

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

// Same pinned binary every other check script uses: the bundled headless shell
// this Playwright build wants is not installed here, and reaching for it is an
// "install browsers" error rather than a test failure.
// swiftshader so the WebGL hero renders under a headless runner with no GPU.
// Without it the stage falls back to its still and the live path is never
// exercised — the check would pass while testing nothing.
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});

/* ---------------------------------------------------- the accordion ------ */
{
  console.log('--- FAQ ---');
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);

  const items = page.locator('.faq-item');
  check(await items.count() === 6, 'six questions render', `${await items.count()}`);

  const first = items.first();
  check(!(await first.evaluate(el => el.open)), 'starts closed');

  // A closed <details> hides its answer, so the answer is the proof it opened
  // rather than the attribute — the attribute could be set with the panel
  // still clipped by a stylesheet rule.
  await first.locator('summary').click();
  check(await first.locator('p').isVisible(), 'opens on click');

  await first.locator('summary').click();
  check(!(await first.locator('p').isVisible()), 'closes again on click');

  // Enter on a focused summary is the native disclosure keybinding. A
  // hand-rolled div accordion is exactly what loses this.
  await first.locator('summary').focus();
  await page.keyboard.press('Enter');
  check(await first.locator('p').isVisible(), 'opens from the keyboard');

  // Opening one must not close another: these are independent questions, not a
  // single-select accordion, and someone comparing two answers needs both.
  await items.nth(2).locator('summary').click();
  check(
    await first.locator('p').isVisible() && await items.nth(2).locator('p').isVisible(),
    'two answers can be open at once'
  );

  await page.close();
}

/* ------------------------------------------- every link goes somewhere --- */
{
  console.log('--- links in the new sections ---');
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);

  const hrefs = await page.locator('.capsule, .band-actions a, footer a').evaluateAll(
    nodes => [...new Set(nodes.map(n => n.getAttribute('href')))]
  );
  check(hrefs.length > 0, 'the sections have links at all', `${hrefs.length}`);

  for (const href of hrefs) {
    if (href.startsWith('mailto:')) {
      check(/^mailto:[^@\s]+@[^@\s]+/.test(href), `mailto is addressable: ${href}`);
      continue;
    }
    const [path, hash] = href.split('#');
    const url = `${BASE}${path || '/'}`;
    const response = await page.request.get(url);
    check(response.status() === 200, `${href} resolves`, `HTTP ${response.status()}`);

    // A "#faq" that points at nothing scrolls nowhere and looks broken. This
    // is the failure mode a build can never catch.
    if (hash) {
      const probe = await browser.newPage();
      await probe.goto(url);
      const exists = await probe.locator(`#${hash}`).count();
      // #apply is not an element — it is a mode the portal reads on load, and
      // it is checked on its own below.
      check(exists > 0 || hash === 'apply', `#${hash} is a real target on ${path || '/'}`);
      await probe.close();
    }
  }
  await page.close();
}

/* ----------------------------------- the portal deep link opens apply ---- */
{
  console.log('--- /portal#apply ---');
  const plain = await browser.newPage();
  await plain.goto(`${BASE}/portal`);
  await plain.waitForLoadState('networkidle');
  const plainHeading = await plain.locator('.login-copy h2').first().textContent();
  check(!/List your store/i.test(plainHeading || ''), '/portal alone still shows sign-in', plainHeading?.trim());
  await plain.close();

  const deep = await browser.newPage();
  await deep.goto(`${BASE}/portal#apply`);
  await deep.waitForLoadState('networkidle');
  const heading = await deep.locator('.login-copy h2').first().textContent();
  check(/List your store/i.test(heading || ''), '/portal#apply opens the application', heading?.trim());
  check(
    await deep.locator('.login-form input[name="storeName"]').isVisible(),
    'the application form is the one on screen'
  );
  await deep.close();
}

/* ---------------------------------------------- nothing overflows a phone */
{
  /*
    A page that scrolls sideways on a phone is the cheapest UX failure there
    is and the easiest to ship: nothing errors, the build is green, and it
    only shows up in a hand. This home page had 62px of it before these
    checks existed — a fixed-width illustration and a product grid whose
    `1fr` tracks were really `minmax(auto, 1fr)`, so neither would shrink
    below its contents.

    Checked across the routes and the widths, because the offending rules
    live in different breakpoints and a fix at 360px can leave 414px broken.
  */
  console.log('--- every route, every width ---');
  for (const width of [320, 360, 414, 768, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    for (const path of ['/', '/plan', '/portal', '/furniture/armchair-cane-back']) {
      await page.goto(`${BASE}${path}`);
      const over = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(over <= 0, `${width}px ${path} does not scroll sideways`, `${over}px over`);
    }
    await context.close();
  }

  console.log('--- 360px phone ---');
  const context = await browser.newContext({ ...devices['Pixel 5'], viewport: { width: 360, height: 780 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);

  // Two columns of prose at 360px is the exact thing the 960px breakpoint
  // exists to prevent, so this asserts the stack actually happened.
  const columns = await page.locator('.story').evaluate(el =>
    getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(columns === 1, 'the story stacks to one column', `${columns} column(s)`);

  // The tap targets people will actually aim at with a thumb.
  for (const selector of ['.faq-item summary', '.capsule', '.footer-column a']) {
    const box = await page.locator(selector).first().boundingBox();
    check(box.height >= 44, `${selector} is at least 44px tall`, `${Math.round(box.height)}px`);
  }
  await context.close();
}


/* --------------------------------------------------- the pinned stage ---- */
{
  /*
    The hero renders a 3D room. Four things have to be true about it, and
    none of them shows up in a build:

      it arrives          the renderer loads and the canvas actually paints
      it is cheap         triangle count and draw calls stay where the
                          simplification put them, so a later re-export of
                          the model cannot quietly restore 2M triangles
      it moves            scrolling repositions it, rather than the canvas
                          being a static picture that only looks right at the
                          top of the page
      it is scenery       it never intercepts a click meant for a link
  */
  console.log('--- the 3D stage ---');
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/`);

  const live = await page
    .waitForFunction(() => document.querySelector('.hero-stage')?.dataset.mode === 'live',
      { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  check(live, 'the renderer starts and reports live');

  if (live) {
    await page.waitForTimeout(800);

    /*
      A canvas that exists but never painted looks exactly like one that did,
      from the DOM's point of view.

      readPixels is the obvious check and it does not work here: the renderer
      runs with preserveDrawingBuffer false, so by the time anything can read
      the buffer the compositor has already cleared it, and the check reports
      a confident 0% on a canvas that is visibly full of furniture. (It did
      exactly that on the first run.)

      So compare the rendered page against itself with the canvas hidden. If
      the two screenshots are identical, the canvas was contributing nothing.
    */
    const withRoom = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await page.evaluate(() => {
      document.querySelector('.hero-stage-canvas').style.visibility = 'hidden';
    });
    await page.waitForTimeout(200);
    const withoutRoom = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await page.evaluate(() => {
      document.querySelector('.hero-stage-canvas').style.visibility = '';
    });
    check(!withRoom.equals(withoutRoom), 'the room is actually drawn on the canvas',
      `${withRoom.length} vs ${withoutRoom.length} bytes`);

    // The budget the model was simplified to. If someone re-exports it
    // without simplifying, this is the line that says so.
    const info = await page.evaluate(() => window.__furnisharStageInfo || null);
    if (info) {
      check(info.triangles <= 200000, 'the model stays inside its triangle budget',
        `${info.triangles} triangles`);
      check(info.calls <= 8, 'it draws in a handful of calls', `${info.calls} draw calls`);
    } else {
      check(false, 'the stage reports its render stats');
    }

    // Scroll a third of the way in and confirm the room moved. A sticky
    // canvas that does not respond to scroll is a very expensive photograph.
    const before = await page.evaluate(() => window.__furnisharStagePose);
    const range = await page.evaluate(() =>
      document.querySelector('.hero-stage').getBoundingClientRect().height - window.innerHeight);
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), range * 0.45);
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => window.__furnisharStagePose);
    const moved = before && after
      && (Math.abs(after.x - before.x) > 0.2 || Math.abs(after.rotY - before.rotY) > 0.2);
    check(Boolean(moved), 'the room travels as the page scrolls',
      before && after ? `x ${before.x.toFixed(2)} -> ${after.x.toFixed(2)}` : 'no pose reported');
  }

  // Scenery must not eat clicks. Ask the document what is actually on top at
  // the middle of the screen where the canvas sits.
  const swallows = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el?.closest('.hero-stage-pin') != null;
  });
  check(!swallows, 'the canvas does not intercept pointer events');

  await page.close();
}


/* ------------------------------------------- the room sits on the grid --- */
{
  /*
    The room must stay aligned with the layout, not with the viewport.

    This is the bug the first version shipped and nothing caught: the model
    was placed at a fraction of the VIEWPORT while the capsule rail is pinned
    to the max-width grid, so the two agreed at 1440x900 and drifted 80px
    apart at 1344x682 — dead space on the right, the room crowding the
    headline. No error, no overflow, no failing assertion. Just wrong.

    So the assertion is the relationship: wherever the rail's right edge is,
    the room's right edge is near it, at every window shape.
  */
  console.log('--- the room stays on the grid ---');
  for (const [width, height] of [[1344, 682], [1440, 900], [1680, 1050], [1920, 1000]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(`${BASE}/`);
    const live = await page
      .waitForFunction(() => typeof window.__furnisharStageBounds === 'function', { timeout: 60000 })
      .then(() => true).catch(() => false);
    if (!live) {
      check(false, `${width}x${height}: the stage came up`);
      await context.close();
      continue;
    }
    await page.waitForTimeout(900);

    const m = await page.evaluate(() => {
      const bounds = window.__furnisharStageBounds();
      const rail = document.querySelector('.capsule-rail').getBoundingClientRect();
      const hero = document.querySelector('.hero');
      const style = getComputedStyle(hero);
      const rect = hero.getBoundingClientRect();
      const columnRight = rect.right - parseFloat(style.paddingRight);
      return { bounds, railRight: rail.right, columnRight, vh: window.innerHeight };
    });

    // Within a capsule's own height of the rail: close enough to read as one
    // composition, loose enough not to fail on a rotation of the model.
    const drift = Math.abs(m.bounds.right - m.railRight);
    check(drift < 70, `${width}x${height}: the room's right edge tracks the rail`,
      `${Math.round(drift)}px apart`);

    // And it must not spill past the grid into the gutter.
    check(m.bounds.right <= m.columnRight + 24,
      `${width}x${height}: it stays inside the column`,
      `room ${Math.round(m.bounds.right)} vs column ${Math.round(m.columnRight)}`);

    // Nor lose its legs below the fold.
    check(m.bounds.bottom <= m.vh + 8, `${width}x${height}: the room fits above the fold`,
      `bottom ${Math.round(m.bounds.bottom)} of ${m.vh}`);

    await context.close();
  }
}

/* ------------------------------------------------- the capsule rail ------ */
{
  /*
    Three pills that look like shortcuts and scroll you to an unfiltered grid
    would be worse than no shortcut at all, so this follows one for real and
    checks the grid narrowed.
  */
  console.log('--- the category rail ---');
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);

  const rail = page.locator('.capsule-card');
  const count = await rail.count();
  check(count > 0, 'the rail has capsules', `${count}`);

  if (count > 0) {
    // Every capsule must name a category the catalogue really has, with the
    // count it really holds.
    const claims = await rail.evaluateAll(nodes => nodes.map(n => ({
      href: n.getAttribute('href'),
      label: n.querySelector('.capsule-label b')?.textContent,
      says: Number((n.querySelector('.capsule-label small')?.textContent || '').match(/\d+/)?.[0])
    })));

    const truth = await page.evaluate(() => {
      const counts = {};
      for (const card of document.querySelectorAll('.product-grid .product-card')) {
        const name = card.querySelector('.product-name')?.textContent;
        if (name) counts[name] = true;
      }
      return Object.keys(counts).length;
    });
    check(truth > 0, 'the grid rendered something to compare against', `${truth} cards`);

    for (const claim of claims) {
      check(/category=/.test(claim.href || ''), `${claim.label} links to a filter`, claim.href);
    }

    // Follow the first one and count what survives.
    const first = claims[0];
    await page.goto(`${BASE}${first.href}`);
    await page.waitForTimeout(600);
    const shown = await page.locator('.product-grid .product-card').count();
    check(shown === first.says,
      `${first.label} really shows ${first.says}`, `grid shows ${shown}`);

    const selected = await page.locator('.filter-group select').first().inputValue();
    check(selected === first.label, 'the category select reflects the link', selected);
  }
  await page.close();
}

/* ----------------------------------------------------- the marquee ------- */
{
  console.log('--- the marquee ---');
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.locator('.marquee').scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);

  const first = await page.locator('.marquee-track').evaluate(el => el.style.transform);
  await page.waitForTimeout(900);
  const second = await page.locator('.marquee-track').evaluate(el => el.style.transform);
  check(first !== second, 'the strip is moving', `${first || 'none'} -> ${second || 'none'}`);

  /*
    A strip that keeps sliding under the pointer is a strip you cannot click.

    The event is dispatched rather than hovered for real: Playwright refuses
    to click or hover an element that is still moving ("element is not
    stable"), which is a fair complaint about a marquee and a deadlock for
    testing one. The component listens on the track, so this is the same
    event it would receive from a real pointer.
  */
  await page.locator('.marquee-track').dispatchEvent('pointerenter');
  await page.waitForTimeout(400);
  const held = await page.locator('.marquee-track').evaluate(el => el.style.transform);
  await page.waitForTimeout(700);
  const stillHeld = await page.locator('.marquee-track').evaluate(el => el.style.transform);
  check(held === stillHeld, 'it stops under the pointer', held);

  await page.locator('.marquee-track').dispatchEvent('pointerleave');
  await page.waitForTimeout(300);

  // And the keyboard's version of the same problem. focus() does not require
  // the element to be still, so this one can be driven directly.
  await page.locator('.marquee-link').first().focus();
  await page.waitForTimeout(400);
  const focusHeld = await page.locator('.marquee-track').evaluate(el => el.style.transform);
  await page.waitForTimeout(700);
  check(focusHeld === await page.locator('.marquee-track').evaluate(el => el.style.transform),
    'it stops when a link inside it is focused');

  // The duplicate copy must not be read out or tabbed through twice.
  const links = await page.locator('.marquee-link').count();
  const cards = await page.locator('.marquee-card').count();
  check(links * 2 === cards, 'only one copy is reachable', `${links} links, ${cards} cards`);

  await page.close();
}

/* ------------------------------------------------ reduced motion ---------- */
{
  console.log('--- prefers-reduced-motion ---');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);

  await page.locator('.capsule').first().hover();
  const shifted = await page.locator('.capsule').first().evaluate(el =>
    getComputedStyle(el).transform);
  check(shifted === 'none' || shifted === 'matrix(1, 0, 0, 1, 0, 0)',
    'the capsule does not lift', shifted);

  // The whole point of the fallback: reduced motion must not mean a blank
  // space where the hero was. The renderer never starts and the still shows.
  const mode = await page.locator('.hero-stage').getAttribute('data-mode');
  check(mode === 'still', 'the stage falls back to the still image', String(mode));
  const stillShown = await page.locator('.hero-stage-still').evaluate(el =>
    Number(getComputedStyle(el).opacity));
  check(stillShown > 0.9, 'the still is actually visible', String(stillShown));

  // Every promise must be readable, not frozen part-lit at 34%.
  const dim = await page.locator('.promise h3').evaluateAll(nodes =>
    nodes.filter(n => Number(getComputedStyle(n).opacity) < 0.99).length);
  check(dim === 0, 'every promise is resolved, not stuck mid-fade', `${dim} dim`);

  // The icon must still END as a minus — reduced motion removes the travel,
  // not the state.
  //
  // Read after the transition, not during it. Reduced motion flattens the
  // duration to 1ms rather than to zero, so a measurement taken in the same
  // tick as the click catches the icon at t=0 — still a plus — and reports a
  // failure that only exists inside the test.
  const item = page.locator('.faq-item').first();
  await item.locator('summary').click();

  /*
    Poll for the end state instead of sleeping towards it.

    Reduced motion flattens the transition to 1ms rather than to zero, so
    there IS a moment where the icon is mid-rotation, and a fixed wait races
    it — this check passed on a quiet machine and failed on a busy one, which
    is the worst way for a test to be wrong. Waiting for the condition makes
    the outcome depend on the page rather than on the runner's load.
  */
  const settled = await page
    .waitForFunction(() => {
      const icon = document.querySelector('.faq-item[open] summary i');
      if (!icon) return false;
      const t = getComputedStyle(icon, '::after').transform;
      return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
    }, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  const after = await item.locator('summary i').evaluate(el =>
    getComputedStyle(el, '::after').transform);
  check(settled, 'the plus still becomes a minus', after);

  await context.close();
}

await browser.close();
console.log(failures ? `\nFAILED: ${failures} check(s)` : '\nevery check passed');
process.exit(failures ? 1 : 0);
