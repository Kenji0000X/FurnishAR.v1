/**
 * The navigation rebuild, driven in a real browser.
 *
 * Five things were asked for and all five are the kind that compile perfectly
 * and are still wrong on the page: a burger that does not open, a "route" that
 * is really an anchor, a home page that keeps going past where it should stop,
 * a footer that was supposed to shrink, and a workspace still wearing the
 * public chrome. A green build proves none of it.
 *
 *   node scripts/check-nav.mjs [baseUrl]
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

console.log('--- one burger, no text nav ---');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('the row of text nav links is gone',
  await page.locator('.main-nav .nav-link').count() === 0,
  `${await page.locator('.main-nav .nav-link').count()} left`);
check('a burger is in the header', await page.locator('.nav-burger').isVisible());
check('and it announces its state',
  await page.getAttribute('.nav-burger', 'aria-expanded') === 'false');

await page.click('.nav-burger');
await page.waitForSelector('.drawer-panel', { timeout: 5000 });
check('it opens a drawer', await page.locator('.drawer-panel').isVisible());
check('the drawer is a real dialog',
  await page.getAttribute('.drawer-panel', 'aria-modal') === 'true');

/* Every destination, and the route printed beside it — that label is what
   stops the design and the router drifting apart. */
const routes = await page.locator('.drawer-link code').allTextContents();
for (const want of ['/', '/collection', '/plan', '/diagnose', '/portal', '/faq']) {
  check(`the drawer offers ${want}`, routes.includes(want), routes.join(' · '));
}

console.log('--- escape and the scrim both close it ---');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
check('Escape closes the drawer', await page.locator('.drawer-panel').count() === 0);
/* And hands focus back. It used to leave document.activeElement on <body>,
   so the next Tab restarted from the skip link at the top of the page: a
   keyboard user who opened the menu and changed their mind was sent to the
   beginning of the document, every time. BRAND.md §9 names this contract. */
check('and focus goes back to the burger that opened it',
  await page.evaluate(() => document.activeElement?.classList.contains('nav-burger')),
  await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName));
await page.click('.nav-burger');
await page.waitForSelector('.drawer-panel');
await page.click('.drawer-scrim');
await page.waitForTimeout(250);
check('and so does the scrim', await page.locator('.drawer-panel').count() === 0);

console.log('--- the destinations are pages, not anchors ---');
await page.click('.nav-burger');
await page.waitForSelector('.drawer-panel');
await page.click('.drawer-link:has-text("Collection")');
await page.waitForURL('**/collection', { timeout: 8000 }).catch(() => {});
check('Collection is its own route', new URL(page.url()).pathname === '/collection', page.url());
check('and it carries the catalogue', await page.locator('.product-card').count() > 0,
  `${await page.locator('.product-card').count()} cards`);
check('the drawer closed itself on navigating',
  await page.locator('.drawer-panel').count() === 0);

await page.goto(`${BASE}/faq`, { waitUntil: 'domcontentloaded' });
check('the questions are their own route too', await page.locator('details').count() > 0,
  `${await page.locator('details').count()} questions`);

console.log('--- the home page ends where it was told to ---');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('the catalogue grid is no longer on the home page',
  await page.locator('#catalog').count() === 0);
check('nor the questions', await page.locator('details.faq-item, .faq').count() === 0);
/* It must still END on the three claims rather than merely losing the grid. */
const lastSection = await page.evaluate(() => {
  const sections = [...document.querySelectorAll('main section')];
  return sections.length ? sections[sections.length - 1].className : '';
});
check('the last thing on it is the three claims',
  /promise/.test(lastSection), lastSection || '(none)');
check('and the hero points at the collection route',
  await page.getAttribute('.hero-actions a:nth-child(2)', 'href') === '/collection',
  await page.getAttribute('.hero-actions a:nth-child(2)', 'href'));

