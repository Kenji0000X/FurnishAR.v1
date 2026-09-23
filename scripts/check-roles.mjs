/**
 * Two kinds of account, one door, and the line between browsing and using.
 *
 * FurnishAR had exactly one sign-in and it was the store owner's — "sign in"
 * anywhere on the site meant "sign in to sell something", and shoppers had no
 * accounts at all. This drives the new arrangement the way a person meets it:
 * arrive at /login, say which you are, create a shopper account, and find the
 * planner open afterwards and shut before.
 *
 * The fake Supabase here enforces what 0006 enforces: my_role() answers from
 * what the tables hold, the buyers row is written from the sign-up metadata
 * rather than by a second call from the browser, and an address that already
 * sells cannot also shop.
 *
 *   node scripts/check-roles.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SUPABASE_PORT = 4621;
const APP_PORT = 4622;
const KEY = 'sb_publishable_rolesmock0000';

const TOWNS = ['Abra de Ilog', 'Calintaan', 'Looc', 'Lubang', 'Magsaysay',
  'Mamburao', 'Paluan', 'Rizal', 'Sablayan', 'San Jose', 'Santa Cruz'];

/* Who exists. A shopper, a store owner, and the address of an owner that a
   shopper must not be able to reuse. */
const buyers = new Map();           // token -> { full_name, municipality }
const owners = new Set(['owner@shop.ph']);
const tokenFor = email => `token-${email}`;
const emailFor = req => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  return auth.startsWith('token-') ? auth.slice(6) : null;
};

const signups = [];

const supabase = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const email = emailFor(req);

    if (req.url.startsWith('/auth/v1/health')) {
      return req.headers.apikey === KEY ? send(200, { name: 'GoTrue' }) : send(401, {});
    }
    if (req.url.startsWith('/auth/v1/user')) {
      return email ? send(200, { id: email, email }) : send(401, { message: 'no' });
    }

    if (req.url.startsWith('/auth/v1/signup')) {
      const payload = JSON.parse(raw || '{}');
      signups.push(payload);
      const data = payload.data || {};
      /* 0006's trigger, mirrored: the buyers row is written here, from the
         account's own metadata, in the same breath as the account. Nothing
         the browser sends afterwards creates it. */
      if (data.role === 'buyer') {
        if (owners.has(payload.email)) {
          return send(400, { message: 'This address has already applied to sell on FurnishAR.' });
        }
        if (!data.full_name || !data.municipality) {
          return send(400, { message: 'A shopper account needs a name and a municipality.' });
        }
        if (!TOWNS.includes(data.municipality)) {
          return send(400, { message: `Unknown municipality: ${data.municipality}` });
        }
        buyers.set(payload.email, {
          full_name: data.full_name, municipality: data.municipality
        });
      }
      const token = tokenFor(payload.email);
      return send(200, {
        access_token: token, refresh_token: `${token}-r`,
        user: { id: payload.email, email: payload.email }
      });
    }

    if (req.url.includes('grant_type=password')) {
      const payload = JSON.parse(raw || '{}');
      const token = tokenFor(payload.email);
      return send(200, {
        access_token: token, refresh_token: `${token}-r`,
        user: { id: payload.email, email: payload.email }
      });
    }
    if (req.url.startsWith('/auth/v1/logout')) return send(204, {});

    /* my_role(): answered from the tables, never from what a browser claims. */
    if (req.url.startsWith('/rest/v1/rpc/my_role')) {
      if (!email) return send(200, 'guest');
      if (owners.has(email)) return send(200, 'owner');
      if (buyers.has(email)) return send(200, 'buyer');
      return send(200, 'pending');
    }
    if (req.url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, false);

    if (req.url.startsWith('/rest/v1/municipalities')) {
      return send(200, TOWNS.map(name => ({ name })));
    }

    if (req.url.startsWith('/rest/v1/buyers')) {
      if (!email || !buyers.has(email)) return send(200, []);
      if (req.method === 'PATCH') {
        buyers.set(email, { ...buyers.get(email), ...JSON.parse(raw || '{}') });
        return send(204, null);
      }
      return send(200, [{ ...buyers.get(email), created_at: new Date().toISOString() }]);
    }

    /* A catalogue with something in it, so "browsing needs no account" is a
       claim about the app rather than about an empty fixture. */
    if (req.url.startsWith('/rest/v1/catalog') || req.url.startsWith('/rest/v1/products')) {
      /* The shape public.catalog really has — see toProduct() in
         lib/catalog.mjs. A row in any other shape renders an empty grid and
         the check below would be measuring this fixture, not the app. */
      return send(200, [{
        id: 'p1', slug: 'armchair-cane-back', name: 'Cane Back Armchair',
        store_slug: 'sc-variety', store_id: 's1', store_name: 'S&C Variety Store',
        category: 'Chair', style: 'Modern', color: 'Natural',
        price_php: 4500, stock: 3,
        width_cm: 62, height_cm: 86, depth_cm: 70,
        preview_shape: 'chair',
        model_glb_path: 's1/p1/armchair.glb', model_usdz_path: null,
        bounds_width_cm: 62, bounds_height_cm: 86, bounds_depth_cm: 70,
        description: 'A cane-backed armchair.', featured: true
      }]);
    }

    if (req.url.startsWith('/rest/v1/store_members')) {
      return send(200, email && owners.has(email)
        ? [{ role: 'owner', stores: { id: 's1', slug: 'shop', name: 'A Shop', plan: 'freemium' } }]
        : []);
    }
    send(200, []);
  });
});

