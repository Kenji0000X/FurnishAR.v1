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
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

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

  const hrefs = await page.locator('.step-link, .band-actions a, footer a').evaluateAll(
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

  // Three columns of prose at 360px is the exact thing the 960px breakpoint
  // exists to prevent, so this asserts the stack actually happened.
  const columns = await page.locator('.step-list').evaluate(el =>
    getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(columns === 1, 'the steps stack to one column', `${columns} column(s)`);

  // The tap targets people will actually aim at with a thumb.
  for (const selector of ['.faq-item summary', '.step-link', '.footer-column a']) {
    const box = await page.locator(selector).first().boundingBox();
    check(box.height >= 44, `${selector} is at least 44px tall`, `${Math.round(box.height)}px`);
  }
  await context.close();
}

/* ------------------------------------------------ reduced motion ---------- */
{
  console.log('--- prefers-reduced-motion ---');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);

  await page.locator('.step-link').first().hover();
  const shifted = await page.locator('.step-link span').first().evaluate(el =>
    getComputedStyle(el).transform);
  check(shifted === 'none' || shifted === 'matrix(1, 0, 0, 1, 0, 0)',
    'the step arrow does not slide', shifted);

  // The icon must still END as a minus — reduced motion removes the travel,
  // not the state.
  //
  // Read after the transition, not during it. Reduced motion flattens the
  // duration to 1ms rather than to zero, so a measurement taken in the same
  // tick as the click catches the icon at t=0 — still a plus — and reports a
  // failure that only exists inside the test.
  const item = page.locator('.faq-item').first();
  await item.locator('summary').click();
  await page.waitForTimeout(60);
  const after = await item.locator('summary i').evaluate(el =>
    getComputedStyle(el, '::after').transform);
  check(after === 'none' || after === 'matrix(1, 0, 0, 1, 0, 0)',
    'the plus still becomes a minus', after);
  await context.close();
}

await browser.close();
console.log(failures ? `\nFAILED: ${failures} check(s)` : '\nevery check passed');
process.exit(failures ? 1 : 0);
