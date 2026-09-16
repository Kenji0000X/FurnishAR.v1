/**
 * The demo API (/api/health, /api/stores, /api/products, /api/auth/login),
 * as a Route Handler.
 *
 * This is the fallback the app runs on when no Supabase project is configured:
 * the bundled catalogue and the demo shop sign-ins. Rather than reimplement it
 * — and risk the token format or the product validation drifting from the
 * version tests/api.test.js covers — lib/handler.js is reused as-is behind a
 * small adapter from a Web Request to the Node req/res pair it expects.
 *
 * /api/sb/* is matched by the more specific route next door and never reaches
 * this file. A second copy of that proxy briefly lived here; it was
 * unreachable, because Next matches the more specific segment first.
 *
 * lib/handler.js also serves static files; that branch is unreachable here
 * because this route only ever receives /api/* paths.
 */
import { Readable } from 'node:stream';
import nodeHandler from '../../../lib/handler.js';

export const dynamic = 'force-dynamic';



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