await new Promise(resolve => supabase.listen(SUPABASE_PORT, resolve));

if (await fetch(`http://127.0.0.1:${APP_PORT}/login`).then(() => true).catch(() => false)) {
  console.error(`Something is already listening on ${APP_PORT}. Stop it first.`);
  process.exit(1);
}

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: KEY,
    FURNISHAR_JWT_SECRET: 'roles-check-secret'
  },
  stdio: 'ignore',
  detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/login`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};
const BASE = `http://127.0.0.1:${APP_PORT}`;

console.log('--- browsing stays open to everyone ---');
{
  /* The line this draws: a site you cannot look at is a site nobody shares.
     The catalogue is open; the planner is what the account is for. */
  const page = await browser.newPage();
  for (const [path, what] of [['/', 'the home page'], ['/collection', 'the catalogue'], ['/faq', 'the questions']]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    check(`${what} needs no account`,
      new URL(page.url()).pathname === path && !(await page.locator('form.login-form').count()),
      page.url());
  }
  /* Back to the catalogue to count it: the loop above ends on /faq, and
     "no product cards on the questions page" is not the claim being made. */
  await page.goto(`${BASE}/collection`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  check('and the catalogue really has the furniture in it',
    await page.locator('.product-card').count() > 0,
    `${await page.locator('.product-card').count()} cards`);
  await page.close();
}

console.log('--- the planner asks who you are ---');
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  check('a signed-out visitor is asked to sign in', /Sign in to measure your space/i.test(body));
  /* It must not flash the planner first. Nobody should see a camera prompt
     and then have it taken away. */
  check('and the planner itself is not rendered behind the panel',
    await page.locator('.planner-view .product-grid, .measure-surface').count() === 0);
  /* Compared decoded: `next` is URL-encoded so a query inside it
     (?product=…) survives the trip instead of being split off. */
  const wayIn = await page.getAttribute('.panel-actions a.button-primary', 'href');
  check('the way in carries where you were going',
    decodeURIComponent(wayIn || '') === '/login?as=buyer&next=/plan', wayIn);
  await page.close();
}

console.log('--- the door asks which kind of person you are ---');
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.role-card', { timeout: 20000 });
  check('two choices, not one', await page.locator('.role-card').count() === 2,
    `${await page.locator('.role-card').count()}`);
  const text = await page.locator('.role-cards').innerText();
  check('one of them is the shopper', /shopping for furniture/i.test(text));
  check('the other is the store owner', /run a furniture store/i.test(text));
  check('and the store owner is sent to the portal',
    await page.getAttribute('.role-cards a.role-card', 'href') === '/portal');

  /* The choice lives in the URL, so it can be linked to and the Back button
     undoes it rather than trapping someone in the wrong form. */
  await page.click('.role-card:has-text("shopping for furniture")');
  await page.waitForURL('**/login?as=buyer', { timeout: 8000 }).catch(() => {});
  check('choosing shopper is reflected in the URL', page.url().includes('as=buyer'), page.url());
  check('and it shows a shopper form, not a store form',
    await page.locator('input[name="fullName"], input[name="email"]').count() > 0 &&
    await page.locator('input[name="storeName"]').count() === 0);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  check('Back returns to the question', await page.locator('.role-card').count() === 2);
  await page.close();
}

