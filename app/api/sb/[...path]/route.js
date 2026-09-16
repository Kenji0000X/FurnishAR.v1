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
 */
import proxy from '../../../../lib/supabase-proxy.js';

const {
  isConfigured, serverCredentials, proxyRest, proxyAuth, createSignedUpload, publicObjectUrl
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

function json(status, body, extraHeaders = {}) {
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
  const { url } = serverCredentials();
  if (!url) return { reachable: false, project: null };
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store'
    });
    return { reachable: true, project: host, projectStatus: response.status };
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

  // Models are fetched through this origin so the project URL is not published
  // to every visitor. Redirecting keeps the bytes out of the function.
  if (section === 'model' && ['GET', 'HEAD'].includes(request.method)) {
    const objectPath = rest.join('/');
    if (!/^[\w-]+\/[\w-]+\/[\w.-]+$/.test(objectPath)) {
      return json(400, { error: 'Bad model path.' });
    }
    // Built by hand rather than with Response.redirect so the cache header
    // survives — without it every model placement re-hits this function.
    return new Response(null, {
      status: 302,
      headers: {
        Location: publicObjectUrl('furniture-models', objectPath),
        'Cache-Control': 'public, max-age=3600'
      }
    });
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
