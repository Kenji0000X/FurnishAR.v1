/**
 * Protected 3D, preserved intent, and the notification system — end to end.
 *
 * The spec's test cases, driven in a real browser against a fake Supabase
 * that enforces what 0007 enforces:
 *
 *   - GoTrue answers /auth/v1/user only for a live session; logging out
 *     revokes the token on the server, not just in the page.
 *   - Storage signs an object only for a live token AND only if the policy
 *     allows it: a published product's model for any buyer, a draft for
 *     nobody but its own store.
 *
 * If the app ever trusted a hidden button instead of that server answer, the
 * direct-request cases below would start handing out files.
 *
 *   node scripts/check-access.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SUPABASE_PORT = 4701;
const APP_PORT = 4702;
const KEY = 'sb_publishable_accessmock000';
const SUPABASE = `http://127.0.0.1:${SUPABASE_PORT}`;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const STORE = '11111111-1111-4111-8111-111111111111';
const PUBLISHED = '22222222-2222-4222-8222-222222222222';
const DRAFT = '33333333-3333-4333-8333-333333333333';
const PUBLISHED_PATH = `${STORE}/${PUBLISHED}/model.glb`;
const DRAFT_PATH = `${STORE}/${DRAFT}/model.glb`;
const GLB = readFileSync(new URL('../data/models/cane-back-armchair.glb', import.meta.url));

const TOWNS = ['Mamburao', 'Sablayan', 'San Jose'];
const buyers = new Map();          // email -> profile
const passwords = new Map([['ana@example.ph', 'a-good-password']]);
buyers.set('ana@example.ph', { full_name: 'Ana Reyes', municipality: 'Mamburao' });
const live = new Set();            // tokens GoTrue still honours
let storageDown = false;
let dbDown = false;                // TEST 13: the database stops answering
const jwtExpired = new Set();      // tokens PostgREST now refuses as expired
let signed = 0;

const tokenOf = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const emailOf = token => (live.has(token) ? token.replace(/^tok-/, '').replace(/-\d+$/, '') : null);
let issued = 0;
const issue = email => { const token = `tok-${email}-${++issued}`; live.add(token); return token; };

const supabase = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (req.handled) return;   // the signed download, answered below
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const url = req.url;
    const token = tokenOf(req);
    const email = emailOf(token);

    if (url.startsWith('/auth/v1/health')) return req.headers.apikey === KEY ? send(200, {}) : send(401, {});
    if (dbDown && url.startsWith('/rest/v1/')) return send(503, { message: 'upstream connect error' });
    /* A token past its expiry: PostgREST refuses it, and — as when the
       account was signed out elsewhere — GoTrue will not renew it. */
    if (jwtExpired.has(token) && (url.startsWith('/rest/v1/') || url.startsWith('/auth/v1/user'))) {
      return send(401, { code: 'PGRST301', message: 'JWT expired' });
    }
    if (url.includes('grant_type=refresh_token')) {
      return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
    }
    if (url.startsWith('/auth/v1/user')) return email ? send(200, { id: email, email }) : send(401, { message: 'session not found' });
    if (url.includes('grant_type=password')) {
      const { email: who, password } = JSON.parse(raw || '{}');
      if (passwords.get(who) !== password) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      const t = issue(who);
      return send(200, { access_token: t, refresh_token: `${t}-r`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: who, email: who } });
    }
    if (url.startsWith('/auth/v1/signup')) {
      const body = JSON.parse(raw || '{}');
      passwords.set(body.email, body.password);
      if (body.data?.role === 'buyer') buyers.set(body.email, { full_name: body.data.full_name, municipality: body.data.municipality });
      const t = issue(body.email);
      return send(200, { access_token: t, refresh_token: `${t}-r`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: body.email, email: body.email } });
    }
    /* Logout is revocation on the SERVER: the token stops working
       everywhere, not just in the tab that pressed the button. */
    if (url.startsWith('/auth/v1/logout')) { live.delete(token); return send(204); }

    if (url.startsWith('/rest/v1/rpc/my_role')) return send(200, email ? (buyers.has(email) ? 'buyer' : 'pending') : 'guest');
    if (url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, false);
    if (url.startsWith('/rest/v1/municipalities')) return send(200, TOWNS.map(name => ({ name })));
    if (url.startsWith('/rest/v1/buyers')) return send(200, email && buyers.has(email) ? [buyers.get(email)] : []);
    if (url.startsWith('/rest/v1/store_members')) return send(200, []);
    if (url.startsWith('/rest/v1/stores')) return send(200, []);
    if (url.startsWith('/rest/v1/catalog')) {
      /* Only the published piece is in the catalogue — as in the real view. */
      return send(200, [{
        id: PUBLISHED, slug: 'cane-armchair', name: 'Cane Back Armchair',
        store_slug: 'sc-variety', store_id: STORE, store_name: 'S&C Variety Store',
        category: 'Chair', style: 'Modern', color: 'Natural', price_php: 4500, stock: 3,
        width_cm: 62, height_cm: 86, depth_cm: 70, preview_shape: 'chair',
        model_glb_path: PUBLISHED_PATH, model_usdz_path: null,
        bounds_width_cm: 62, bounds_height_cm: 86, bounds_depth_cm: 70,
        description: 'A cane-backed armchair.', featured: true
      }]);
    }

    /* Storage signing: 0007's policy, mirrored. A live token AND a file the
       caller may see. Refused and missing look the same (400 not_found). */
    if (url.startsWith('/storage/v1/object/sign/furniture-models/')) {
      if (storageDown) return send(503, { message: 'down' });
      const path = decodeURIComponent(url.split('/storage/v1/object/sign/furniture-models/')[1].split('?')[0]);
      if (!email) return send(400, { statusCode: '403', error: 'Unauthorized' });
      if (path !== PUBLISHED_PATH) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      signed += 1;
      return send(200, { signedURL: `/object/sign/furniture-models/${path}?token=signed-${signed}` });
    }
    send(404, { message: 'no route' });
  });
});

