/**
 * Drives the site chrome added for the redesign, in a real browser.
 *
 * Every one of these is the kind of thing that compiles perfectly and is
 * still broken on the page — a menu that does not open, a theme that flashes
 * white, a skip link pointing at an element that does not exist on this route.
 * A green build proves none of it.
 *
 *   node scripts/check-chrome.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4173';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

// Check the stylesheet actually loaded before testing anything that depends on
// it. Nearly every assertion below reads a computed style, so a stylesheet
// that 404s or arrives as text/plain shows up as three unrelated feature
// failures — "the toggle does not change the page", "the nav is not
// collapsed" — and sends you hunting through CSS that was never the problem.
// (Which is exactly what a stale `next-server` left running on this port
// did: it served HTML pointing at chunk hashes its own build had, while the
// files on disk belonged to a newer one.)
console.log('--- the stylesheet is actually being served ---');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const sheets = await page.evaluate(() =>
  [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href));
let styleOk = sheets.length > 0;
for (const href of sheets) {
  const response = await page.request.get(href);
  const type = response.headers()['content-type'] || '';
  if (!response.ok() || !type.includes('text/css')) {
    styleOk = false;
    console.log(`   ${href} → HTTP ${response.status()} ${type}`);
  }
}
check('every stylesheet loads as text/css', styleOk, `${sheets.length} sheet(s)`);
if (!styleOk) {
  console.log('\nThe stylesheet did not load, so every style assertion below would be noise.');
  console.log('Usually a stale server: kill any `next-server` process, rebuild, restart.');
  await browser.close();
  process.exit(1);
}

console.log('--- the skip link, on every route ---');
// The bug: it pointed at #catalog, which exists only on the home page.
for (const route of ['/', '/collection', '/faq', '/plan', '/portal']) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  const target = await page.getAttribute('.skip-link', 'href');
  const exists = await page.locator(target).count();
  check(`${route}: skip link points at something that exists`, exists > 0, `${target} → ${exists} match(es)`);
}

console.log('--- dark theme ---');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await page.click('.theme-toggle');
await page.waitForTimeout(200);
const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('the toggle actually changes the page', lightBg !== darkBg, `${lightBg} → ${darkBg}`);
check('the choice is stored',
  await page.evaluate(() => localStorage.getItem('furnishar-theme')) === 'dark');

// The flash-of-light test: reload and read the colour before any React runs.
await page.goto(`${BASE}/portal`, { waitUntil: 'commit' });
const themeAtFirstPaint = await page.evaluate(() => document.documentElement.dataset.theme);
check('dark survives a reload with no flash of light', themeAtFirstPaint === 'dark',
  `data-theme at first paint: ${themeAtFirstPaint || '(unset)'}`);

console.log('--- the theme reaches every page, not just the public ones ---');
await page.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
const portalBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('the portal is themed too', portalBg === darkBg, portalBg);

/*
   This section used to drive the hamburger. There is no hamburger: the bottom
   bar replaced it, and the header's inline nav is hidden on a phone. So what
   is checked is what a phone now has — a bar that is always on screen, that
   says where you are, and that goes where it says.
*/
console.log('--- bottom nav (phone) ---');
const phone = await browser.newPage({ viewport: { width: 390, height: 780 } });
await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('the header nav is hidden on a phone', !(await phone.locator('.main-nav').isVisible()));
check('no menu button is left behind', await phone.locator('.nav-toggle').count() === 0);
check('the bottom bar is on screen without a tap', await phone.locator('.bottom-nav').isVisible());
/* The count is not the property worth defending — it was four and is five
   now that the device check exists, and it will change again. What must hold
   is that every slot leads somewhere real and none of them is squeezed below
   a usable tap target, which is what actually breaks when a slot is added. */
const slots = await phone.locator('.bottom-nav-item').count();
check('every slot leads somewhere', slots >= 4 && slots <= 5, `${slots} destinations`);
const tooSmall = await phone.evaluate(() =>
  [...document.querySelectorAll('.bottom-nav-item')]
    .map(i => ({ t: i.getAttribute('aria-label'), w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height) }))
    .filter(i => i.w < 44 || i.h < 44));
check('none of them is narrower than a fingertip', tooSmall.length === 0,
  tooSmall.length ? JSON.stringify(tooSmall) : 'all >= 44px');
/* Icons only: no visible text in the bar, but every item keeps a name. */
const naming = await phone.evaluate(() => [...document.querySelectorAll('.bottom-nav-item')].map(i => ({
  name: i.getAttribute('aria-label') || '',
  text: i.innerText.trim(),
  icon: Boolean(i.querySelector('svg')),
  iconSize: Math.round(i.querySelector('svg')?.getBoundingClientRect().width || 0)
})));
check('no visible text labels in the bar', naming.every(i => i.text === ''), JSON.stringify(naming.map(i => i.text)));
check('every item has an icon and an accessible name',
  naming.every(i => i.icon && i.name.length > 2), naming.map(i => i.name).join(', '));
check('the names say where each goes',
  ['Discover', 'Collection', 'Scan', 'Device', 'Account'].every(n => naming.some(i => i.name === n)));
check('icons are 22–26px', naming.every(i => i.iconSize >= 22 && i.iconSize <= 26), naming.map(i => i.iconSize).join(', '));
const activeLook = await phone.evaluate(() => {
  const on = document.querySelector('.bottom-nav-item[aria-current="page"]');
  const off = document.querySelector('.bottom-nav-item:not([aria-current]):not(.is-primary)');
  const pill = el => getComputedStyle(el.querySelector('.bottom-nav-pill')).backgroundColor;
  return { onColor: getComputedStyle(on).color, offColor: getComputedStyle(off).color, onPill: pill(on), offPill: pill(off),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim() };
});
check('the current item is visibly different: green icon on a filled pill',
  activeLook.onColor !== activeLook.offColor && activeLook.onPill !== activeLook.offPill
  && !/rgba\(0, 0, 0, 0\)|transparent/.test(activeLook.onPill), JSON.stringify(activeLook));
