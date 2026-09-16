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
    if (req.url.startsWith('/rest/v1/catalog')) return send(200, []);
    if (req.url.startsWith('/rest/v1/stores')) return send(200, []);
    return send(200, []);
  });
});

await new Promise(resolve => supabase.listen(SUPABASE_PORT, resolve));

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_mockkey000000000',
    FURNISHAR_JWT_SECRET: 'auth-error-check-secret'
  },
  stdio: 'ignore'
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
  app.kill();
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const problems = [];

async function run(label, { which, setUp, expect }) {
  scenario = setUp;
  calls.length = 0;
  const page = await browser.newPage();
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
  if (!ok) problems.push(label);
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

console.log('--- misconfiguration is reported, not crashed ---');
{
  // A secret key where the publishable one belongs used to throw inside the
  // route and reach the browser as a bare 500 with an empty body.
  const misconfigured = spawn('npx', ['next', 'start', '-p', String(APP_PORT + 1)], {
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
      SUPABASE_PUBLISHABLE_KEY: 'sb_secret_shouldNeverBeAccepted',
      FURNISHAR_JWT_SECRET: 'auth-error-check-secret'
    },
    stdio: 'ignore'
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
  misconfigured.kill();
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

await browser.close();
app.kill();
supabase.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nall auth error checks passed');
process.exit(problems.length ? 1 : 0);
