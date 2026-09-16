const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function serverCredentials() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { url: '', key: '' };
  if (/service_role|^sb_secret_/i.test(SUPABASE_KEY)) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY must contain a publishable or anon key.');
  }
  try { new globalThis.URL(SUPABASE_URL); } catch { throw new Error('SUPABASE_URL is not a usable URL.'); }
  return { url: SUPABASE_URL.replace(/\/$/, ''), key: SUPABASE_KEY };
}

function isConfigured() {
  const { url, key } = serverCredentials();
  return Boolean(url && key);
}

async function callSupabase(target, options) {
  try {
    return await fetch(target, options);
  } catch (error) {
    const failure = new Error(`Could not reach Supabase at ${new URL(target).host}.`);
    failure.upstream = true;
    failure.cause = error;
    throw failure;
  }
}

function callerToken(req) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match && !/^sb_(publishable|secret)_/.test(match[1]) ? match[1] : null;
}

async function proxyRest(req, path, rawBody) {
  const { url, key } = serverCredentials();
  const token = callerToken(req);
  const headers = { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers.accept) headers.accept = req.headers.accept;
  const response = await callSupabase(`${url}/rest/v1/${path}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: { 'content-range': response.headers.get('content-range') } };
}

const authRoutes = {
  login: '/auth/v1/token?grant_type=password',
  signup: '/auth/v1/signup',
  refresh: '/auth/v1/token?grant_type=refresh_token',
  logout: '/auth/v1/logout'
};

function authPayload(action, payload = {}) {
  if (action === 'login') return { email: payload.email, password: payload.password };
  if (action === 'refresh') return { refresh_token: payload.refreshToken };
  if (action === 'signup') return { email: payload.email, password: payload.password, data: { store_name: payload.storeName, contact_phone: payload.phone } };
  return {};
}

async function proxyAuth(action, payload) {
  const { url, key } = serverCredentials();
  const path = authRoutes[action];
  if (!path) return { status: 404, body: { error: `Unknown auth action: ${action}` } };
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (action === 'logout' && payload.accessToken) headers.Authorization = `Bearer ${payload.accessToken}`;
  const response = await callSupabase(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(authPayload(action, payload)) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: { 'retry-after': response.headers.get('retry-after') } };
}

function publicObjectUrl(bucket, objectPath) {
  const { url } = serverCredentials();
  return `${url}/storage/v1/object/public/${bucket}/${objectPath}`;
}

async function createSignedUpload() {
  return { status: 501, body: { error: 'Signed uploads are not configured.' } };
}

module.exports = {
  isConfigured,
  serverCredentials,
  proxyRest,
  proxyAuth,
  createSignedUpload,
  publicObjectUrl
};