console.log('--- the footer is one band, and absent from the workspace ---');
const band = await page.locator('.footer-band').boundingBox();
check('the public footer is a single band', Boolean(band));
check('and it is short', band && band.height < 220, band ? `${Math.round(band.height)}px tall` : 'missing');
check('it still lists only routes that exist',
  (await page.locator('.footer-group a').count()) === 6,
  `${await page.locator('.footer-group a').count()} links`);

await page.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
check('the portal has no footer', await page.locator('.site-footer').count() === 0);
check('and no public CTA in its header', await page.locator('.header-action').count() === 0);
/* And no burger either. The drawer is the shopper's map of the site —
   Collection, Measure my space, the questions. A store owner signing in to
   upload a model is not browsing the catalogue, and offering them a menu of
   shopper routes on top of the portal's own navigation is two competing
   menus on one screen. The wordmark still goes home. */
check('and no shopper menu', await page.locator('.nav-burger').count() === 0);
check('the wordmark is still the way back to the public site',
  await page.getAttribute('.brand', 'href') === '/');
check('and says which workspace you are in',
  await page.locator('.header-context').textContent().then(t => /Store portal/.test(t)));

console.log('--- the bell ---');
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('every page has a notification bell', await page.locator('.bell-button').isVisible());
/* With no feed wired up it must show NO dot. An unknown count is not zero,
   and it is certainly not a red badge. */
await page.waitForTimeout(600);
check('with no feed, it shows no unread dot rather than inventing one',
  await page.locator('.bell-dot').count() === 0);
await page.click('.bell-button');
await page.waitForTimeout(200);
check('opening it says plainly that notifications are not on yet',
  await page.locator('.bell-panel').textContent().then(t => /not switched on/.test(t)));

console.log('--- the header search actually searches ---');
/* A magnifying glass that leads nowhere is the "button that does nothing"
   every brief bans two sections after asking for it. This one must carry the
   term to the catalogue and be reproducible from the URL. */
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('the header carries a real search form',
  await page.locator('.header-search input').isVisible());
/* And it shows where the keyboard is. The field's own outline is suppressed
   so it reads as one control, and what replaced it was a 1px border recolour
   — the weakest focus indicator on the site, on a tab stop that exists on
   every page. BRAND.md §9 promises "a ring on the wrapper"; this checks for
   an actual ring. */
await page.locator('.header-search input').focus();
check('and it shows a real focus ring, not just a tinted border',
  await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.header-search'));
    return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
  }),
  await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.header-search'));
    return `${s.outlineStyle} ${s.outlineWidth}`;
  }));
await page.fill('.header-search input', 'armchair');
await page.press('.header-search input', 'Enter');
await page.waitForURL('**/collection?q=armchair', { timeout: 8000 }).catch(() => {});
check('submitting lands on the collection with the term in the URL',
  page.url().includes('/collection?q=armchair'), page.url());
await page.waitForTimeout(400);
check('and the catalogue actually applied it',
  await page.inputValue('.search-input input') === 'armchair',
  await page.inputValue('.search-input input'));

/* A term that matches nothing must reach the honest empty state, not a full
   grid pretending the search ran. */
await page.goto(`${BASE}/collection?q=zzzznomatch`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
check('a term that matches nothing shows the empty state',
  await page.locator('.no-results').isVisible());

console.log('--- the phone agrees with the desktop ---');
const phone = await browser.newPage({ viewport: { width: 390, height: 780 } });
await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
check('the burger is reachable on a phone too', await phone.locator('.nav-burger').isVisible());
await phone.click('.nav-burger');
await phone.waitForSelector('.drawer-panel', { timeout: 5000 });
const panel = await phone.locator('.drawer-panel').boundingBox();
check('the drawer fits the screen', panel && panel.width <= 390, panel ? `${Math.round(panel.width)}px` : 'missing');
await phone.keyboard.press('Escape');
check('and the bottom bar points Collection at the route',
  await phone.getAttribute('.bottom-nav-item[aria-label="Collection"]', 'href') === '/collection',
  await phone.getAttribute('.bottom-nav-item[aria-label="Collection"]', 'href'));
await phone.close();

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe navigation rebuild holds');
process.exit(problems.length ? 1 : 0);
