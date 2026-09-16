/**
 * Backend for FurnishAR, in two transports behind one interface.
 *
 *   proxy  (default, recommended)
 *          The browser calls this app's own /api/sb/… endpoints. The Supabase
 *          key stays on the server and never reaches a page, so it cannot be
 *          read out of the network tab or reused against your quota. No
 *          third-party script is loaded either.
 *
 *   direct (legacy)
 *          Only if public/config.js still carries a key. The browser talks to
 *          Supabase itself via supabase-js. Faster to set up, but the key is
 *          visible to anyone who opens DevTools — which is true of every
 *          browser-side Supabase app, in any framework.
 *
 * Either way row level security is the thing protecting the data; the proxy
 * hides the key, it does not replace RLS. client.js calls the exports below and
 * does not care which transport answered.
 */

const CONFIG = (typeof window !== 'undefined' && window.FURNISHAR_CONFIG) || {};
const MODEL_BUCKET = 'furniture-models';
const MAX_MODEL_BYTES = 50 * 1024 * 1024; // matches the bucket's file_size_limit
const SESSION_KEY = 'furnishar-sb-session';

let mode = null;          // 'proxy' | 'direct' | null
let client = null;        // supabase-js client, direct mode only
let loading = null;
let session = readStoredSession();

/* ------------------------------------------------------------- transport --- */

function readStoredSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function storeSession(next) {
  session = next;
  try {
    if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* private mode */ }
}

/**
 * Decides which transport to use. The proxy is asked first: if the server holds
 * credentials, the browser never needs any.
 */
/** Set when the server has credentials but the project did not answer. */
let unavailableReason = null;

/** Why the backend is unusable, if it is. Null once prepare() has succeeded. */
export function unavailable() {
  return unavailableReason;
}

export async function prepare() {
  if (mode) return mode;
  unavailableReason = null;
  try {
    // ?probe=1 asks whether the project actually answers, not merely whether
    // the variables are present. A URL pointing at a deleted project passes the
    // plain check and then fails every real call with a 502 — which is how an
    // outage once looked like a broken sign-up form.
    const response = await fetch('/api/sb/status?probe=1', { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const status = await response.json();
      // A project that answers but rejects the key is as unusable as one that
      // does not answer at all, and failing here gives a readable message
      // instead of an authentication error on the first sign-up.
      if (status.configured && status.reachable !== false && status.keyAccepted !== false) {
        mode = 'proxy';
        return mode;
      }
      if (status.error) unavailableReason = status.error;
      else if (status.configured && status.reachable === false) {
        unavailableReason = 'The catalogue database did not respond.';
      }
    }
  } catch { /* no server route — fall through */ }

  if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) {
    await getDirectClient();
    mode = 'direct';
    return mode;
  }
  throw new Error('No Supabase backend is configured for this deployment.');
}

export function isConfigured() {
  // The server may hold the credentials, so this cannot be answered from the
  // page alone; prepare() settles it. Returning true lets the caller try.
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) || typeof fetch === 'function';
}

export function activeMode() {
  return mode;
}

async function getDirectClient() {
  if (client) return client;
  // Resolved from node_modules and bundled, not fetched from a CDN at run
  // time: one fewer third party that has to be reachable, and the version is
  // pinned in package-lock.json rather than by a URL.
  loading ||= import('@supabase/supabase-js');
  const { createClient } = await loading;
  client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return client;
}

/** One PostgREST call through the proxy, as the signed-in user when there is one. */
async function restCall(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  if (options.body) headers['Content-Type'] = 'application/json';

  const response = await fetch(`/api/sb/rest/${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (response.status === 401 && session?.refresh_token) {
    // The access token expired mid-session; renew once and retry.
    const renewed = await refreshSession();
    if (renewed) return restCall(path, options);
  }
  if (!response.ok) {
    const error = new Error(friendlyError(body || { message: `Request failed (${response.status})` }));
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return body;
}

async function authCall(action, payload) {
  const response = await fetch(`/api/sb/auth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!response.ok) {
    // An empty or non-JSON error body used to reach friendlyError as `{}` and
    // come back out as the string "[object Object]", which is what a rate-limited
    // sign-up actually showed people. Anything without a message of its own now
    // falls back to the status code.
    const detail = (body && typeof body === 'object') ? body : { message: body || '' };
    const error = new Error(friendlyError({
      ...detail,
      status: response.status,
      message: detail.message || detail.msg || detail.error_description || detail.error
        || `Request failed (${response.status}).`
    }));
    error.status = response.status;
    // GoTrue sends Retry-After on 429; seconds, so the form can count down.
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
    else if (response.status === 429) error.retryAfter = secondsFromMessage(error.message) || 60;
    throw error;
  }
  return body;
}

