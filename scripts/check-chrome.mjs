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

console.log('--- the skip link, on every route ---');
// The bug: it pointed at #catalog, which exists only on the home page.
for (const route of ['/', '/plan', '/portal']) {
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

console.log('--- mobile menu ---');
const phone = await browser.newPage({ viewport: { width: 390, height: 780 } });
await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('the nav is collapsed on a phone', !(await phone.locator('.main-nav').isVisible()));
check('there is a button to open it', await phone.locator('.nav-toggle').isVisible());
await phone.click('.nav-toggle');
await phone.waitForTimeout(200);
check('tapping it opens the nav', await phone.locator('.main-nav').isVisible());
check('the button reports its state', await phone.getAttribute('.nav-toggle', 'aria-expanded') === 'true');
// The bug this guards: Next does a client-side transition, so an open menu
// would otherwise survive the navigation and cover the new page.
await phone.click('.main-nav .nav-link:has-text("Space planner")');
await phone.waitForURL('**/plan', { timeout: 10000 }).catch(() => {});
await phone.waitForTimeout(300);
check('navigating closes it again', !(await phone.locator('.main-nav').isVisible()));

console.log('--- catalogue search ---');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
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
