/**
 * What does the portal actually SAY when Supabase rejects a sign-up or sign-in?
 *
 * The real project cannot be reached from CI, and the failures that matter are
 * error paths, so this stands up a fake GoTrue/PostgREST that returns the exact
 * shapes Supabase sends — including the empty-bodied 429 that used to surface
 * as "[object Object]" — and reads the message off the rendered page.
 *
 * Usage: node scripts/check-auth-errors.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SUPABASE_PORT = 4471;
const APP_PORT = 4472;

/** The scenario the next auth call should answer with. */
let scenario = 'ok';
const calls = [];

const supabase = createServer((req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === null ? '' : JSON.stringify(body));
  };
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    calls.push({ url: req.url, method: req.method, headers: req.headers });

    if (req.url.startsWith('/auth/v1/signup') || req.url.includes('grant_type=password')) {
      if (scenario === 'rate-limit-empty') return send(429, null);          // no body at all
      if (scenario === 'rate-limit-seconds') {
        return send(429, { code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 51 seconds.' }, { 'Retry-After': '51' });
      }
      if (scenario === 'invalid-email') {
        return send(400, { code: 'email_address_invalid', msg: 'Unable to validate email address: invalid format' });
      }
      if (scenario === 'already-registered') {
        return send(422, { code: 'user_already_exists', msg: 'User already registered' });
      }
      if (scenario === 'bad-credentials') {
        return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      // Success: a confirmed-email project returns a user but no session.
      return send(200, { user: { id: 'u1', email: 'new@shop.ph' } });
    }

    // PostgREST: the store_applications insert.
    if (req.url.startsWith('/rest/v1/store_applications')) {
      if (scenario === 'application-fails') {
        return send(400, { code: '42501', message: 'new row violates row-level security policy' });
      }
      return send(201, null);
    }
    // GoTrue answers a sign-out with 204 No Content — no body at all. That
    // is not a detail: a 204 may not carry one, so building the proxy's reply
    // with Response.json() threw, and every sign-out came back 500.
    if (req.url.startsWith('/auth/v1/logout')) {
      res.writeHead(204);
      return res.end();
    }
    if (req.url.startsWith('/auth/v1/health')) {
      // Supabase answers 401 without a valid apikey, whatever the project's
      // state — which is why the probe has to send one.
      if (req.headers.apikey !== 'sb_publishable_mockkey000000000') {
        return send(401, { message: 'Invalid API key' });
      }
      return send(200, { name: 'GoTrue' });
    }
    if (req.url.startsWith('/rest/v1/catalog')) return send(200, []);
    if (req.url.startsWith('/rest/v1/stores')) return send(200, []);
    return send(200, []);
  });
});

await new Promise(resolve => supabase.listen(SUPABASE_PORT, resolve));

/**
 * Refuse to run against somebody else's server.
 *
 * `next start` on a taken port exits, and the wait loop below then happily
 * finds the *old* server answering — which cost an hour of chasing a failure
 * that was really a stale build from a previous run. Fail loudly instead.
 */
for (const port of [APP_PORT, APP_PORT + 1]) {
  const stale = await fetch(`http://127.0.0.1:${port}/portal`).then(() => true).catch(() => false);
  if (stale) {
    console.error(`Something is already listening on ${port}. Stop it first — otherwise this ` +
      'check silently tests whatever that is, not the build you just made.');
    process.exit(1);
  }
}


/**
 * `next start` is a launcher: killing it leaves the real `next-server` child
 * holding the port, which then answers the *next* run of this script from a
 * stale build. Spawning into its own process group and signalling the group is
 * what actually stops it.
 */
const serve = (port, env) => spawn('npx', ['next', 'start', '-p', String(port)], {
  env: { ...process.env, ...env }, stdio: 'ignore', detached: true
});
const stop = child => { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } };

const app = serve(APP_PORT, {
  SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_mockkey000000000',
  FURNISHAR_JWT_SECRET: 'auth-error-check-secret'
});

