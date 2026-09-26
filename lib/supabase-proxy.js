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
const { guardAdminRequest, verifySession } = require('./auth.js');

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
  'admin_audit',
  // 0006. `buyers` is on the list so a shopper can read and edit their OWN
  // row; the policy is `user_id = auth.uid()`, so being reachable here buys
  // nobody anybody else's name and town. `municipalities` is the one
  // genuinely public table on the platform — it is a list of place names, and
  // the sign-up form needs it before anyone has an account.
  'buyers',
  'municipalities',
  // 0009. Read-only to every client (no insert/update/delete grants): orders
  // and payments change only through the functions below and /api/sb/orders.
  // RLS shows each party their own — a buyer their orders, a shop its store's.
  'orders',
  'payments',
  'store_payout',
  'fee_settlements',
  // 0011. Read-only to every client, RLS per party. Written only by the
  // server's secret-gated functions after PayPal has said so.
  'store_payment_accounts',
  'payment_attempts',
  'payment_refunds',
  'payment_webhook_events',
  // 0015/0016. Payouts FurnishAR made to a store for GCash payments its PayMongo account received.
  // RLS: the store's members and admins; written only by the function below.
  'store_remittances'
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
  'storage_usage',
  // 0012. Checks is_platform_admin() itself. Deliberately NOT here:
  // admin_delete_stale_model (only /api/sb/models/admin-cleanup, after the
  // files are gone) and record_model_access (only the model grant).
  'admin_model_lifecycle',
  // 0013. Each checks store membership itself: the portal's view of its own
  // models before the year is up, and "Keep 3D model".
  'store_model_lifecycle',
  'keep_model',
  // 0006. Answers only about the caller, and answers 'guest' when there is no
  // caller, so it is safe to reach signed out — which it must be, because
  // "are you signed in" is the first question the planner asks.
  'my_role',
  // 0009. Each checks its caller itself. record_capture is deliberately NOT
  // here: only the server's order handler records a payment.
  'store_fee_summary',
  'fee_overview',
  'record_fee_settlement',
  'platform_fee_rate',
  // 0016. Both check is_platform_admin() themselves: enabling GCash via
  // PayMongo for a store (no self-service onboarding) and recording a payout.
  'admin_set_paymongo_account',
  'record_store_remittance'
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
    logout: { path: '/auth/v1/logout', method: 'POST' },
    // Every store application this app has ever refused with "no confirmed
    // account" was a real signup stuck at this exact step — the confirmation
    // email landed in spam, or never sent, or the applicant lost it. There
    // was no way to do anything about that except wait, which is what "the
    // approve button does nothing" actually was. This lets the applicant, or
    // the admin reviewing them, ask GoTrue to send it again.
    resend: { path: '/auth/v1/resend', method: 'POST' }
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
    /*
      Two kinds of account sign up through this one endpoint, and the
      metadata decides which.

      A shopper's name and municipality ride along as user metadata because
      0006's trigger on auth.users reads them there and writes the buyers row
      in the same transaction as the account. They cannot be sent as a second
      write from the browser: when the project requires email confirmation
      there is no session immediately after sign-up, so an insert into a table
      whose policy is `user_id = auth.uid()` could not succeed at all.

      `role` is metadata, never a permission. It tells the trigger which kind
      of row to write; from then on the answer to "what is this account" comes
      from my_role(), which reads the tables, not from anything a browser
      claims. Someone who forges `role: 'buyer'` gets a buyers row and a
      shopper's account, which is what the sign-up form was offering anyway.
    */
    if (payload.role === 'buyer') {
      return {
        email: payload.email,
        password: payload.password,
        data: {
          role: 'buyer',
          full_name: payload.fullName,
          municipality: payload.municipality
        }
      };
    }
    return {
      email: payload.email,
      password: payload.password,
      data: { store_name: payload.storeName, contact_phone: payload.phone }
    };
  }
  if (action === 'resend') return { type: 'signup', email: payload.email };
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
  // Two buckets: the private models (0007) and the public catalogue posters
  // (0012). The storage policies check membership either way; refusing an
  // obviously wrong bucket or path here saves a round trip and keeps the
  // error readable.
  const UPLOAD_PATHS = {
    'furniture-models': /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[\w.-]+$/i,
    'product-posters': /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/poster-[0-9a-f]{16}\.(webp|jpg|png)$/i
  };
  if (!Object.hasOwn(UPLOAD_PATHS, bucket)) return { status: 400, body: { error: 'Unknown bucket.' } };
  if (!UPLOAD_PATHS[bucket].test(objectPath)) {
    return { status: 400, body: { error: 'A file path must be <store_id>/<product_id>/<file>.' } };
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
/** How long a signed model URL works. Long enough to download a large file on
    a slow connection; short enough that a copied link is useless by lunch. */
const MODEL_URL_SECONDS = 300;

/** <store uuid>/<product uuid>/<file> — the only shape an uploaded model has. */
const MODEL_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[\w.-]+$/i;

/**
 * May this caller open this 3D model? If so, a URL that works for five minutes.
 *
 * This is the server-side half of protecting the models; the other half is
 * 0007's storage policy. The order matters:
 *
 *   1. AUTHENTICATION. No token is a guest; a token GoTrue no longer honours
 *      — signed out, deleted, expired past refresh — is an expired session.
 *      verifySession asks GoTrue rather than decoding the JWT, because a JWT
 *      only proves it was issued, not that the person has not since signed
 *      out. These two answers are different on purpose: one means "sign in",
 *      the other "sign in again", and the page says so.
 *
 *   2. AUTHORIZATION. The object is signed AS THAT USER, with the publishable
 *      key and their own token. Storage runs can_view_model() and either signs
 *      or refuses. The decision is the database's; this function never holds
 *      the secret key and could not override it if it tried.
 *
 * A refused object and a missing one return the same answer, deliberately:
 * "that draft exists but is not yours" is information a stranger should not
 * be able to get by guessing paths.
 *
 * Every answer carries a `code` the browser maps to a sentence
 * (lib/alerts/messages.mjs). No status text, storage message or path is ever
 * passed through to the person looking at the screen.
 */
async function grantModelAccess(req, objectPath) {
  const { url, key } = serverCredentials();
  if (!url || !key) return { status: 503, body: { code: 'unconfigured' } };
  if (!MODEL_PATH.test(objectPath)) return { status: 400, body: { code: 'bad_path' } };

  const token = callerToken(req);
  if (!token) return { status: 401, body: { code: 'auth_required' } };

  let user;
  try {
    user = await verifySession({ url, key, token, call: callSupabase });
  } catch {
    return { status: 502, body: { code: 'upstream' } };
  }
  if (!user) return { status: 401, body: { code: 'session_expired' } };

  let response;
  try {
    response = await callSupabase(`${url}/storage/v1/object/sign/furniture-models/${objectPath}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: MODEL_URL_SECONDS })
    });
  } catch {
    return { status: 502, body: { code: 'upstream' } };
  }

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (response.ok && body && (body.signedURL || body.signedUrl)) {
    const signed = body.signedURL || body.signedUrl;
    await recordModelAccess({ url, key, token, objectPath });
    return {
      status: 200,
      body: {
        url: /^https?:/.test(signed) ? signed : `${url}/storage/v1${signed}`,
        expiresIn: MODEL_URL_SECONDS
      }
    };
  }

  /* Storage answers a policy refusal as "not found" (400/404) and a bad token
     as 401/403. All of them mean the same thing to the person: this preview
     is not available to this account. The detail goes to the log. */
  if ([400, 401, 403, 404].includes(response.status)) {
    console.warn(`[supabase] model access refused (${response.status}) for user ${user.id}`);
    return { status: 403, body: { code: 'unavailable' } };
  }
  console.warn(`[supabase] model signing failed: ${response.status}`);
  return { status: 502, body: { code: 'upstream' } };
}

/**
 * The model lifecycle's one input (0012): this file was just handed to
 * someone allowed to open it. Called only after Storage signed the URL — never
 * for a refused, missing or failed request, and never for a poster.
 *
 * Runs as the same user, and record_model_access() re-checks can_view_model()
 * itself. At most one write per asset per day, decided by the database.
 * A failure here must never cost the person their model, so it is logged and
 * swallowed: the worst case is a model that looks a day more idle than it is.
 */
async function recordModelAccess({ url, key, token, objectPath }) {
  try {
    const response = await callSupabase(`${url}/rest/v1/rpc/record_model_access`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_object_path: objectPath })
    });
    if (!response.ok) console.warn(`[supabase] model access not recorded (${response.status})`);
  } catch (error) {
    console.warn('[supabase] model access not recorded:', error.message);
  }
}

module.exports = {
  isConfigured,
  serverCredentials,
  proxyRest,
  proxyAuth,
  createSignedUpload,
  grantModelAccess,
  recordModelAccess,
  callerToken,
  callSupabase,
  ALLOWED_TABLES,
  ALLOWED_FUNCTIONS
};
