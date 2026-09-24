/**
 * The Supabase boundary, as Route Handlers.
 *
 * This is the same seam the vanilla build already had, so lib/supabase-proxy.js
 * is reused unchanged rather than rewritten — it is plain Node and knows
 * nothing about either server. The key stays in server-only environment
 * variables and never reaches the browser; see SUPABASE.md §4.
 *
 * Routes:
 *   GET  /api/sb/status         is a backend configured at all?
 *   ANY  /api/sb/rest/<table>   PostgREST, allowlisted tables, RLS still applies
 *   POST /api/sb/auth/<action>  login | signup | refresh | logout
 *   GET  /api/sb/model/<path>   redirect to a stored model, hiding the project URL
 *   POST /api/sb/storage/sign   one-time signed upload URL
 *   GET  /api/sb/orders/config  are online payments / emails switched on?
 *   POST /api/sb/orders/<action> checkout | pay | capture | request | cancel |
 *                               quote | decline | ready | fulfil | store-billing
 */
import proxy from '../../../../lib/supabase-proxy.js';
import orders from '../../../../lib/orders.js';

const {
  isConfigured, serverCredentials, proxyRest, proxyAuth, createSignedUpload, grantModelAccess
} = proxy;

// These read request-specific credentials and must never be prerendered.
export const dynamic = 'force-dynamic';

/**
 * lib/supabase-proxy.js expects a Node-style request: a method and a plain
 * object of lowercase headers. Headers iterates lowercase already, so this is
 * the whole adapter.
 */
function asNodeRequest(request) {
  return { method: request.method, headers: Object.fromEntries(request.headers) };
}

/**
 * Statuses the fetch spec forbids a body on. Constructing a Response with one
 * throws a TypeError rather than ignoring it.
 *
 * This is not a theoretical nicety: GoTrue answers /auth/v1/logout with 204,
 * so `Response.json(null, { status: 204 })` threw on every single sign-out and
 * the handler below turned it into a 500. Signing out APPEARED to work —
 * public/supabase.js clears the local session whatever the call returns — so
 * the only symptom was a 500 in the console and a refresh token left alive at
 * Supabase instead of being revoked.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function json(status, body, extraHeaders = {}) {
  if (NULL_BODY_STATUSES.has(status)) {
    return new Response(null, { status, headers: extraHeaders });
  }
  return Response.json(body, { status, headers: extraHeaders });
}

/**
 * A deployment whose credentials are wrong — a secret key where the publishable
 * one belongs, say — must not answer with a bare 500 and an empty body. That is
 * indistinguishable from a crash, and the reason ends up only in a log the
 * person debugging is not looking at. These are configuration faults: 503, and
 * say which variable is wrong.
 */
function isConfigurationError(error) {
  return /secret\/service_role key|no Supabase backend|not a usable URL|must start with https/i
    .test(error?.message || '');
}

/**
 * Does the configured project actually answer?
 *
 * This exists because of a real outage: SUPABASE_URL was left pointing at a
 * deleted project, so every page silently served the bundled catalogue and
 * every sign-in returned 502, while /api/sb/status still cheerfully reported
 * `configured: true`. Well-formed credentials and a reachable project are two
 * different questions and this endpoint now answers both.
 *
 * Never returns the key, only the host it is pointed at.
 */
async function probeProject() {
  const { url, key } = serverCredentials();
  if (!url) return { reachable: false, project: null };
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  try {
    // The apikey header matters: Supabase's gateway answers an unauthenticated
    // request with 401 whatever the project's state, so probing without it
    // reports a 401 that says nothing about the key. Sending it makes the
    // status mean what it looks like — 2xx is "this key works against this
    // project", 401/403 is "it does not".
    const response = await fetch(`${url}/auth/v1/health`, {
      headers: key ? { apikey: key } : undefined,
      signal: AbortSignal.timeout(5000),
      cache: 'no-store'
    });
    const keyAccepted = response.status !== 401 && response.status !== 403;
    return {
      reachable: true,
      project: host,
      projectStatus: response.status,
      keyAccepted,
      ...(keyAccepted ? {} : {
        error:
          `${host} answered, but rejected the key (HTTP ${response.status}). ` +
          'SUPABASE_PUBLISHABLE_KEY probably belongs to a different project, or has been rotated. ' +
          'Copy the publishable key from this project in Settings → API Keys.'
      })
    };
  } catch (error) {
    const code = error?.cause?.code || error?.name || 'network error';
    return {
      reachable: false,
      project: host,
      error:
        code === 'ENOTFOUND'
          ? `No such Supabase project: ${host} does not resolve. SUPABASE_URL is pointing at a project that has been deleted or renamed.`
          : `Could not reach ${host} (${code}). The project may be paused.`
    };
  }
}