/* The signed download sits outside the JSON router above. */
supabase.prependListener('request', (req, res) => {
  if (req.method === 'GET' && /\/storage\/v1\/object\/sign\/.+\?token=signed-/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Access-Control-Allow-Origin': '*' });
    res.end(GLB);
    req.handled = true;
  }
});

await new Promise(resolve => supabase.listen(SUPABASE_PORT, resolve));
if (await fetch(`${BASE}/`).then(() => true).catch(() => false)) {
  console.error(`Something is already listening on ${APP_PORT}. Stop it first.`);
  process.exit(1);
}
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: { ...process.env, SUPABASE_URL: SUPABASE, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'access-check' },
  stdio: 'ignore', detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };
/* A check that dies half way must not leave its server holding the port —
   the next run would then refuse to start and report nothing at all. */
const crash = error => { console.error(error); stop(); supabase.close(); process.exit(1); };
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/collection`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

/* /plan and the product pages are prerendered at build time (ISR), and the
   build had no fake Supabase to read, so right after a build they serve the
   BUNDLED catalogue — the demo armchair, whose model is a plain file with
   nothing to authorise. Checking access against that tests nothing: the
   planner never asks, so no alert appears. Wait until both pages carry this
   mock's published piece, and fail loudly if they never do. */
let fresh = false;
for (let i = 0; i < 45 && !fresh; i++) {
  const [plan, piece] = await Promise.all([`${BASE}/plan`, `${BASE}/furniture/cane-armchair`]
    .map(url => fetch(url, { cache: 'no-store' }).then(r => r.text()).catch(() => '')));
  fresh = plan.includes(PUBLISHED) && piece.includes(PUBLISHED);
  if (!fresh) await new Promise(r => setTimeout(r, 2000));
}
if (!fresh) {
  console.error('FAILED: the pages never served the test catalogue — ISR did not regenerate in time.');
  stop();
  supabase.close();
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
/* The planner pulls in three.js and the AR engine; the first request to a
   freshly started server is slow enough to lose a race against a timeout.
   Warm it once, so what follows measures behaviour, not a cold start. */
{
  const warm = await browser.newPage();
  await warm.goto(`${BASE}/plan?product=cane-armchair`, { waitUntil: 'load' }).catch(() => {});
  await warm.waitForTimeout(2500);
  await warm.close();
}
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};
const noNotice = async page => page.evaluate(() => { try { localStorage.setItem('furnishar-storage-notice', 'seen'); } catch {} });
const alertText = page => page.locator('.alert-region').innerText().catch(() => '');
const tokenIn = page => page.evaluate(() => {
  try { return JSON.parse(sessionStorage.getItem('furnishar-sb-session') || 'null')?.access_token || null; } catch { return null; }
});
const askModel = (token, path) => fetch(`${BASE}/api/sb/model/${path}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {}
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null), cache: r.headers.get('cache-control') }));

