/**
 * The overview's tiles and charts, checked against the data they claim to count.
 *
 * A dashboard is the easiest thing in a project like this to fake. Five tiles
 * and three charts drawn from invented numbers look *more* finished than the
 * truth — five stores, four listings, three models — and nothing in a build,
 * a type check or a screenshot would say otherwise. So this stands up a fake
 * Supabase with known contents and asserts that every figure on the page is
 * the figure that data implies, arithmetic included.
 *
 * It also drives the two things that are wrong without saying so: a sub-nav
 * whose links do not reach their sections, and a pager that hides rows.
 *
 *   node scripts/check-dashboard.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SUPABASE_PORT = 4611;
const APP_PORT = 4612;
const KEY = 'sb_publishable_dashmock000000';
const ADMIN_TOKEN = 'token-for-the-admin';
const isAdmin = req => (req.headers.authorization || '').includes(ADMIN_TOKEN);

/* Deliberately awkward contents, so the assertions below cannot pass by
   accident on a round number:
     6 stores — 2 Premium, 4 Freemium
     3 uploaded models across 3 distinct products (12 MB + 8 MB + 1 MB)
     2 listings with no model at all
   so: 5 listings, 3 ready for AR, 60% ready, 21 MB total.
   A twelfth store exists only to push the Stores table onto a second page. */
const PLANS = ['Premium', 'Premium', 'Freemium', 'Freemium', 'Freemium', 'Freemium'];
const STORES = Array.from({ length: 12 }, (_, i) => ({
  id: `s${i + 1}`, slug: `store-${i + 1}`, name: `Store ${i + 1}`,
  plan: PLANS[i] || 'Freemium', status: 'active'
}));

const MB = 1024 * 1024;
const ASSETS = [
  { id: 'a1', kind: 'glb', byte_size: 12 * MB, created_at: new Date().toISOString(),
    product: { id: 'p1', name: 'Armchair', status: 'published', store: { name: 'Store 1' } } },
  { id: 'a2', kind: 'glb', byte_size: 8 * MB, created_at: new Date().toISOString(),
    product: { id: 'p2', name: 'Bench', status: 'published', store: { name: 'Store 1' } } },
  { id: 'a3', kind: 'glb', byte_size: 1 * MB, created_at: new Date().toISOString(),
    product: { id: 'p3', name: 'Lamp', status: 'draft', store: { name: 'Store 2' } } }
];
const MISSING = [
  { id: 'p4', name: 'Side Table', status: 'draft', store: { name: 'Store 1' } },
  { id: 'p5', name: 'Shelf', status: 'draft', store: { name: 'Store 2' } }
];
const USAGE = [
  { store_id: 's1', store_name: 'Store 1', file_count: 2, total_bytes: 20 * MB },
  { store_id: 's2', store_name: 'Store 2', file_count: 1, total_bytes: 1 * MB }
];

const supabase = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith('/auth/v1/health')) {
      return req.headers.apikey === KEY ? send(200, { name: 'GoTrue' }) : send(401, {});
    }
    if (req.url.startsWith('/auth/v1/user')) {
      return isAdmin(req)
        ? send(200, { id: ADMIN_TOKEN, email: 'admin@furnishar.ph' })
        : send(401, { message: 'invalid claim' });
    }
    if (req.url.includes('grant_type=password')) {
      return send(200, {
        access_token: ADMIN_TOKEN, refresh_token: `${ADMIN_TOKEN}-r`,
        user: { id: ADMIN_TOKEN, email: 'admin@furnishar.ph' }
      });
    }
    if (req.url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, isAdmin(req));
    if (req.url.startsWith('/rest/v1/rpc/applicant_account')) {
      return send(200, { found: true, confirmed: true, disabled: false,
        confirmed_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString() });
    }
    if (req.url.startsWith('/rest/v1/rpc/storage_usage')) {
      return send(200, isAdmin(req) ? USAGE : []);
    }
    if (req.url.startsWith('/rest/v1/store_applications')) return send(200, []);
    if (req.url.startsWith('/rest/v1/stores')) return send(200, isAdmin(req) ? STORES : []);
    if (req.url.startsWith('/rest/v1/admin_audit')) {
      return send(200, isAdmin(req) ? [{
        id: 'e1', action: 'application.approved', actor_email: 'admin@furnishar.ph',
        at: new Date(Date.now() - 600e3).toISOString(), detail: { store_name: 'Store 1' }
      }] : []);
    }
    if (req.url.startsWith('/rest/v1/product_assets')) return send(200, isAdmin(req) ? ASSETS : []);
    if (req.url.startsWith('/rest/v1/products')) {
      return send(200, isAdmin(req)
        ? [...ASSETS.map(a => ({ ...a.product, product_assets: [{ kind: 'glb' }] })),
           ...MISSING.map(p => ({ ...p, product_assets: [] }))]
        : []);
    }
    if (req.url.startsWith('/rest/v1/store_members')) return send(200, []);
    send(200, []);
  });
});

await new Promise(resolve => supabase.listen(SUPABASE_PORT, resolve));