const ready = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/portal`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
};
if (!await ready()) {
  console.error('the app did not start');
  stop(app);
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const problems = [];

async function run(label, { which, setUp, expect }) {
  scenario = setUp;
  calls.length = 0;
  const page = await browser.newPage();
  // A failure here is usually the browser telling you exactly what went wrong
  // in a console warning nobody was listening to.
  const noise = [];
  page.on('console', m => { if (m.type() !== 'log') noise.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => noise.push(`pageerror: ${e.message}`));
  page.on('requestfinished', async r => {
    if (r.url().includes('/api/sb/')) {
      noise.push(`${r.method()} ${r.url().replace(/^.*\/api\/sb/, '')} -> ${(await r.response())?.status()}`);
    }
  });
  await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });

  if (which === 'signup') {
    await page.click('button:has-text("New store? Sign up")');
    await page.waitForSelector('input[name="storeName"]');
    await page.fill('input[name="storeName"]', 'Mock Furniture');
    await page.fill('input[name="email"]', 'new@shop.ph');
    await page.fill('input[name="password"]', 'a-long-password');
    await page.fill('input[name="phone"]', '+63431234567');
  } else {
    await page.fill('input[name="email"]', 'owner@furnishar.ph');
    await page.fill('input[name="password"]', 'furnishar');
  }

  await page.click('form.login-form button[type="submit"]');
  await page.waitForTimeout(1800);

  const shown = (await page.locator('form.login-form .form-error').textContent()) || '';
  const buttonText = (await page.locator('form.login-form button[type="submit"]').textContent()) || '';
  const disabled = await page.locator('form.login-form button[type="submit"]').isDisabled();

  const ok = expect(shown.trim(), { buttonText: buttonText.trim(), disabled, calls: [...calls] });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  console.log(`       message: "${shown.trim()}"`);
  console.log(`       button : "${buttonText.trim()}"${disabled ? ' (disabled)' : ''}`);
  if (!ok) {
    problems.push(label);
    for (const line of noise) console.log(`       ${line}`);
  }
  await page.close();
}

const noJunk = text =>
  text && !/\[object Object\]/.test(text) && text !== 'null' && text !== 'undefined' && text !== '{}';

console.log('--- sign-up error paths ---');
await run('empty-bodied 429 does not show "[object Object]"', {
  which: 'signup', setUp: 'rate-limit-empty',
  expect: (text, { disabled }) => noJunk(text) && /too many|wait/i.test(text) && disabled
});
await run('429 with a wait tells the user how long, and holds the button', {
  which: 'signup', setUp: 'rate-limit-seconds',
  expect: (text, { buttonText, disabled }) =>
    noJunk(text) && /51 seconds/.test(text) && disabled && /Try again in \d+s/.test(buttonText)
});
await run('400 invalid email explains itself', {
  which: 'signup', setUp: 'invalid-email',
  expect: text => noJunk(text) && /typo|rejected/i.test(text)
});
await run('already-registered points at sign-in', {
  which: 'signup', setUp: 'already-registered',
  expect: text => noJunk(text) && /sign in/i.test(text)
});
await run('a failed application does NOT report the account as failed', {
  which: 'signup', setUp: 'application-fails',
  expect: (text, { calls: made }) =>
    noJunk(text) &&
    /account created/i.test(text) &&
    /do not sign up again/i.test(text) &&
    made.filter(c => c.url.includes('signup')).length === 1
});

console.log('--- online sign-up actually creates an account ---');
await run('a successful sign-up calls Supabase and files the store application', {
  which: 'signup', setUp: 'ok',
  expect: (text, { calls: made }) => {
    const signups = made.filter(c => c.url.includes('/auth/v1/signup'));
    const applications = made.filter(c => c.url.includes('store_applications'));
    return /account created/i.test(text)
      && !/email hello@/i.test(text)          // not the manual fallback
      && signups.length === 1
      && applications.length === 1;
  }
});

console.log('--- misconfiguration is reported, not crashed ---');
{
  // A secret key where the publishable one belongs used to throw inside the
  // route and reach the browser as a bare 500 with an empty body.
  const misconfigured = serve(APP_PORT + 1, {
    SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: 'sb_secret_shouldNeverBeAccepted',
    FURNISHAR_JWT_SECRET: 'auth-error-check-secret'
  });
  let response = null;
  for (let i = 0; i < 40; i++) {
    try {
      response = await fetch(`http://127.0.0.1:${APP_PORT + 1}/api/sb/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.ph', password: 'longenough' })
      });
      break;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  const body = response ? await response.json().catch(() => ({})) : {};
  const ok = response?.status === 503 && /secret\/service_role key/i.test(body.error || '');
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} a secret key gives 503 and names the variable, not a bare 500`);
  console.log(`       status ${response?.status}: "${(body.error || '').slice(0, 80)}…"`);
  if (!ok) problems.push('secret key should give a readable 503');
  stop(misconfigured);
}

console.log('--- request shape ---');
await run('the key goes in apikey, never as a Bearer JWT, and never to the browser', {
  which: 'login', setUp: 'bad-credentials',
  expect: (text, { calls: made }) => {
    const authCalls = made.filter(c => c.url.includes('grant_type=password'));
    if (!authCalls.length) return false;
    return authCalls.every(c =>
      c.headers.apikey === 'sb_publishable_mockkey000000000' && !c.headers.authorization);
  }
});

console.log('--- sign-in error paths ---');
await run('bad credentials read plainly', {
  which: 'login', setUp: 'bad-credentials',
  expect: text => noJunk(text) && /do not match/i.test(text)
});
await run('sign-in rate limit is handled too', {
  which: 'login', setUp: 'rate-limit-empty',
  expect: (text, { disabled }) => noJunk(text) && /too many|wait/i.test(text) && disabled
});

console.log('--- signing out ---');
{
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) problems.push(label);
  };
  // Straight at the proxy: the browser clears its own session whatever this
  // returns, so a 500 here was invisible in the UI and showed up only as a
  // console error and a refresh token left alive at Supabase.
  const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/sb/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: 'whatever' })
  });
  const body = await response.text();
  check('a sign-out is not a 500', response.status !== 500, `HTTP ${response.status}`);
  check('it passes GoTrue\'s 204 through as a 204', response.status === 204, `HTTP ${response.status}`);
  check('and sends no body with it, as 204 requires', body === '', JSON.stringify(body.slice(0, 40)));
}

await browser.close();
stop(app);
supabase.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nall auth error checks passed');
process.exit(problems.length ? 1 : 0);
