/**
 * Server-side Supabase proxy.
 *
 * WHY THIS EXISTS
 * A browser that talks to Supabase directly must carry the publishable key, and
 * anyone can read it out of the network tab. No framework changes that — in
 * Next.js, `NEXT_PUBLIC_*` is *defined* as "inline this into the bundle".
 * The only way the key stays hidden is for it never to leave the server.
 *
 * So the browser calls this app's own API, and this module calls Supabase with
 * the key held in server-only environment variables.
 *
 * WHAT THIS DOES AND DOES NOT BUY YOU
 * The publishable key was never the security boundary — row level security is,
 * and it still is here. This proxy holds the *publishable* key, not the secret
 * one, precisely so that RLS keeps applying: a request arrives as `anon`, or as
 * the signed-in user when the browser forwards their access token. What the
 * proxy adds is that the key cannot be scraped and reused against your quota,
 * and that the project URL is not advertised to every visitor.
 *
 * It deliberately does NOT hold the service_role/secret key. That key bypasses
 * RLS, which would make this proxy the only thing standing between the public
 * and every row in the database.
 */
const { loadSupabaseEnv, cleanCredential, assertUsableUrl } = require('./env.js');
const { guardAdminRequest } = require('./auth.js');

/** Only these may be reached through the proxy. RLS still gates every row. */
const ALLOWED_TABLES = new Set([
  'catalog',
  'stores',
  'products',
  'product_assets',
  'store_members',
  // Readable only by a platform admin — the policies in 0002 decide that, not
  // this list. Being on it means "reachable", not "permitted".
  'store_applications',
  'platform_admins',
  'admin_audit'
]);

/**
 * Database functions callable through the proxy.
 *
 * Approving a store is four writes that must happen together, so it is a
 * security-definer function rather than a table write. The function checks
 * is_platform_admin() itself; this list only decides what can be reached.
 */
const ALLOWED_FUNCTIONS = new Set([
  'approve_store_application',
  'reject_store_application',
  'applicant_account',
  'is_platform_admin',
  'storage_usage'
]);

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']);

/** Headers PostgREST understands that a client may legitimately set. */
const FORWARDABLE_REQUEST_HEADERS = ['prefer', 'range', 'content-type', 'accept'];

/**
 * Refuses a secret / service_role key.
 *
 * This module's whole design is that it holds a key which row level security
 * still applies to. A secret key bypasses RLS entirely, which would silently
 * turn this proxy into the only thing standing between the public internet and
 * every row in the database — one missing check in a route handler and the
 * whole catalogue, every store's drafts and the sign-up queue are readable.
 *
 * It fails loudly rather than falling back to the bundled catalogue, because a
 * deployment configured this way looks like it is working while being wide
 * open, and that is the worst of both.
 */
function assertNotSecretKey(key, source) {
  if (/^sb_secret_/.test(key) || /service_role/.test(key)) {
    throw new Error(
      `${source} holds a Supabase secret/service_role key. Use the publishable ` +
      '(sb_publishable_…) key instead — the secret one bypasses row level security ' +
      'and must never be used to serve browser requests. See SUPABASE.md.'
    );
  }
  return key;
}

function serverCredentials() {
  // Server-only names come first. The NEXT_PUBLIC_* / build-time names are
  // accepted as a fallback so an existing .env.local keeps working, but they
  // are reported so a deployment can be tightened.
  // Cleaned before use: a stray quote, trailing newline or a whole `NAME=value`
  // line pasted into a hosting panel would otherwise make fetch throw, which
  // reached the browser as an unexplained 500.
  const url = cleanCredential(process.env.SUPABASE_URL, 'SUPABASE_URL');
  const keyName = process.env.SUPABASE_PUBLISHABLE_KEY ? 'SUPABASE_PUBLISHABLE_KEY' : 'SUPABASE_ANON_KEY';
  const key = cleanCredential(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY, keyName);
  if (url && key) {
    return {
      url: assertUsableUrl(url, 'SUPABASE_URL').replace(/\/$/, ''),
      key: assertNotSecretKey(key, keyName),
      serverOnly: true
    };
  }

  const fallback = loadSupabaseEnv();
  return {
    url: fallback.supabaseUrl ? assertUsableUrl(fallback.supabaseUrl, fallback.urlFrom) : '',
    key: fallback.supabaseAnonKey ? assertNotSecretKey(fallback.supabaseAnonKey, fallback.keyFrom) : '',
    serverOnly: false
  };
}