if (await fetch(`http://127.0.0.1:${APP_PORT}/admin`).then(() => true).catch(() => false)) {
  console.error(`Something is already listening on ${APP_PORT}. Stop it first.`);
  process.exit(1);
}

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: KEY,
    FURNISHAR_JWT_SECRET: 'dashboard-check-secret'
  },
  stdio: 'ignore',
  detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/admin`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

await page.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('form.login-form', { timeout: 20000 });
await page.fill('input[name="email"]', 'admin@furnishar.ph');
await page.fill('input[name="password"]', 'whatever');
await page.click('form.login-form button[type="submit"]');
await page.waitForSelector('.kpi-tile', { timeout: 20000 });

/** The value printed in the tile with this label. */
const tile = label => page.evaluate(want => {
  for (const node of document.querySelectorAll('.kpi-tile')) {
    if (node.querySelector('.kpi-label')?.textContent?.trim() === want) {
      return node.querySelector('.kpi-value')?.textContent?.trim();
    }
  }
  return null;
}, label);

console.log('--- the tiles count what is really there ---');
check('Stores counts every registered store', await tile('Stores') === '12', await tile('Stores'));
check('Listings counts modelled and unmodelled together',
  await tile('Listings') === '5', await tile('Listings'));
check('3D files counts uploaded files', await tile('3D files') === '3', await tile('3D files'));
/* 12 + 8 + 1 = 21 MB. The arithmetic is the point: a tile that renders the
   largest file, or the count, and calls it a total is the exact failure this
   catches. */
check('Storage adds the file sizes up', await tile('Storage') === '21 MB', await tile('Storage'));
check('Queue says zero when nothing is waiting',
  await tile('Queue') === '0', await tile('Queue'));

console.log('--- the charts say the same thing as the tiles ---');
const plans = await page.locator('.chart-card:has-text("Stores by plan") .chart-bars li')
  .evaluateAll(nodes => nodes.map(n => [
    n.querySelector('.chart-bar-label')?.textContent?.trim(),
    n.querySelector('.chart-bar-value')?.textContent?.trim()
  ]));
check('Premium is counted', plans.some(([l, v]) => l === 'Premium' && v === '2'), JSON.stringify(plans));
check('Freemium is counted', plans.some(([l, v]) => l === 'Freemium' && v === '10'), JSON.stringify(plans));
/* Colour follows the entity, not its rank: Freemium is ten times larger than
   Premium and must still wear slot 2. */
const planColours = await page.locator('.chart-card:has-text("Stores by plan") .chart-bar-fill')
  .evaluateAll(nodes => nodes.map(n => getComputedStyle(n).backgroundColor));
check('the two plans are drawn in different hues',
  planColours.length === 2 && planColours[0] !== planColours[1], planColours.join(' / '));

const readyText = await page.locator('.chart-card:has-text("Listings ready for AR")').innerText();
// 3 of 5 = 60%. Worked out on the page, not by this script reading a label.
check('the AR-ready share is the real share', /60% of 5 listings/.test(readyText),
  readyText.split('\n')[1]);
check('and both parts of the whole are labelled',
  /Ready for AR\s*3/.test(readyText) && /No 3D model\s*2/.test(readyText));

const storageText = await page.locator('.chart-card:has-text("Storage used by store")').innerText();
check('the storage chart totals the same 21 MB', /21 MB across the platform/.test(storageText),
  storageText.split('\n')[1]);
/* Sorted by size, because "who is using it up" is the question. */
const storeOrder = await page.locator('.chart-card:has-text("Storage used by store") .chart-bar-label')
  .allTextContents();
check('and it is sorted largest first', storeOrder[0] === 'Store 1', storeOrder.join(' > '));

console.log('--- every chart offers the numbers as a table ---');
/* Not a nicety: three light-mode steps in this palette sit below 3:1 against
   the surface, and the relief rule makes visible labels or a table view the
   condition on using them at all. */
const cards = await page.locator('.chart-card').count();
check('three charts on the overview', cards === 3, `${cards}`);
check('each one has a table toggle',
  await page.locator('.chart-toggle').count() === cards);
await page.locator('.chart-card:has-text("Stores by plan") .chart-toggle').click();
await page.waitForTimeout(200);
check('the toggle really swaps in a table',
  await page.locator('.chart-card:has-text("Stores by plan") .chart-table').isVisible());

console.log('--- the activity rail ---');
/* "approved — Store 1", not "application.approved": the prefix is a database
   namespace, and the rail is read by a person. */
check('the rail shows the recorded decision',
  /approved — Store 1/.test(await page.locator('.activity-rail').innerText()),
  (await page.locator('.activity-rail').innerText()).split('\n')[0]);
check('and names who did it',
  /admin@furnishar\.ph/.test(await page.locator('.activity-rail').innerText()));
check('it is announced rather than silently appearing',
  await page.getAttribute('.activity-rail', 'aria-live') === 'polite');

console.log('--- six sections, six URLs ---');
for (const [label, path] of [
  ['Applications', '/admin/applications'],
  ['Stores', '/admin/stores'],
  ['3D files', '/admin/models'],
  ['Usage', '/admin/usage'],
  ['Activity', '/admin/activity']
]) {
  await page.click(`.admin-nav-link:has-text("${label}")`);
  await page.waitForURL(`**${path}`, { timeout: 10000 }).catch(() => {});
  check(`${label} is its own route`, new URL(page.url()).pathname === path, page.url());
  check(`and ${label} marks itself current`,
    await page.getAttribute(`.admin-nav-link:has-text("${label}")`, 'aria-current') === 'page');
}

console.log('--- the pager stops the table running away ---');
await page.goto(`http://127.0.0.1:${APP_PORT}/admin/stores`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.table-pager', { timeout: 20000 });
check('twelve stores do not all render at once',
  await page.locator('tbody tr').count() === 10,
  `${await page.locator('tbody tr').count()} rows`);
