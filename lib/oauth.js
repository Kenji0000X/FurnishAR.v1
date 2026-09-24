/**
 * Sign in with Google, through Supabase Auth, without the browser ever
 * holding the project URL, the API key or the PKCE verifier.   DFD: P1
 *
 *   GET  /api/sb/auth/google?next=/furniture/x&intent=buyer
 *        makes a PKCE verifier, keeps it in an httpOnly cookie scoped to
 *        /api/sb/auth, asks Supabase for Google's consent URL and redirects
 *        there. Supabase requests Google's identity scopes only (openid,
 *        email, profile) — FurnishAR asks for nothing more.
 *
 *   Google → Supabase → /auth/callback?code=…   (a page in this app)
 *
 *   POST /api/sb/auth/exchange  { code }
 *        trades the code + the cookie's verifier for a Supabase session,
 *        removes Google's own provider tokens (FurnishAR has no use for
 *        them and does not keep them), clears the cookie, and returns the
 *        session with the SAFE `next` the flow started with.
 *
 * Identity only. The session says WHO signed in (auth.users.id). WHAT they
 * may do is decided afterwards by my_role() from the database; a Google
 * account is never an admin because it is a Google account.
 */
const crypto = require('node:crypto');
const { serverCredentials, callSupabase } = require('./supabase-proxy.js');

const COOKIE = 'fa_oauth';
const COOKIE_PATH = '/api/sb/auth';
const FLOW_SECONDS = 600;
const INTENTS = new Set(['buyer', 'store']);

const b64url = buffer => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Same rule as lib/auth-intent.js: a path on this site, nothing else. */
function safeNext(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(trimmed)) return null;
  // The callback and the OAuth endpoints are never a destination.
  if (/^\/(auth\/callback|api\/)/.test(trimmed)) return null;
  return trimmed.slice(0, 512);
}

function cookieHeader(value, { secure, maxAge }) {
  return [`${COOKIE}=${value}`, `Path=${COOKIE_PATH}`, `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax',
    ...(secure ? ['Secure'] : [])].join('; ');
}

function readCookie(header) {
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(String(header || ''));
  if (!match) return null;
  try {
    const flow = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return flow && typeof flow.v === 'string' ? flow : null;
  } catch {
    return null;
  }
}

function loginError(site, code, intent) {
  const query = new URLSearchParams({ oauth_error: code });
  if (intent === 'buyer') query.set('as', 'buyer');
  return `${site}${intent === 'store' ? '/portal' : '/login'}?${query}`;
}

/**
 * Starts the flow. Returns { status: 302, location, cookie }. Any failure is
 * a redirect back to the sign-in page with a code the page turns into words —
 * never a Supabase error page.
 */
async function startGoogle({ site, next, intent }) {
  const cleanIntent = INTENTS.has(intent) ? intent : null;
  const { url, key } = serverCredentials();
  if (!url || !key) return { status: 302, location: loginError(site, 'unavailable', cleanIntent) };

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const query = new URLSearchParams({
    provider: 'google',
    redirect_to: `${site}/auth/callback`,
    code_challenge: challenge,
    code_challenge_method: 's256'
  });

  let response;
  try {
    response = await callSupabase(`${url}/auth/v1/authorize?${query}`, {
      headers: { apikey: key }, redirect: 'manual'
    });
  } catch {
    return { status: 302, location: loginError(site, 'network', cleanIntent) };
  }
  const location = response.headers.get('location');
  let target = null;
  try { target = location ? new URL(location) : null; } catch { target = null; }
  // Supabase answers a disabled or misconfigured provider with an error
  // instead of a redirect to Google.
  // https only — except a local stand-in during development and checks.
  const local = target && target.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(target.hostname);
  if (![301, 302, 303, 307].includes(response.status) || !target || (target.protocol !== 'https:' && !local)
      || target.searchParams.has('error')) {
    console.warn(`[oauth] google authorize answered ${response.status}`);
    return { status: 302, location: loginError(site, 'provider_unavailable', cleanIntent) };
  }

  const flow = b64url(JSON.stringify({ v: verifier, n: safeNext(next), i: cleanIntent, t: Date.now() }));
  return {
    status: 302,
    location: target.toString(),
    cookie: cookieHeader(flow, { secure: site.startsWith('https:'), maxAge: FLOW_SECONDS })
  };
}

/** What a failed exchange means, as a code the callback page words. */
function exchangeFailure(body, status) {
  const code = String(body?.error_code || body?.code || '');
  if (/flow_state_expired/.test(code)) return 'expired';
  if (/flow_state_not_found|bad_code_verifier|invalid_grant|bad_oauth_state/.test(code) || status === 404) return 'already_used';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'failed';
}

/** Only what the app needs from a session; never the provider's tokens. */
function sanitiseSession(session) {
  const user = session.user || {};
  const meta = user.user_metadata || {};
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: session.token_type,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    user: {
      id: user.id,
      email: user.email,
      user_metadata: { full_name: meta.full_name || meta.name || null }
    }
  };
}

/**
 * Finishes the flow. Returns { status, body, cookie } where cookie clears
 * the flow cookie whatever happened: a code is good once.
 */
async function exchangeCode({ code, cookieHeader: header, site }) {
  const clear = cookieHeader('', { secure: String(site || '').startsWith('https:'), maxAge: 0 });
  const flow = readCookie(header);
  if (!flow) return { status: 400, body: { code: 'state_missing' }, cookie: clear };
  if (!Number.isFinite(flow.t) || Date.now() - flow.t > FLOW_SECONDS * 1000) {
    return { status: 400, body: { code: 'expired' }, cookie: clear };
  }
  if (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{8,512}$/.test(code)) {
    return { status: 400, body: { code: 'missing_code' }, cookie: clear };
  }
  const { url, key } = serverCredentials();
  if (!url || !key) return { status: 503, body: { code: 'unavailable' }, cookie: clear };

  let response;
  try {
    response = await callSupabase(`${url}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_code: code, code_verifier: flow.v })
    });
  } catch {
    return { status: 502, body: { code: 'network' }, cookie: clear };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    console.warn(`[oauth] code exchange -> ${response.status} ${body?.error_code || body?.code || ''}`);
    return { status: response.status >= 500 ? 502 : 400, body: { code: exchangeFailure(body, response.status) }, cookie: clear };
  }
  return {
    status: 200,
    body: { session: sanitiseSession(body), next: safeNext(flow.n), intent: INTENTS.has(flow.i) ? flow.i : null },
    cookie: clear
  };
}

module.exports = { startGoogle, exchangeCode, safeNext, sanitiseSession, readCookie, COOKIE, COOKIE_PATH };
