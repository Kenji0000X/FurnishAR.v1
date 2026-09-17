/**
 * Does a session survive several requests expiring at the same moment?
 *
 * GoTrue ROTATES refresh tokens: spending R1 issues R2 and invalidates R1. The
 * portal and the console both fire several requests at once, so when a token
 * expires they all 401 together and all reach for the same R1. Before
 * refreshSession() was single-flighted, the first won and the rest came back
 * with GoTrue's `400 Invalid Refresh Token: Already Used` — surfaced to the
 * owner as a bare "JWT expired" mid-save, and able to wipe the good session
 * the winner had just stored. That is the 401 -> refresh 400 -> 401 loop that
 * was reported from production.
 *
 * The mock below rotates tokens exactly as GoTrue does, so this fails if the
 * guard is ever removed.
 *
 *   node scripts/check-session-refresh.mjs
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SB = 4901, APP = 4902, KEY = 'sb_publishable_refreshrepro00';
const STORE = '21f61742-6d5d-4239-9592-05b2a79a0453';

let validAccess = 'access-1';       // rotates on refresh
let validRefresh = 'refresh-1';
const spentRefreshTokens = new Set();
const refreshCalls = [];

const sb = createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    const send = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    const auth = req.headers.authorization || '';

    if (req.url.startsWith('/auth/v1/health')) return send(200, { name: 'GoTrue' });
    if (req.url.startsWith('/auth/v1/user')) {
      return auth.includes(validAccess) ? send(200, { id: 'u1', email: 'owner@furnishar.ph' }) : send(401, {});
    }
    if (req.url.includes('grant_type=password')) {
      return send(200, { access_token: validAccess, refresh_token: validRefresh, user: { id: 'u1', email: 'owner@furnishar.ph' } });
    }
    if (req.url.includes('grant_type=refresh_token')) {
      const sent = JSON.parse(raw || '{}').refresh_token;
      refreshCalls.push(sent);
      if (spentRefreshTokens.has(sent)) {
        // Exactly what GoTrue says for a rotated-away token.
        return send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' });
      }
      spentRefreshTokens.add(sent);
      validAccess = 'access-2';
      validRefresh = 'refresh-2';
      return send(200, { access_token: validAccess, refresh_token: validRefresh, user: { id: 'u1', email: 'owner@furnishar.ph' } });
    }
    if (req.url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, false);
    if (req.url.startsWith('/rest/v1/store_members')) {
      if (!auth.includes(validAccess)) return send(401, { message: 'JWT expired', code: 'PGRST301' });
      return send(200, [{ role: 'owner', stores: { id: STORE, slug: 'sc-variety', name: 'S&C Variety Store', plan: 'freemium' } }]);
    }
    if (req.url.startsWith('/rest/v1/products')) {
      if (!auth.includes(validAccess)) return send(401, { message: 'JWT expired', code: 'PGRST301' });
      return send(200, []);
    }
    send(200, []);
  });
});
await new Promise(r => sb.listen(SB, r));

const app = spawn('npx', ['next', 'start', '-p', String(APP)], {
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB}`, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'x' },
  stdio: 'ignore', detached: true
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${APP}/portal`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${APP}/portal`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('form.login-form', { timeout: 20000 });
await page.fill('input[name="email"]', 'owner@furnishar.ph');
await page.fill('input[name="password"]', 'x');
await page.click('form.login-form button[type="submit"]');
await page.waitForTimeout(2500);

// The access token has now expired server-side, exactly as it would after an hour.
validAccess = 'access-EXPIRED-SENTINEL';
console.log('--- token expired; firing 4 concurrent calls, as the dashboard does ---');

const result = await page.evaluate(async () => {
  const mod = await import('/supabase.js');
  const before = JSON.parse(sessionStorage.getItem('furnishar-sb-session') || 'null');
  const outcomes = await Promise.allSettled([
    mod.listOwnProducts('21f61742-6d5d-4239-9592-05b2a79a0453'),
    mod.listOwnProducts('21f61742-6d5d-4239-9592-05b2a79a0453'),
    mod.listOwnProducts('21f61742-6d5d-4239-9592-05b2a79a0453'),
    mod.listOwnProducts('21f61742-6d5d-4239-9592-05b2a79a0453')
  ]);
  const after = JSON.parse(sessionStorage.getItem('furnishar-sb-session') || 'null');
  return {
    hadSessionBefore: Boolean(before?.access_token),
    stillHasSessionAfter: Boolean(after?.access_token),
    rejected: outcomes.filter(o => o.status === 'rejected').map(o => String(o.reason?.message)).slice(0, 4)
  };
});

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const spentTwice = refreshCalls.length !== new Set(refreshCalls).size;
check('the session survived the simultaneous expiry', result.stillHasSessionAfter);
check('no request surfaced a raw token error to the owner',
  result.rejected.length === 0, result.rejected.join('; '));
check('the rotating refresh token was never spent twice',
  !spentTwice, `spent: ${refreshCalls.join(', ')}`);

await browser.close();
try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); }
sb.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nconcurrent expiry renews once and keeps the session');
process.exit(problems.length ? 1 : 0);