check('and it says how many there are in total',
  /1–10 of 12/.test(await page.locator('.table-pager-count').innerText()),
  await page.locator('.table-pager-count').innerText());
await page.click('.table-pager-controls button:has-text("2")');
await page.waitForTimeout(200);
check('the second page holds the rest',
  await page.locator('tbody tr').count() === 2,
  `${await page.locator('tbody tr').count()} rows`);
check('and the rest are the rows the first page did not show',
  /Store 12/.test(await page.locator('tbody').innerText()));

console.log('--- signing out ---');
/* The console had no way out of it at all. An admin who finished reviewing
   had to navigate to /portal to leave — on a shared machine that is the
   difference between closing the queue and leaving it open on the screen. */
await page.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.kpi-tile', { timeout: 20000 });
check('the console says which account is signed in',
  /admin@furnishar\.ph/.test(await page.locator('.admin-who').innerText()));
await page.click('.admin-signout');
await page.waitForSelector('form.login-form', { timeout: 10000 }).catch(() => {});
check('signing out returns to the sign-in form',
  await page.locator('form.login-form').isVisible());
/* Thrown away, not hidden: the queue holds applicants' contact details. */
check('and takes the console\'s data with it',
  await page.locator('.kpi-tile').count() === 0 &&
  !/Store 1\b/.test(await page.locator('body').innerText()));

console.log('--- no shopper menu in the workspace ---');
/* The drawer is the shopper's map of the site. An operator reviewing
   applications is not browsing the catalogue, and two menus on one screen
   is one too many. */
await page.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
check('no burger on the console', await page.locator('.nav-burger').count() === 0);
await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
check('nor on the store portal', await page.locator('.nav-burger').count() === 0);
/* Still reachable for a shopper, or the removal went too far. */
await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);
check('but the public site still has one', await page.locator('.nav-burger').isVisible());

console.log('--- the console on a phone ---');
const phone = await browser.newPage({ viewport: { width: 390, height: 780 } });
await phone.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector('form.login-form', { timeout: 20000 });
await phone.fill('input[name="email"]', 'admin@furnishar.ph');
await phone.fill('input[name="password"]', 'whatever');
await phone.click('form.login-form button[type="submit"]');
await phone.waitForSelector('.kpi-tile', { timeout: 20000 });
await phone.waitForTimeout(600);

/* The reported bug, and the reason this check signs in on the phone rather
   than measuring the sign-in screen: .admin-console is a grid, an automatic
   grid track is sized to its widest item's max-content, and the section bar
   dragged the whole console out to 819px on a 390px screen. Every heading
   and every chart inherited that width, so the page scrolled sideways and
   the text sat off to the right of the screen. */
const over = await phone.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('the console does not scroll sideways on a phone', over <= 0, `${over}px over`);
check('the headings start at the left edge of the screen, not off to the right',
  await phone.evaluate(() => {
    const box = document.querySelector('.admin-intro h1').getBoundingClientRect();
    return box.left >= 0 && box.right <= document.documentElement.clientWidth + 1;
  }));
check('the shopper bottom bar is gone from the console too',
  await phone.locator('.bottom-nav').count() === 0);
check('and Sign out is reachable without scrolling sideways',
  await phone.locator('.admin-signout').isVisible());

console.log('--- the tiles are flash cards, not banners ---');
const tiles = await phone.locator('.kpi-tile').evaluateAll(nodes => nodes.map(n => {
  const r = n.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}));
/* Square, within a pixel of rounding. A tile that is three times wider than
   it is tall is the banner these replaced. */
check('every tile is square', tiles.every(t => Math.abs(t.w - t.h) <= 2),
  tiles.map(t => `${t.w}x${t.h}`).join(' '));
/* And sized to their own text: the card saying "5 / registered" must not be
   as wide as the one saying "22 MB / stored". */
check('a tile with less to say is smaller than one with more',
  new Set(tiles.map(t => t.w)).size > 1, tiles.map(t => t.w).join(' '));
await phone.close();

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
stop();
supabase.close();
console.log(problems.length
  ? `\nFAILED: ${problems.join('; ')}`
  : '\nevery figure on the console is counted from real data');
process.exit(problems.length ? 1 : 0);