console.log('--- creating a shopper account ---');
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/login?as=buyer`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mode-switch', { timeout: 20000 });
  await page.click('.mode-option:has-text("Create account")');
  await page.waitForSelector('input[name="fullName"]');

  /* The towns come from the database, not from a copy in the page. A
     hard-coded list that drifted would offer a town the column's foreign key
     then refuses — an error at the last step, about a menu we handed them. */
  const options = await page.locator('select[name="municipality"] option').allTextContents();
  check('the municipality list came from the database',
    options.includes('Mamburao') && options.includes('Sablayan'),
    `${options.length - 1} towns`);

  await page.fill('input[name="fullName"]', 'Ana Reyes');
  await page.fill('input[name="email"]', 'ana@example.ph');
  await page.selectOption('select[name="municipality"]', 'Mamburao');
  await page.fill('input[name="password"]', 'a-good-password');
  await page.click('form.login-form button[type="submit"]');
  await page.waitForURL('**/account', { timeout: 15000 }).catch(() => {});
  check('signing up lands on the shopper account page',
    new URL(page.url()).pathname === '/account', page.url());
  await page.waitForTimeout(800);
  const body = await page.locator('body').innerText();
  check('which greets them by the name they gave', /Ana Reyes/.test(body));
  check('and holds the town they chose',
    await page.inputValue('select[name="municipality"]') === 'Mamburao');

  /* Three things that compile perfectly and look broken.
     The page had no container at all, so the heading sat hard against the
     left edge of the screen; the municipality select was never added to the
     form-control rule, so it inherited its LABEL's mono uppercase styling and
     the browser's native control; and the hint under it read as a second
     label rather than a sentence. */
  const layout = await page.evaluate(() => {
    const h1 = document.querySelector('.account-view h1');
    const select = document.querySelector('select[name="municipality"]');
    const hint = document.querySelector('.field-hint');
    const s = getComputedStyle(select);
    return {
      left: Math.round(h1.getBoundingClientRect().left),
      selectTransform: s.textTransform,
      selectFont: s.fontFamily,
      hintTransform: getComputedStyle(hint).textTransform
    };
  });
  check('the page has a gutter rather than starting at the screen edge',
    layout.left >= 16, `${layout.left}px from the left`);
  check('the municipality select is styled like the rest of the form',
    layout.selectTransform === 'none', layout.selectTransform);
  check('and the hint under it reads as a sentence, not a label',
    layout.hintTransform === 'none', layout.hintTransform);

  /* Buttons sized to their labels, not to the panel.
     .login-form is a grid, so anything dropped into it stretches to the full
     column. That is right for the inputs and wrong for everything else: the
     account page borrowed it to lay out "Open the planner", "Browse the
     catalogue" and "Sign out", and got three 498px stacked pills. A control
     roughly as wide as the panel reads as a banner, and three of them read as
     a wall. */
  const sizes = await page.evaluate(() => {
    const panel = document.querySelector('.account-view');
    const width = panel.getBoundingClientRect().width;
    return [...document.querySelectorAll('.panel-actions .button, .login-form button[type=submit]')]
      .map(el => ({
        t: (el.textContent || '').trim().slice(0, 24),
        w: Math.round(el.getBoundingClientRect().width),
        share: el.getBoundingClientRect().width / width
      }));
  });
  check('no button on the account page spans the panel',
    sizes.every(s => s.share < 0.45),
    sizes.map(s => `${s.t} ${s.w}px`).join(' | '));
  /* Still comfortably usable. BRAND.md: 44px on a coarse pointer; with a
     mouse the buttons are deliberately compact, and the floor there is
     WCAG 2.2 AA's 24px. (The 44px touch floor is measured on a real touch
     context in check:access.) */
  const tall = await page.evaluate(() => {
    const floor = matchMedia('(pointer: coarse)').matches ? 44 : 24;
    return [...document.querySelectorAll('.panel-actions .button, .login-form button[type=submit]')]
      .every(el => el.getBoundingClientRect().height >= floor);
  });
  check('and they are all still tall enough for the pointer (44px touch, 24px mouse)', tall);

  /* No link on the site should fall through to the browser's default blue —
     FurnishAR has no global anchor colour, and these panels are the first
     place with links inside a sentence. */
  const blue = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.login-panel a, .role-foot a, .demo-note a')];
    return nodes.map(a => getComputedStyle(a).color)
      .filter(c => /rgb\(0,\s*0,\s*238\)|rgb\(0,\s*0,\s*255\)/.test(c));
  });
  check('no prose link is left at the browser default blue', blue.length === 0,
    blue.join(', '));

  /* One write, not two: the name and town rode along as account metadata so
     the row exists in the same transaction as the account. */
  const signup = signups.find(s => s.email === 'ana@example.ph');
  check('the account carried its own profile with it',
    signup?.data?.role === 'buyer' && signup?.data?.full_name === 'Ana Reyes'
      && signup?.data?.municipality === 'Mamburao',
    JSON.stringify(signup?.data));

  console.log('--- and now the planner opens ---');
  await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('the same person can now measure their space',
    !/Sign in to measure your space/i.test(await page.locator('body').innerText()));
  check('and the planner is actually there',
    await page.locator('.planner-view').count() > 0);

  console.log('--- signing out ---');
  await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("Sign out")', { timeout: 15000 });
  await page.click('button:has-text("Sign out")');
  await page.waitForTimeout(1200);
  await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('and the planner is shut again afterwards',
    /Sign in to measure your space/i.test(await page.locator('body').innerText()));
  await page.close();
}

console.log('--- a store owner who came through the shopper door ---');
{
  /* Pressing "I'm shopping" does not make you a shopper. The server is asked
     what the account IS, and an owner is sent to their own portal rather
     than into an account page with nothing in it. */
  const page = await browser.newPage();
  await page.goto(`${BASE}/login?as=buyer`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  await page.fill('input[name="email"]', 'owner@shop.ph');
  await page.fill('input[name="password"]', 'whatever');
  await page.click('form.login-form button[type="submit"]');
  await page.waitForURL('**/portal', { timeout: 15000 }).catch(() => {});
  check('an owner signing in here lands in the store portal',
    new URL(page.url()).pathname === '/portal', page.url());

  await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  /* Said plainly rather than silently redirected: a bounce reads exactly like
     being logged into the wrong account. */
  check('and the shopper page tells them plainly why it is empty for them',
    /sells on FurnishAR/i.test(body), body.split('\n').slice(0, 3).join(' | '));
  check('with the way to their own side of the site',
    await page.locator('a[href="/portal"]').count() > 0);
  await page.close();
}

console.log('--- one account, one role ---');
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/login?as=buyer`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.mode-switch', { timeout: 20000 });
  await page.click('.mode-option:has-text("Create account")');
  await page.waitForSelector('input[name="fullName"]');
  await page.fill('input[name="fullName"]', 'Sneaky Seller');
  await page.fill('input[name="email"]', 'owner@shop.ph');
  await page.selectOption('select[name="municipality"]', 'Sablayan');
  await page.fill('input[name="password"]', 'a-good-password');
  await page.click('form.login-form button[type="submit"]');
  await page.waitForTimeout(1500);
  check('an address that already sells cannot also sign up to shop',
    /already applied to sell/i.test(await page.locator('.login-form').innerText()),
    (await page.locator('.form-error').first().innerText()).slice(0, 70));
  check('and it did not quietly land them somewhere anyway',
    new URL(page.url()).pathname === '/login', page.url());
  await page.close();
}

