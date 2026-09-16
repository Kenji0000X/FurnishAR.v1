/**
 * The demo API (/api/health, /api/stores, /api/products, /api/auth/login),
 * as a Route Handler.
 *
 * This is the app's only backend: the bundled catalogue and the demo shop
 * sign-ins. Rather than reimplement it here
 * — and risk the token format or the product validation drifting from the
 * version tests/api.test.js covers — lib/handler.js is reused as-is behind a
 * small adapter from a Web Request to the Node req/res pair it expects.
 *
 * lib/handler.js also serves static files; that branch is unreachable here
 * because this route only ever receives /api/* paths.
 */
import { Readable } from 'node:stream';
import nodeHandler from '../../../lib/handler.js';
import proxy from '../../../lib/supabase-proxy.js';

export const dynamic = 'force-dynamic';

const { isConfigured, serverCredentials, proxyRest, proxyAuth, createSignedUpload, publicObjectUrl } = proxy;

function asNodeRequest(request) {
  return { method: request.method, headers: Object.fromEntries(request.headers) };
}

function json(status, body, extraHeaders = {}) {
  return Response.json(body, { status, headers: extraHeaders });
}

function isConfigurationError(error) {
  return /secret\/service_role key|no Supabase backend|not a usable URL|must start with https/i
    .test(error?.message || '');
}

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
    return {
      reachable: false,
      project: host,
      error: `Could not reach ${host} (${error?.cause?.code || error?.name || 'network error'}).`
    };
  }
}

async function supabaseApi(request, url) {
  const path = url.pathname.slice('/api/sb/'.length).split('/').filter(Boolean);
  const [section, ...rest] = path;

  if (section === 'status' && rest.length === 0) {
    try {
      return json(200, {
        configured: isConfigured(),
        ...(url.searchParams.get('probe') === '1' ? await probeProject() : {})
      });
    } catch (error) {
      if (isConfigurationError(error)) return json(200, { configured: false, error: error.message });
      throw error;
    }
  }
  if (!isConfigured()) return json(503, { error: 'This deployment has no Supabase backend configured.' });

  if (section === 'rest') {
    const target = rest.join('/') + (url.search || '');
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
    const result = await proxyRest(asNodeRequest(request), target, body);
    const headers = result.headers?.['content-range']
      ? { 'Content-Range': result.headers['content-range'] }
      : {};
    return json(result.status, result.body, headers);
  }
  if (section === 'auth' && request.method === 'POST') {
    const result = await proxyAuth(rest.join('/'), await request.json().catch(() => ({})));
    const headers = result.headers?.['retry-after'] ? { 'Retry-After': result.headers['retry-after'] } : {};
    return json(result.status, result.body, headers);
  }
  if (section === 'model' && ['GET', 'HEAD'].includes(request.method)) {
    const objectPath = rest.join('/');
    if (!/^[\w-]+\/[\w-]+\/[\w.-]+$/.test(objectPath)) return json(400, { error: 'Bad model path.' });
    return new Response(null, {
      status: 302,
      headers: { Location: publicObjectUrl('furniture-models', objectPath), 'Cache-Control': 'public, max-age=3600' }
    });
  }
  if (section === 'storage' && rest[0] === 'sign' && request.method === 'POST') {
    const result = await createSignedUpload(asNodeRequest(request), await request.json().catch(() => ({})));
    return json(result.status, result.body);
  }
  return json(404, { error: 'Unknown endpoint.' });
}

/** Minimal http.ServerResponse stand-in that collects what the handler writes. */
function createResponseCollector(resolve) {
  const headers = {};
  let status = 200;
  return {
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    writeHead(code, moreHeaders = {}) {
      status = code;
      Object.assign(headers, moreHeaders);
      return this;
    },
    end(body) {
      resolve(new Response(body ?? null, { status, headers }));
    }
  };
}

async function handle(request) {
  const url = new URL(request.url);

  if (url.pathname === '/api/sb' || url.pathname.startsWith('/api/sb/')) {
    try { return await supabaseApi(request, url); }
    catch (error) {
      if (isConfigurationError(error)) return json(503, { error: error.message });
      if (error?.upstream) return json(502, { error: error.message });
      console.error('[supabase] unhandled error in /api/sb:', error);
      return json(500, { error: 'The server could not complete that request. Check the deployment logs.' });
    }
  }

  // The handler reads the body by async-iterating the request, so a Web body
  // has to be presented as a Node stream. GET/HEAD have none.
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const bodyText = hasBody ? await request.text() : '';
  const stream = Readable.from(hasBody ? [Buffer.from(bodyText)] : []);

  const req = Object.assign(stream, {
    method: request.method,
    url: url.pathname + url.search,
    headers: Object.fromEntries(request.headers)
  });

  return new Promise((resolve, reject) => {
    const res = createResponseCollector(resolve);
    Promise.resolve(nodeHandler(req, res)).catch(reject);
  });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