async function route(request, context) {
  const { path = [] } = await context.params;
  const [section, ...rest] = path;
  const url = new URL(request.url);

  if (section === 'status' && rest.length === 0) {
    // Reports a misconfiguration rather than throwing, so the portal can say
    // what is wrong instead of silently falling back to the demo backend.
    try {
      // ?probe=1 also checks the project answers. "Configured" only means the
      // variables are present and well formed — a URL pointing at a deleted
      // project passes that and then fails on every real call, which is a
      // genuinely confusing way to be broken. Off by default so the portal's
      // start-up check stays fast.
      if (url.searchParams.get('probe') === '1') {
        return json(200, { configured: isConfigured(), ...(await probeProject()) });
      }
      return json(200, { configured: isConfigured() });
    } catch (error) {
      if (!isConfigurationError(error)) throw error;
      return json(200, { configured: false, error: error.message });
    }
  }

  if (!isConfigured()) {
    return json(503, { error: 'This deployment has no Supabase backend configured.' });
  }

  if (section === 'rest') {
    // The query string is part of what PostgREST is being asked for.
    const target = rest.join('/') + (url.search || '');
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
    const result = await proxyRest(asNodeRequest(request), target, body);
    const headers = {};
    if (result.headers?.['content-range']) headers['Content-Range'] = result.headers['content-range'];
    return json(result.status, result.body, headers);
  }

  if (section === 'auth' && request.method === 'POST') {
    const result = await proxyAuth(rest.join('/'), await request.json().catch(() => ({})));
    const headers = {};
    // Carried through so the form can say how long the wait is instead of
    // letting someone hammer a rate-limited endpoint.
    if (result.headers?.['retry-after']) headers['Retry-After'] = result.headers['retry-after'];
    return json(result.status, result.body, headers);
  }

  /*
    A 3D model, for a caller who is allowed to see it.

    This used to answer every GET — signed in or not — with a 302 to the
    model's PUBLIC storage URL. The planner hid its camera behind a sign-in
    check, but that check ran in the browser; this endpoint, and the public
    bucket behind it, handed any shop's file to anyone who asked.

    Now it answers with JSON: a five-minute signed URL when the session is
    real and the storage policy (0007) allows this user to see this file, or a
    `code` saying why not. JSON rather than a redirect so the browser can tell
    "sign in" from "not allowed" from "try again" and say so in words, instead
    of GLTFLoader reporting "failed to load" for all of them.

    Never cached by anything shared: the answer is per person.
  */
  if (section === 'model' && request.method === 'GET') {
    const result = await grantModelAccess(asNodeRequest(request), rest.join('/'));
    return json(result.status, result.body, { 'Cache-Control': 'private, no-store' });
  }

  /*
    Orders and payments (DFD P10). Money never moves on the browser's word:
    lib/orders.js checks the session, lets the 0009 functions decide what
    this account may do, reads every amount from the database and every
    capture from PayPal. Per person, so never cached.
  */
  if (section === 'orders' && rest.length === 1) {
    const site = (process.env.SITE_URL || url.origin).replace(/\/$/, '');
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : null;
    const result = await orders.handleOrders(asNodeRequest(request), rest[0], body, site);
    return json(result.status, result.body, { 'Cache-Control': 'private, no-store' });
  }

  if (section === 'storage' && rest[0] === 'sign' && request.method === 'POST') {
    const payload = await request.json().catch(() => ({}));
    const result = await createSignedUpload(asNodeRequest(request), payload);
    return json(result.status, result.body);
  }

  return json(404, { error: 'Unknown endpoint.' });
}

/**
 * Nothing here should ever reach the browser as an unhandled 500 with an empty
 * body — that is what a misconfigured deployment used to look like, and it
 * tells the person debugging it nothing at all.
 */
async function handle(request, context) {
  try {
    return await route(request, context);
  } catch (error) {
    if (isConfigurationError(error)) {
      console.error('[supabase] configuration error:', error.message);
      return json(503, { error: error.message });
    }
    // Supabase itself was unreachable — a paused project, a wrong ref, DNS.
    // 502 says plainly that the upstream failed, not this app.
    if (error?.upstream) {
      console.error('[supabase] upstream unreachable:', error.message);
      return json(502, { error: error.message });
    }
    // Genuinely unexpected: log it in full for the server operator, and tell
    // the browser only that it was our fault, not theirs.
    console.error('[supabase] unhandled error in /api/sb:', error);
    return json(500, { error: 'The server could not complete that request. Check the deployment logs.' });
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