console.log('--- TEST 01: a guest can read everything that is public ---');
const guest = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const guestModelAsks = [];
guest.on('request', r => { if (r.url().includes('/api/sb/model/')) guestModelAsks.push(r.url()); });
await guest.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await noNotice(guest);
await guest.goto(`${BASE}/furniture/cane-armchair`, { waitUntil: 'domcontentloaded' });
await guest.waitForSelector('.viewer[data-state="locked"]', { timeout: 15000 }).catch(() => {});
const productBody = await guest.locator('body').innerText();
check('product details load for a guest', /Cane Back Armchair/.test(productBody) && /62/.test(productBody));
const html = await guest.content();
check('the page source carries no public URL for the model',
  !/storage\/v1\/object\/public/.test(html) && !html.includes(`${SUPABASE}/storage`));
check('the product viewer says 3D needs an account, instead of failing',
  await guest.locator('.viewer[data-state="locked"]').count() === 1 &&
  /Sign in to view this furniture in 3D/.test(await guest.locator('.viewer-stage').innerText()));
check('and asks the server for nothing — a guest has nothing to trade',
  guestModelAsks.length === 0, guestModelAsks.join(', '));
const viewerLogin = await guest.getAttribute('.viewer-actions a:has-text("Log in")', 'href').catch(() => null);
check('its Log in comes back to this piece', decodeURIComponent(viewerLogin || '').includes('next=/furniture/cane-armchair'), viewerLogin);
check('the measurements stay open to everyone', await guest.locator('.viewer-dims').count() === 1);

console.log('--- the server refuses the file itself, not just the button ---');
const anon = await askModel(null, PUBLISHED_PATH);
check('a guest asking the model endpoint directly is refused', anon.status === 401 && anon.body?.code === 'auth_required',
  `${anon.status} ${anon.body?.code}`);
check('and the answer is never cached by anything shared', /no-store/.test(anon.cache || ''), anon.cache);
const demo = await fetch(`${BASE}/api/demo-model/cane-back-armchair.glb`);
check('the bundled demo model is not a download on a deployment with a database', demo.status === 404, `${demo.status}`);
const oldStatic = await fetch(`${BASE}/models/cane-back-armchair.glb`);
check('and it is no longer a static file in /public', oldStatic.status === 404, `${oldStatic.status}`);

console.log('--- TEST 02/03: asking for 3D opens a gate, not a wall ---');
await guest.click('.product-actions a:has-text("View in my space")');
await guest.waitForSelector('dialog.auth-gate[open]', { timeout: 8000 }).catch(() => {});
check('a guest asking for 3D sees a sign-in gate', await guest.locator('dialog.auth-gate[open]').count() === 1);
check('it says what happened', /Sign in to view this furniture in 3D/.test(await guest.locator('dialog.auth-gate').innerText()));
check('focus lands on the gate heading', await guest.evaluate(() => document.activeElement?.id === 'auth-gate-title'));
const actions = await guest.locator('dialog.auth-gate .confirm-actions > *').allTextContents();
check('with Log in, Create account and Cancel', ['Log in', 'Create account', 'Cancel'].every(label => actions.some(a => a.includes(label))),
  actions.map(a => a.trim()).join(' | '));
check('and the page underneath did not navigate away', new URL(guest.url()).pathname === '/furniture/cane-armchair');
await guest.keyboard.press('Escape');
await guest.waitForTimeout(250);
check('Escape closes it', await guest.locator('dialog.auth-gate[open]').count() === 0);
check('and focus returns to the button that opened it',
  await guest.evaluate(() => /View in my space/.test(document.activeElement?.textContent || '')));

await guest.click('.product-actions a:has-text("View in my space")');
await guest.waitForSelector('dialog.auth-gate[open]');
const loginHref = await guest.getAttribute('dialog.auth-gate a:has-text("Log in")', 'href');
check('Log in carries this exact piece as where to come back to',
  decodeURIComponent(loginHref || '').includes('next=/plan?product=cane-armchair&ar=1'), loginHref);