const pageHeading = await phone.locator('h1').first().innerText().catch(() => '');
check('the page still says where you are in words', pageHeading.trim().length > 0, pageHeading.slice(0, 40));
check(
  'exactly one is marked current',
  await phone.locator('.bottom-nav-item[aria-current="page"]').count() === 1
);
// It is pinned, so it must still be there after scrolling to the end.
await phone.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await phone.waitForTimeout(300);
const barBox = await phone.locator('.bottom-nav').boundingBox();
check('it stays pinned at the bottom', barBox && Math.abs(barBox.y + barBox.height - 780) < 2,
  barBox ? `bottom ${Math.round(barBox.y + barBox.height)}` : 'missing');
await phone.locator('.bottom-nav-item[aria-label="Scan"]').click();
await phone.waitForURL('**/plan', { timeout: 10000 }).catch(() => {});
check('tapping Scan goes to the planner', new URL(phone.url()).pathname === '/plan', phone.url());
check(
  'and Scan is now the current item',
  await phone.locator('.bottom-nav-item[aria-current="page"][aria-label="Scan"]').count() === 1
);

/* The device check is reachable from the bar, and the page it lands on is the
   real one rather than a 404 wearing the site's chrome. It is the answer to
   "will the scanner work on my phone", so it has to be reachable FROM the
   phone that is failing — a footer link on a desktop is no use there. */
await phone.locator('.bottom-nav-item[aria-label="Device"]').click();
await phone.waitForURL('**/diagnose', { timeout: 10000 }).catch(() => {});
check('tapping Device goes to the check', new URL(phone.url()).pathname === '/diagnose', phone.url());
/* The page renders "Asking the browser…" until the capability probe resolves,
   so wait for a row rather than for the URL. Asserting straight after
   navigation reads the pre-hydration DOM and reports zero rows for a page
   that is about to fill in perfectly. */
await phone.waitForSelector('.diag-row', { timeout: 10000 }).catch(() => {});
check('and the check actually ran on arrival',
  await phone.locator('.diag-row').count() >= 5,
  `${await phone.locator('.diag-row').count()} rows reported`);

console.log('--- catalogue search ---');
/* The catalogue is its own route now. It used to be a section of the home
   page reached by an anchor, which is why "Collection" in the navigation was
   a scroll rather than a destination and the front page never ended. */
await page.goto(`${BASE}/collection`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.search-input input', { timeout: 10000 });
const total = await page.locator('.product-card').count();
await page.fill('.search-input input', 'zzzznomatch');
await page.waitForTimeout(200);
check('a nonsense search empties the grid', await page.locator('.no-results').isVisible());
await page.fill('.search-input input', '');
await page.waitForTimeout(200);
check('clearing it brings everything back', await page.locator('.product-card').count() === total,
  `${total} card(s)`);

console.log('--- the width slider says what it means ---');
// The bug: "No limit" still applied width <= 240, hiding wider pieces.
const widest = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.product-card')];
  return cards.length;
});
check('every piece shows with the slider at "No limit"', widest === total, `${widest} of ${total}`);

console.log('--- 404 ---');
const notFound = await page.goto(`${BASE}/this-route-does-not-exist`, { waitUntil: 'domcontentloaded' });
check('returns a real 404 status', notFound.status() === 404, `HTTP ${notFound.status()}`);
check('and is not the bare Next.js page', await page.locator('.site-header').count() > 0,
  'site header present');
check('it offers a way back', await page.locator('.not-found-actions a').count() >= 1);

console.log('--- back to top ---');
// A short viewport, so the page is reliably taller than the 0.6-screen
// threshold. Scrolling a fixed 3000px instead made this depend on how many
// products the sample catalogue happens to contain, which is why it passed
// on one run and failed on the next.
const shortPage = await browser.newPage({ viewport: { width: 1280, height: 400 } });
await shortPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('hidden before scrolling',
  !(await shortPage.locator('.to-top').evaluate(el => el.classList.contains('is-shown'))));

const scrollable = await shortPage.evaluate(() => {
  const el = document.documentElement;
  window.scrollTo(0, el.scrollHeight);
  return el.scrollHeight - el.clientHeight;
});
await shortPage.waitForTimeout(400);
check('the page is long enough to test with', scrollable > 400 * 0.6, `${scrollable}px of scroll`);
check('appears once there is somewhere to go back to',
  await shortPage.locator('.to-top').evaluate(el => el.classList.contains('is-shown')));

// And it actually returns you to the top.
await shortPage.click('.to-top');
await shortPage.waitForTimeout(800);
check('clicking it goes back to the top', await shortPage.evaluate(() => window.scrollY) < 50);
await shortPage.close();

console.log('--- the AR planner can still be pinched ---');
// Removing the global zoom lock must not have unlocked the AR surface.
await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
const viewportMeta = await page.getAttribute('meta[name="viewport"]', 'content');
check('the page no longer forbids zoom site-wide',
  !/user-scalable=no|maximum-scale=1/.test(viewportMeta || ''), viewportMeta);

check('no uncaught page errors anywhere', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nall site chrome checks passed');
process.exit(problems.length ? 1 : 0);
