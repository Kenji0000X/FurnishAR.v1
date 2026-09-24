/**
 * Database calls made by this server.                      DFD: P1, P7, P10
 *
 * Two kinds, and only two:
 *
 *   rpc(ctx, fn, args)      AS THE SIGNED-IN USER. The publishable key plus
 *                           their own access token, so auth.uid() and RLS
 *                           decide, exactly as for a browser call.
 *
 *   serverRpc(fn, args, t)  A server-only function (0011's server_* and
 *                           record_capture). The server's payment-recorder
 *                           secret is added here, from the environment, and
 *                           the database checks it. With a user token when
 *                           there is one (the function may also check the
 *                           caller), without one for webhooks and cron.
 *
 * Neither uses the Supabase secret / service_role key; this server does not
 * have it.
 */
const { serverCredentials, callSupabase } = require('./supabase-proxy.js');

function recorderSecret() {
  return String(process.env.PAYMENT_RECORDER_SECRET || '').trim();
}

function serverSecretReady() {
  return recorderSecret().length >= 32;
}

/** A sentence written for people, or a generic one. Postgres internals stay here. */
function readableError(body, status) {
  const code = body?.code;
  const readable = typeof body?.message === 'string' && /^[A-Z].{3,240}[.!]$/.test(body.message)
    && !/relation|column|syntax|function .*does not exist|violates|constraint/i.test(body.message);
  const error = new Error(readable ? body.message : 'That could not be completed. Please try again.');
  error.status = code === '42501' || code === '28000' ? 403 : status >= 500 ? 502 : 400;
  error.dbCode = code;
  if (!readable) console.error(`[db] ${status} ${code || ''} ${String(body?.message || '').slice(0, 200)}`);
  return error;
}

async function post(fn, args, token) {
  const { url, key } = serverCredentials();
  if (!url || !key) {
    const error = new Error('This deployment has no Supabase backend configured.');
    error.status = 503;
    throw error;
  }
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await callSupabase(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(args || {})
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw readableError(body, response.status);
  return body;
}

/** As the signed-in user. `ctx` carries their token. */
function rpc(ctx, fn, args) {
  return post(fn, args, ctx.token);
}

/** A server-only function, with the recorder secret. */
function serverRpc(fn, args = {}, token = null) {
  if (!serverSecretReady()) {
    const error = new Error('Online payments are not switched on yet.');
    error.status = 503;
    error.code = 'payments_unconfigured';
    throw error;
  }
  return post(fn, { p_secret: recorderSecret(), ...args }, token);
}

module.exports = { rpc, serverRpc, serverSecretReady, recorderSecret };