/** "you can only request this after 51 seconds" -> 51. */
function secondsFromMessage(message) {
  const match = /after (\d+) seconds?/i.exec(String(message || ''));
  return match ? Number(match[1]) : 0;
}

async function refreshSession() {
  if (!session?.refresh_token) return false;
  try {
    const renewed = await authCall('refresh', { refreshToken: session.refresh_token });
    if (renewed?.access_token) { storeSession(renewed); return true; }
  } catch { /* fall through */ }
  storeSession(null);
  return false;
}

/* ------------------------------------------------------------- mapping ----- */

/** Public URL for an uploaded model. The bucket is public, so no signing. */
export function modelUrl(objectPath) {
  if (!objectPath) return undefined;
  const base = CONFIG.supabaseUrl || CONFIG.storageBaseUrl || '';
  if (base) return `${base}/storage/v1/object/public/${MODEL_BUCKET}/${objectPath}`;
  // In proxy mode the project URL is not published to the page, so models are
  // fetched through the app's own origin.
  return `/api/sb/model/${objectPath}`;
}

/** A row of public.catalog in the shape the rest of the app already uses. */
export function toProduct(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    storeId: row.store_slug,
    storeUuid: row.store_id,
    store: row.store_name,
    category: row.category,
    style: row.style,
    color: row.color,
    price: Number(row.price_php),
    stock: Number(row.stock),
    dimensions: {
      width: Number(row.width_cm),
      height: Number(row.height_cm),
      depth: Number(row.depth_cm)
    },
    model: row.preview_shape,
    modelGlb: modelUrl(row.model_glb_path),
    modelUsdz: modelUrl(row.model_usdz_path),
    modelBounds: {
      width: Number(row.bounds_width_cm),
      height: Number(row.bounds_height_cm),
      depth: Number(row.bounds_depth_cm)
    },
    description: row.description || '',
    arReady: row.ar_ready,
    featured: row.featured,
    updatedAt: row.updated_at
  };
}

/** The app's product shape back into a products row. */
export function toRow(product, storeUuid) {
  return {
    store_id: storeUuid,
    slug: product.slug || slugify(product.name),
    name: product.name,
    category: product.category,
    style: product.style,
    color: product.color,
    price_php: product.price,
    stock: product.stock,
    width_cm: product.dimensions.width,
    height_cm: product.dimensions.height,
    depth_cm: product.dimensions.depth,
    bounds_width_cm: product.modelBounds?.width ?? null,
    bounds_height_cm: product.modelBounds?.height ?? null,
    bounds_depth_cm: product.modelBounds?.depth ?? null,
    preview_shape: product.model,
    description: product.description || null,
    featured: Boolean(product.featured),
    status: product.status || 'published'
  };
}

export function slugify(value) {
  return String(value).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `item-${Date.now()}`;
}

/* ----------------------------------------------------------------- data --- */

export async function listProducts() {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.from('catalog').select('*')
      .order('featured', { ascending: false }).order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data.map(toProduct);
  }
  const rows = await restCall('catalog?select=*&order=featured.desc,updated_at.desc');
  return (rows || []).map(toProduct);
}

export async function listStores() {
  const shape = store => ({
    id: store.slug,
    uuid: store.id,
    name: store.name,
    address: store.address,
    contactNumber: store.contact_number,
    hours: store.hours,
    plan: store.plan
  });
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.from('stores')
      .select('id, slug, name, address, contact_number, hours, plan').eq('status', 'active');
    if (error) throw new Error(error.message);
    return data.map(shape);
  }
  const rows = await restCall('stores?select=id,slug,name,address,contact_number,hours,plan&status=eq.active');
  return (rows || []).map(shape);
}

/** Everything the signed-in owner can edit, drafts included. */
export async function listOwnProducts(storeUuid) {
  const merge = row => toProduct({
    ...row,
    model_glb_path: row.product_assets?.find(a => a.kind === 'glb')?.object_path,
    model_usdz_path: row.product_assets?.find(a => a.kind === 'usdz')?.object_path
  });
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.from('products').select('*, product_assets(kind, object_path)')
      .eq('store_id', storeUuid).neq('status', 'archived').order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data.map(merge);
  }
  const rows = await restCall(
    `products?select=*,product_assets(kind,object_path)&store_id=eq.${storeUuid}&status=neq.archived&order=updated_at.desc`
  );
  return (rows || []).map(merge);
}

export async function saveProduct(product, storeUuid) {
  const row = toRow(product, storeUuid);
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const query = product.id
      ? supabase.from('products').update(row).eq('id', product.id).select().single()
      : supabase.from('products').insert(row).select().single();
    const { data, error } = await query;
    if (error) throw new Error(friendlyError(error));
    return data;
  }
  const result = await restCall(
    product.id ? `products?id=eq.${product.id}` : 'products',
    {
      method: product.id ? 'PATCH' : 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row)
    }
  );
  return Array.isArray(result) ? result[0] : result;
}