/**
 * Every call out to Supabase goes through here.
 *
 * A network failure — a project that has been paused or deleted, a typo in the
 * ref, DNS — makes fetch reject, and an unhandled rejection in a route handler
 * is a 500 with no body. That is indistinguishable from a bug in this app, so
 * it is reported as what it is: we could not reach your project.
 */
async function callSupabase(target, options) {
  try {
    return await fetch(target, options);
  } catch (error) {
    const host = (() => { try { return new URL(target).host; } catch { return target; } })();
    const failure = new Error(
      `Could not reach your Supabase project at ${host}. Check that SUPABASE_URL is ` +
      'correct and that the project is not paused. ' +
      `(${error?.cause?.code || error?.message || 'network error'})`
    );
    failure.upstream = true;
    throw failure;
  }
}

function isConfigured() {
  const { url, key } = serverCredentials();
  return Boolean(url && key);
}

/**
 * A caller may only act as themselves. We forward the browser's Supabase
 * access token (a user JWT, not an API key) so RLS sees the real user; if there
 * is none, the request goes through as `anon`.
 */
function callerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  // Never let a caller smuggle an API key in where a user token belongs.
  if (/^sb_(publishable|secret)_/.test(token)) return null;
  return token;
}

/**
 * Proxies one REST request. `path` is everything after /api/sb/rest/, e.g.
 * "catalog?select=*&order=featured.desc".
 */