console.log('--- the way in is findable ---');
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('the header carries an account link',
    await page.getAttribute('.account-link', 'href') === '/account');
  await page.click('.nav-burger');
  await page.waitForSelector('.drawer-panel');
  const routes = await page.locator('.drawer-link code').allTextContents();
  check('the drawer offers /login', routes.includes('/login'), routes.join(' · '));
  check('and /account', routes.includes('/account'));
  await page.keyboard.press('Escape');

  const phone = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await phone.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('the phone bar reaches the account too',
    await phone.getAttribute('.bottom-nav-item:has-text("Account")', 'href') === '/account');
  /* The shopper's bar should not be a door into the store owner's portal. */
  check('and no longer points shoppers at the store portal',
    await phone.locator('.bottom-nav-item[href="/portal"]').count() === 0);
  await phone.close();
  await page.close();
}

console.log('--- with no database at all ---');
{
  /* FurnishAR runs on the bundled catalogue when Supabase is not configured.
     In that state there are no accounts to require, and gating the planner on
     one would make it permanently unreachable. This is checked against a
     separate server with no credentials. */
  const bare = spawn('npx', ['next', 'start', '-p', '4623'], {
    env: { ...process.env, SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', FURNISHAR_JWT_SECRET: 'x' },
    stdio: 'ignore', detached: true
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch('http://127.0.0.1:4623/plan')).ok) break; } catch { /* waiting */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4623/plan', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  check('the planner opens when there are no accounts to require',
    !/Sign in to measure your space/i.test(await page.locator('body').innerText()));
  await page.close();
  try { process.kill(-bare.pid, 'SIGTERM'); } catch { bare.kill(); }
}

await browser.close();
stop();
supabase.close();
console.log(problems.length
  ? `\nFAILED: ${problems.join('; ')}`
  : '\nboth doors lead where they say they do');
process.exit(problems.length ? 1 : 0);