console.log('--- TEST 04: a wrong password says so, in words ---');
await guest.click('dialog.auth-gate a:has-text("Log in")');
await guest.waitForURL('**/login?**', { timeout: 8000 }).catch(() => {});
await guest.waitForSelector('form.login-form', { timeout: 15000 });
await guest.fill('input[name="email"]', 'ana@example.ph');
await guest.fill('input[name="password"]', 'wrong-password');
await guest.click('form.login-form button[type="submit"]');
await guest.waitForTimeout(1500);
const wrong = await guest.locator('form.login-form .form-error').innerText().catch(() => '');
check('invalid credentials are reported beside the form', /incorrect|invalid|do not match/i.test(wrong), wrong.slice(0, 60));
check('without saying which half was wrong', !/no account|unknown email|wrong password/i.test(wrong));

console.log('--- TEST 05/06: signing in returns to the exact piece, in the planner ---');
await guest.fill('input[name="password"]', 'a-good-password');
await guest.click('form.login-form button[type="submit"]');
await guest.waitForURL('**/plan?**', { timeout: 15000 }).catch(() => {});
const back = new URL(guest.url());
check('the buyer lands back on the piece they asked for, not the home page',
  back.pathname === '/plan' && back.searchParams.get('product') === 'cane-armchair', guest.url());
await guest.waitForTimeout(600);
check('and is welcomed back through the notification system', /Welcome back/.test(await alertText(guest)));
const buyerToken = await tokenIn(guest);
check('an authenticated session exists', Boolean(buyerToken));

/* `next` is a place on THIS site, never a way off it. The backslash and tab
   forms pass a naive "starts with one slash" test and are read by the
   browser as //evil.example. A signed-in buyer is forwarded to `next` as
   soon as the login page loads, so this is where it would bite. */