async function proxyRest(req, path, rawBody) {
  const { url, key } = serverCredentials();
  if (!url || !key) return { status: 503, body: { error: 'This deployment has no Supabase backend configured.' } };

  const [first, second] = path.split(/[?/]/);
  if (first === 'rpc') {
    if (!ALLOWED_FUNCTIONS.has(second)) {
      return { status: 404, body: { error: `Unknown function: ${second}` } };
    }
  } else if (!ALLOWED_TABLES.has(first)) {
    return { status: 404, body: { error: `Unknown resource: ${first}` } };
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    return { status: 405, body: { error: `${req.method} is not allowed here.` } };
  }

  const token = callerToken(req);

  // Checked here as well as in the database. The policies are what protect the
  // rows — see lib/auth.js for why this layer exists in front of them — but an
  // anonymous request for the sign-up queue should not reach Postgres at all,
  // and a non-admin deserves a 403 rather than an empty list that reads like
  // "nothing waiting".
  const refusal = await guardAdminRequest({
    url, key, token, path, method: req.method, call: callSupabase
  });
  if (refusal) return refusal;

  // New-style publishable keys are API keys, not JWTs, so they must not go in
  // Authorization — PostgREST would try to parse one as a token. The apikey
  // header authenticates the request; a signed-in browser adds its own JWT so
  // row level security sees the real user.
  const headers = { apikey: key };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const name of FORWARDABLE_REQUEST_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const response = await callSupabase(`${url}/rest/v1/${path}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody
  });

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return {
    status: response.status,
    body,
    headers: {
      'content-range': response.headers.get('content-range') || undefined
    }
  };
}

/**
 * Proxies the auth endpoints the portal needs. The browser never sees the API
 * key; it receives the session (access token + refresh token) and sends the
 * access token back on later calls.
 */
async function proxyAuth(action, payload) {
  const { url, key } = serverCredentials();
  if (!url || !key) return { status: 503, body: { error: 'This deployment has no Supabase backend configured.' } };

  const routes = {
    login: { path: '/auth/v1/token?grant_type=password', method: 'POST' },
    signup: { path: '/auth/v1/signup', method: 'POST' },
    refresh: { path: '/auth/v1/token?grant_type=refresh_token', method: 'POST' },
    logout: { path: '/auth/v1/logout', method: 'POST' }
  };
  const route = routes[action];
  if (!route) return { status: 404, body: { error: `Unknown auth action: ${action}` } };

  // GoTrue's unauthenticated endpoints want the apikey header and nothing else
  // — that is exactly what Supabase's own curl examples for /signup and
  // /token send. We used to also pass `Authorization: Bearer <key>`, which is
  // harmless with a legacy anon JWT but asks GoTrue to parse a
  // `sb_publishable_…` key as a JWT, a needless way to earn a 400.
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Signing out is the one that must be done as the user, not the anon key.
  if (action === 'logout' && payload.accessToken) headers.Authorization = `Bearer ${payload.accessToken}`;

  const response = await callSupabase(`${url}${route.path}`, {
    method: route.method,
    headers,
    body: JSON.stringify(sanitiseAuthPayload(action, payload))
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!response.ok) {
    // Without this an auth failure is invisible on the server and arrives in
    // the browser as a bare status code. Never log the payload — it holds the
    // password.
    console.warn(
      `[supabase] auth/${action} -> ${response.status}`,
      typeof body === 'object' && body
        ? JSON.stringify({ code: body.error_code || body.code, message: body.msg || body.message || body.error_description })
        : String(body || '(empty body)').slice(0, 200)
    );
  }

  return {
    status: response.status,
    body,
    headers: {
      // GoTrue says how long to wait when it rate-limits; the browser cannot
      // act on that unless we pass it on.
      'retry-after': response.headers.get('retry-after') || undefined
    }
  };
}

/** Only pass through the fields each auth call actually takes. */
function sanitiseAuthPayload(action, payload = {}) {
  if (action === 'login') return { email: payload.email, password: payload.password };
  if (action === 'refresh') return { refresh_token: payload.refreshToken };
  if (action === 'logout') return {};
  if (action === 'signup') {
    return {
      email: payload.email,
      password: payload.password,
      data: { store_name: payload.storeName, contact_phone: payload.phone }
    };
  }
  return {};
}

/**
 * A one-time signed URL so the browser can upload a model straight to Storage.
 * Large files must not be streamed through a serverless function — Vercel caps
 * a request body at 4.5 MB, well under the 50 MB model limit — and this keeps
 * the key on the server either way.
 */
async function createSignedUpload(req, { bucket, objectPath }) {
  const { url, key } = serverCredentials();
  if (!url || !key) return { status: 503, body: { error: 'This deployment has no Supabase backend configured.' } };

  const token = callerToken(req);
  if (!token) return { status: 401, body: { error: 'Sign in before uploading.' } };
  if (bucket !== 'furniture-models') return { status: 400, body: { error: 'Unknown bucket.' } };
  // The storage policy checks the same thing, but refusing an obviously wrong
  // path here saves a round trip and keeps the error readable.
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[\w.-]+$/i.test(objectPath)) {
    return { status: 400, body: { error: 'A model path must be <store_id>/<product_id>/<file>.' } };
  }

  const response = await callSupabase(`${url}/storage/v1/object/upload/sign/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  // The signed URL is relative; hand back something the browser can POST to.
  if (response.ok && body?.url) body.uploadUrl = `${url}/storage/v1${body.url.replace(/^\/storage\/v1/, '')}`;
  return { status: response.status, body };
}

/** Public URL for a stored object, so the browser can fetch a model directly. */
function publicObjectUrl(bucket, objectPath) {
  const { url } = serverCredentials();
  if (!url) return null;
  return `${url}/storage/v1/object/public/${bucket}/${objectPath}`;
}

module.exports = {
  isConfigured,
  serverCredentials,
  proxyRest,
  proxyAuth,
  createSignedUpload,
  publicObjectUrl,
  ALLOWED_TABLES,
  ALLOWED_FUNCTIONS
};