export async function deleteProduct(id) {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) throw new Error(friendlyError(error));
    return;
  }
  await restCall(`products?id=eq.${id}`, { method: 'DELETE' });
}

/**
 * Uploads a .glb/.usdz for a product to <store_id>/<product_id>/<file>.
 *
 * In proxy mode the server issues a one-time signed URL and the browser uploads
 * straight to Storage with it. The file never passes through the serverless
 * function — which would cap it at 4.5 MB, far below the 50 MB model limit —
 * and the key still never reaches the page.
 */
export async function uploadModel(file, { storeUuid, productId, kind = 'glb' }) {
  if (!file) throw new Error('Choose a file first.');
  if (file.size > MAX_MODEL_BYTES) {
    throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 50 MB.`);
  }
  const extension = kind === 'glb' ? 'glb' : kind === 'usdz' ? 'usdz' : 'png';
  const mime = kind === 'glb' ? 'model/gltf-binary' : kind === 'usdz' ? 'model/vnd.usdz+zip' : file.type;
  const objectPath = `${storeUuid}/${productId}/model.${extension}`;

  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { error: uploadError } = await supabase.storage.from(MODEL_BUCKET)
      .upload(objectPath, file, { contentType: mime, upsert: true, cacheControl: '3600' });
    if (uploadError) throw new Error(friendlyError(uploadError));
  } else {
    const signed = await fetch('/api/sb/storage/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {})
      },
      body: JSON.stringify({ bucket: MODEL_BUCKET, objectPath })
    }).then(r => r.json().then(body => ({ ok: r.ok, body })));
    if (!signed.ok) throw new Error(friendlyError(signed.body));

    const upload = await fetch(signed.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'x-upsert': 'true' },
      body: file
    });
    if (!upload.ok) throw new Error(`The model could not be uploaded (${upload.status}).`);
  }

  // store_id is set by a trigger from the product, so it cannot be spoofed here.
  const assetRow = {
    product_id: productId,
    store_id: storeUuid,
    kind,
    bucket: MODEL_BUCKET,
    object_path: objectPath,
    byte_size: file.size,
    mime_type: mime
  };
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { error } = await supabase.from('product_assets').upsert(assetRow, { onConflict: 'product_id,kind' });
    if (error) throw new Error(friendlyError(error));
  } else {
    await restCall('product_assets?on_conflict=product_id,kind', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(assetRow)
    });
  }
  return { objectPath, url: modelUrl(objectPath) };
}

/* ----------------------------------------------------------------- auth --- */

export async function signUp({ email, password, storeName, phone, message }) {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.auth.signUp({
      email, password, options: { data: { store_name: storeName, contact_phone: phone } }
    });
    if (error) throw new Error(friendlyError(error));
    await supabase.from('store_applications').insert({
      store_name: storeName, contact_email: email, contact_phone: phone || null, message: message || null
    });
    return { user: data.user, needsEmailConfirmation: Boolean(data.user && !data.session) };
  }

  const result = await authCall('signup', { email, password, storeName, phone });
  if (result.access_token) storeSession(result);

  // The account exists but owns nothing yet; the application is what an admin
  // reviews before linking it to a store.
  //
  // Crucially this must not throw. Sign-up is two writes, and the account is
  // already created by the time we get here — reporting a failed second write
  // as a failed sign-up sends people round again, where Supabase answers
  // "already registered" or rate-limits them. That is the 400-then-429 loop
  // this endpoint used to produce. Report it instead, and let the portal say
  // the account is fine and the application needs a follow-up.
  let applicationFiled = true;
  let applicationError = null;
  try {
    await restCall('store_applications', {
      method: 'POST',
      body: JSON.stringify({
        store_name: storeName, contact_email: email,
        contact_phone: phone || null, message: message || null
      })
    });
  } catch (error) {
    // A duplicate means a previous attempt already filed it, which is fine.
    if (!/duplicate key/i.test(error.message)) {
      applicationFiled = false;
      applicationError = error.message;
      console.warn('[FurnishAR] the account was created but its store application was not filed:', error.message);
    }
  }

  return {
    user: result.user,
    needsEmailConfirmation: Boolean(result.user && !result.access_token),
    applicationFiled,
    applicationError
  };
}

export async function signIn({ email, password }) {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendlyError(error));
    return data;
  }
  const result = await authCall('login', { email, password });
  storeSession(result);
  return result;
}

export async function signOut() {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    await supabase.auth.signOut();
    return;
  }
  try { await authCall('logout', { accessToken: session?.access_token }); } catch { /* already gone */ }
  storeSession(null);
}

export async function getSession() {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data } = await supabase.auth.getSession();
    return data.session || null;
  }
  if (!session) return null;
  // Renew a session that is within a minute of expiring.
  const expiresAt = (session.expires_at || 0) * 1000;
  if (expiresAt && expiresAt - Date.now() < 60_000) await refreshSession();
  return session;
}

/** The store this signed-in user may act for, or null while unapproved. */
export async function getMembership() {
  const shape = row => row && {
    role: row.role,
    storeUuid: row.stores.id,
    storeId: row.stores.slug,
    store: row.stores.name,
    plan: row.stores.plan
  };
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.from('store_members')
      .select('role, stores(id, slug, name, plan)').limit(1).maybeSingle();
    // A newly created account has no membership until an administrator
    // approves its store. Treat a temporarily missing schema object the same
    // way so the portal can show the review state instead of looping errors.
    if (error) {
      if (error.code === '42P01' || /schema cache|relation .* does not exist/i.test(error.message || '')) return null;
      throw new Error(friendlyError(error));
    }
    return shape(data);
  }
  if (!session) return null;
  let rows;
  try {
    rows = await restCall('store_members?select=role,stores(id,slug,name,plan)&limit=1');
  } catch (error) {
    if (error.status === 404 || error.code === '42P01' || /schema cache|relation .* does not exist/i.test(error.message || '')) return null;
    throw error;
  }
  return shape((rows || [])[0]);
}

export async function onAuthChange(handler) {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    supabase.auth.onAuthStateChange((event, next) => handler(event, next));
    return;
  }
  // Proxy mode keeps the session in this tab; mirror sign-in/out across tabs.
  window.addEventListener('storage', event => {
    if (event.key !== SESSION_KEY) return;
    session = readStoredSession();
    handler(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
  });
}

/* ------------------------------------------------------------- realtime --- */

/**
 * Live catalogue. Realtime needs a direct websocket to Supabase, which would
 * require the key in the page — so in proxy mode the catalogue is polled
 * instead. Slower to update, but the key stays hidden.
 */
export async function subscribeToCatalog(handler) {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const channel = supabase.channel('catalog-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, handler)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_assets' }, handler)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }
  const timer = setInterval(() => handler({ source: 'poll' }), 60_000);
  return () => clearInterval(timer);
}

/* ---------------------------------------------------------------- errors --- */

/** Turns Postgres and GoTrue errors into something a shop owner can act on. */
export function friendlyError(error) {
  const message = error?.message || error?.error_description || error?.msg || error?.error || String(error);
  const code = error?.error_code || error?.code || '';

  // Rate limits first: Supabase is strict about auth, and a person who is told
  // only "400" will click again and make it worse.
  if (error?.status === 429 || /rate.?limit|too many requests/i.test(`${code} ${message}`)) {
    const wait = /after (\d+) seconds?/i.exec(message);
    const when = wait ? `about ${wait[1]} seconds` : 'a few minutes';
    if (/email/i.test(`${code} ${message}`)) {
      return `Supabase is limiting confirmation emails to this address. Wait ${when} and try again — your account may already have been created, so try signing in first.`;
    }
    return `Too many attempts. Wait ${when} and try again.`;
  }

  if (/email_address_invalid|invalid format/i.test(`${code} ${message}`)) {
    return 'That email address was rejected. Check it for typos.';
  }
  if (/weak_password/i.test(code)) return 'Use a longer password — at least 6 characters.';
  if (/signup_disabled|Signups not allowed/i.test(`${code} ${message}`)) {
    return 'Sign-ups are turned off for this project. Enable email sign-ups in Supabase → Authentication → Providers.';
  }
  if (/user_already_exists/i.test(code)) {
    return 'An account already exists for that email. Sign in instead.';
  }
  if (/Freemium plan limited/i.test(message)) return message;
  if (/premium plan feature/i.test(message)) return 'Featured placement is available on the premium plan.';
  if (/duplicate key.*products_store_id_slug/i.test(message)) return 'You already have a product with that name.';
  if (/row-level security/i.test(message)) return 'That item belongs to another store.';
  if (/Invalid login credentials/i.test(message)) return 'That email and password do not match an account.';
  if (/User already registered/i.test(message)) return 'An account already exists for that email. Sign in instead.';
  if (/Password should be at least/i.test(message)) return 'Use a password of at least 6 characters.';
  if (/Email not confirmed/i.test(message)) return 'Confirm your email address first — check your inbox.';
  if (/exceeded the maximum allowed size|Payload too large/i.test(message)) return 'That model is larger than the 50 MB limit.';
  return message;
}
