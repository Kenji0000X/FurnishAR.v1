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
const { loadSupabaseEnv } = require('./env.js');

/** Only these may be reached through the proxy. RLS still gates every row. */
const ALLOWED_TABLES = new Set([
  'catalog',
  'stores',
  'products',
  'product_assets',
  'store_members',
  'store_applications'
]);

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']);

/** Headers PostgREST understands that a client may legitimately set. */
const FORWARDABLE_REQUEST_HEADERS = ['prefer', 'range', 'content-type', 'accept'];

function serverCredentials() {
  // Server-only names come first. The NEXT_PUBLIC_* / build-time names are
  // accepted as a fallback so an existing .env.local keeps working, but they
  // are reported so a deployment can be tightened.
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (url && key) return { url: url.replace(/\/$/, ''), key, serverOnly: true };

  const fallback = loadSupabaseEnv();
  return {
    url: fallback.supabaseUrl,
    key: fallback.supabaseAnonKey,
    serverOnly: false
  };
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

  const [table] = path.split(/[?/]/);
  if (!ALLOWED_TABLES.has(table)) {
    return { status: 404, body: { error: `Unknown resource: ${table}` } };
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    return { status: 405, body: { error: `${req.method} is not allowed here.` } };
  }

  const token = callerToken(req);
  const headers = {
    apikey: key,
    // Anonymous requests authenticate as the key itself; a signed-in browser
    // sends its own token so row level security sees the real user.
    Authorization: `Bearer ${token || key}`
  };
  for (const name of FORWARDABLE_REQUEST_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const response = await fetch(`${url}/rest/v1/${path}`, {
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

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  // Signing out has to be done as the user, not as the anonymous key.
  if (action === 'logout' && payload.accessToken) headers.Authorization = `Bearer ${payload.accessToken}`;

  const response = await fetch(`${url}${route.path}`, {
    method: route.method,
    headers,
    body: JSON.stringify(sanitiseAuthPayload(action, payload))
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
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

  const response = await fetch(`${url}/storage/v1/object/upload/sign/${bucket}/${objectPath}`, {
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
  ALLOWED_TABLES
};