for (const trick of ['/%5Cevil.example', '/%09/evil.example', '//evil.example', 'https://evil.example']) {
  // A redirect that works interrupts this navigation, so that is not an error here.
  await guest.goto(`${BASE}/login?as=buyer&next=${trick}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await guest.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 8000 }).catch(() => {});
  const landed = new URL(guest.url());
  check(`next=${decodeURIComponent(trick).replace(/\t/, '<tab>')} cannot send a signed-in buyer off the site`,
    landed.origin === BASE && landed.pathname === '/account', guest.url());
}

console.log('--- TEST 08 / 07: authenticated is necessary, not sufficient ---');
const allowed = await askModel(buyerToken, PUBLISHED_PATH);
check('a published piece signs for a signed-in buyer', allowed.status === 200 && /token=signed-/.test(allowed.body?.url || ''),
  `${allowed.status}`);
check('as a short-lived URL', allowed.body?.expiresIn === 300);
const bytes = allowed.body?.url ? await fetch(allowed.body.url).then(r => r.status) : 0;
check('and that URL really downloads the model', bytes === 200, `${bytes}`);
const refused = await askModel(buyerToken, DRAFT_PATH);
check('the SAME signed-in buyer is refused a draft', refused.status === 403 && refused.body?.code === 'unavailable',
  `${refused.status} ${refused.body?.code}`);
check('without the storage error leaking into the answer', !/not_found|Object not found|storage/.test(JSON.stringify(refused.body)));

console.log('--- the product viewer, signed in ---');
await guest.goto(`${BASE}/furniture/cane-armchair`, { waitUntil: 'domcontentloaded' });
await guest.waitForSelector('.viewer[data-state="ready"], .viewer[data-state="failed"], .viewer[data-state="locked"]', { timeout: 30000 }).catch(() => {});
const viewerState = await guest.getAttribute('.viewer', 'data-state').catch(() => null);
check('a signed-in buyer turns the real model on the product page', viewerState === 'ready', viewerState);

console.log('--- TEST 12: a failing 3D server says so, and Try again really retries ---');
storageDown = true;
const planner = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await planner.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await noNotice(planner);
await planner.evaluate(t => sessionStorage.setItem('furnishar-sb-session', JSON.stringify({
  access_token: t, refresh_token: `${t}-r`, expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'ana@example.ph', email: 'ana@example.ph' }
})), buyerToken);
await planner.goto(`${BASE}/plan?product=cane-armchair`, { waitUntil: 'domcontentloaded' });
await planner.waitForSelector('.alert.is-error', { timeout: 30000 }).catch(() => {});
check('the planner says the model could not be loaded', /couldn.t load the 3D model/i.test(await alertText(planner)),
  (await alertText(planner)).slice(0, 80));
storageDown = false;
const retry = planner.locator('.alert .alert-action:has-text("Try again")');
check('with a Try again that is a real control', await retry.count() === 1);
await retry.click().catch(() => {});
await planner.waitForTimeout(1500);
const titles = await planner.locator('.alert:not(.is-leaving) .alert-title').allTextContents();
console.log('      alerts after retry:', JSON.stringify(titles));
check('which re-runs the load and says when it worked', /ready to place/i.test(await alertText(planner)),
  (await alertText(planner)).slice(0, 80));
check('and the failure it fixed is gone, not left beside the success',
  !titles.some(t => /failed/i.test(t)), titles.join(' | '));

console.log('--- TEST 14: a dead network is named for what it is ---');
const offline = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await offline.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await noNotice(offline);
await offline.evaluate(t => sessionStorage.setItem('furnishar-sb-session', JSON.stringify({
  access_token: t, refresh_token: `${t}-r`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'x' }
})), buyerToken);
await offline.route('**/api/sb/model/**', route => route.abort('internetdisconnected'));
await offline.goto(`${BASE}/plan?product=cane-armchair`, { waitUntil: 'domcontentloaded' });
await offline.waitForSelector('.alert', { timeout: 30000 }).catch(() => {});
check('a lost connection reads as a lost connection', /connection failed/i.test(await alertText(offline)),
  (await alertText(offline)).slice(0, 80));
await offline.close();

console.log('--- TEST 13: the database stops answering ---');
const outage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await outage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await noNotice(outage);
await outage.evaluate(t => sessionStorage.setItem('furnishar-sb-session', JSON.stringify({
  access_token: t, refresh_token: `${t}-r`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'x' }
})), buyerToken);
dbDown = true;
await outage.goto(`${BASE}/plan?product=cane-armchair`, { waitUntil: 'domcontentloaded' });
await outage.waitForSelector('text=can’t reach the server', { timeout: 30000 }).catch(() => {});
const outageBody = await outage.locator('main').innerText().catch(() => '');
check('an outage says the server could not be reached', /can.t reach the server/i.test(outageBody), outageBody.slice(0, 80));
check('and is not announced as an expired session', !/session has expired/i.test(await alertText(outage)));
check('nor answered with a sign-in form', !/Sign in to measure your space/.test(outageBody));
check('the sign-in is kept through it', Boolean(await tokenIn(outage)));
dbDown = false;
await outage.click('button:has-text("Try again")').catch(() => {});
await outage.waitForSelector('#ar-button', { timeout: 30000 }).catch(() => {});
check('and Try again opens the planner once it is back', await outage.locator('#ar-button').count() === 1);
await outage.close();

console.log('--- TEST 10/11: logging out invalidates the session on the server ---');
await guest.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
await guest.waitForSelector('button:has-text("Sign out")', { timeout: 15000 });
await guest.click('button:has-text("Sign out")');
await guest.waitForTimeout(1200);
check('signing out is confirmed', /signed out/i.test(await alertText(guest)));
const after = await askModel(buyerToken, PUBLISHED_PATH);
check('the OLD token is now refused by the server, not just forgotten by the page',
  after.status === 401 && after.body?.code === 'session_expired', `${after.status} ${after.body?.code}`);

console.log('--- TEST 09: an expired session says so, and the way back keeps your place ---');
await planner.goto(`${BASE}/plan?product=cane-armchair`, { waitUntil: 'domcontentloaded' });
await planner.waitForSelector('.alert.is-warning, .alert[data-priority="critical"]', { timeout: 30000 }).catch(() => {});
check('a revoked session is told it has expired', /session has expired/i.test(await alertText(planner)),
  (await alertText(planner)).slice(0, 80));
const again = await planner.getAttribute('.alert-action:has-text("Sign in again")', 'href').catch(() => null);
check('and "Sign in again" returns to this same piece', decodeURIComponent(again || '').includes('next=/plan?product=cane-armchair'), again);
check('it stays until dismissed rather than timing out',
  await planner.locator('.alert[data-priority="critical"]').count() >= 1);

console.log('--- TEST 09, as it really happens: the token runs out and renewal is refused ---');
const stale = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await stale.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await noNotice(stale);
const lapsedToken = issue('ana@example.ph');
jwtExpired.add(lapsedToken);
await stale.evaluate(t => sessionStorage.setItem('furnishar-sb-session', JSON.stringify({
  access_token: t, refresh_token: `${t}-r`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'x' }
})), lapsedToken);
await stale.goto(`${BASE}/plan?product=cane-armchair`, { waitUntil: 'domcontentloaded' });
await stale.waitForSelector('.alert[data-priority="critical"]', { timeout: 30000 }).catch(() => {});
check('a session whose renewal was refused is told it expired, not treated as a first visit',
  /session has expired/i.test(await alertText(stale)), (await alertText(stale)).slice(0, 80));
check('and the dead session is dropped', !(await tokenIn(stale)));
await stale.close();

console.log('--- the notification system itself ---');
check('there are two live regions, polite and assertive',
  await planner.locator('.alert-region [role="status"][aria-live="polite"]').count() === 1 &&
  await planner.locator('.alert-region [role="alert"][aria-live="assertive"]').count() === 1);
const before = await planner.locator('.alert').count();
await planner.click('.alert-close').catch(() => {});
await planner.waitForTimeout(400);
check('the dismiss button dismisses', await planner.locator('.alert').count() === before - 1);

console.log('--- the notifications on a phone ---');
const phone = await browser.newPage({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await noNotice(phone);
await phone.evaluate(t => sessionStorage.setItem('furnishar-sb-session', JSON.stringify({
  access_token: t, refresh_token: `${t}-r`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'x' }
})), buyerToken);
await phone.goto(`${BASE}/plan?product=cane-armchair`, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.alert', { timeout: 30000 }).catch(() => {});
const fit = await phone.evaluate(() => {
  const a = document.querySelector('.alert')?.getBoundingClientRect();
  const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
  return a ? {
    inside: a.left >= 0 && a.right <= window.innerWidth,
    clearOfNav: !nav || a.bottom <= nav.top,
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth
  } : null;
});
check('an alert fits a 320px screen', fit?.inside && fit.over <= 0, JSON.stringify(fit));
check('and does not cover the bottom navigation', fit?.clearOfNav);
const close = await phone.locator('.alert-close').first().boundingBox();
check('its dismiss control is a thumb-sized target', close && close.width >= 44 && close.height >= 44,
  close ? `${Math.round(close.width)}x${Math.round(close.height)}` : 'none');

const small = await browser.newPage({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
await small.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await noNotice(small);
await small.goto(`${BASE}/furniture/cane-armchair`, { waitUntil: 'domcontentloaded' });
await small.waitForSelector('.viewer[data-state="locked"]', { timeout: 15000 }).catch(() => {});
const gateFit = await small.evaluate(() => {
  const stage = document.querySelector('.viewer-stage')?.getBoundingClientRect();
  const ways = [...document.querySelectorAll('.viewer-actions a')].map(a => a.getBoundingClientRect());
  const box = r => [r.left, r.top, r.right, r.bottom].map(Math.round).join(',');
  return stage && ways.length === 2 ? {
    inside: ways.every(r => r.left >= stage.left && r.right <= stage.right && r.top >= stage.top && r.bottom <= stage.bottom),
    tall: ways.every(r => r.height >= 44),
    stage: box(stage), ways: ways.map(box)
  } : null;
});
if (process.env.ACCESS_SHOTS) await small.locator('.viewer').screenshot({ path: `${process.env.ACCESS_SHOTS}/viewer-locked-320.png` });
check('on a 320px phone the viewer\'s sign-in buttons fit inside it', gateFit?.inside, JSON.stringify(gateFit));
check('and are thumb-sized', gateFit?.tall);

await browser.close();
stop();
supabase.close();
console.log(problems.length
  ? `\nFAILED: ${problems.join('; ')}`
  : '\nprotected 3D, preserved intent and every alert behave as specified');
process.exit(problems.length ? 1 : 0);
