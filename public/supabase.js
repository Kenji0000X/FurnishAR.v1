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
// Matches the bucket's file_size_limit (supabase/migrations/0005_raise_model_limit.sql).
// Checked here too so an oversized file is refused before spending any of the
// upload — on a slow connection, finding out after ten minutes is its own
// kind of broken.
const MAX_MODEL_BYTES = 100 * 1024 * 1024;
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
async function restCall(path, options = {}, retried = false) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  if (options.body) headers['Content-Type'] = 'application/json';

  const response = await fetch(`/api/sb/rest/${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (response.status === 401 && !retried && session?.refresh_token) {
    // The access token expired mid-session; renew once and retry. refreshSession
    // is shared, so several calls expiring together renew once between them
    // rather than racing to spend the same rotating refresh token.
    // `retried` stops this from recursing if the renewed token is refused too.
    const renewed = await refreshSession();
    if (renewed) return restCall(path, options, true);
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

/** The one refresh allowed to be in flight at a time. See refreshSession(). */
let refreshInFlight = null;

/**
 * Renews the access token — at most once at a time, deliberately.
 *
 * GoTrue ROTATES refresh tokens: spending R1 issues R2 and invalidates R1. The
 * dashboard fires several requests at once (the console alone loads six in a
 * Promise.all), so when a token expires they all 401 together. Without this
 * guard each one spent the same R1: the first won, and every other came back
 * with GoTrue's `400 Invalid Refresh Token: Already Used` — which the caller
 * then surfaced as a bare "JWT expired", and whose storeSession(null) could
 * wipe the perfectly good session the winner had just stored. That is the
 * 401 -> refresh 400 -> 401 loop, and it needed nothing more exotic than two
 * requests landing in the same second.
 *
 * So: one refresh, shared. Everyone else waits for its answer.
 */
function refreshSession() {
  if (!session?.refresh_token) return Promise.resolve(false);
  if (refreshInFlight) return refreshInFlight;

  const spending = session.refresh_token;
  refreshInFlight = (async () => {
    try {
      const renewed = await authCall('refresh', { refreshToken: spending });
      if (!renewed?.access_token) throw new Error('the refresh returned no access token');
      storeSession(renewed);
      return true;
    } catch (error) {
      // If the stored token has moved on while this was in flight, another
      // refresh already succeeded and this failure is only GoTrue refusing the
      // duplicate. Keep the good session rather than signing the person out.
      if (session?.refresh_token && session.refresh_token !== spending) return true;
      storeSession(null);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
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
 * PUTs a file to a signed Storage URL and reports real progress.
 *
 * `fetch` has no upload-progress event — the browser hands the body to the
 * network layer and tells you nothing until it's over — which is fine for a
 * kilobyte JSON body and wrong for a 100 MB model on a mobile connection. A
 * few minutes of a status line that never changes reads as frozen, not
 * working, and someone frozen on a slow connection will reload the page and
 * try again, doubling the upload for nothing. XMLHttpRequest is the one
 * browser primitive that still exposes progress on an upload body, so this
 * is the one place in the app that reaches for it instead of fetch.
 */
function putWithProgress(url, file, mime, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mime);
    xhr.setRequestHeader('x-upsert', 'true');
    // Same ceiling GoTrue/PostgREST calls don't need, because those are small
    // and fast; a big file on a bad connection can legitimately take minutes,
    // but a connection that has gone fully silent should not hang forever.
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      // Storage says WHY in the body — "The object exceeded the maximum
      // allowed size", "mime type not supported", a policy refusal. Throwing
      // away that body and reporting only the status code is what made a
      // failed upload impossible to diagnose from the browser.
      let detail = null;
      try { detail = JSON.parse(xhr.responseText); } catch { detail = xhr.responseText || null; }
      const reason = (detail && typeof detail === 'object')
        ? (detail.message || detail.error || detail.msg || '')
        : String(detail || '');
      const error = new Error(reason
        ? friendlyError({ message: reason, status: xhr.status })
        : `The model could not be uploaded (${xhr.status}).`);
      error.status = xhr.status;
      reject(error);
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('The upload stalled and timed out. Check your connection and try again.'));
    xhr.send(file);
  });
}

/**
 * Uploads a .glb/.usdz for a product to <store_id>/<product_id>/<file>.
 *
 * In proxy mode the server issues a one-time signed URL and the browser uploads
 * straight to Storage with it. The file never passes through the serverless
 * function — which would cap it at 4.5 MB, far below the 100 MB model limit —
 * and the key still never reaches the page. Uploading fifty of these is fifty
 * independent requests straight to object storage; nothing here is shared or
 * serialised, so one owner's big file does not slow another's.
 *
 * `onProgress`, if given, is called with a 0–1 fraction as the upload runs.
 */
export async function uploadModel(file, { storeUuid, productId, kind = 'glb', onProgress } = {}) {
  if (!file) throw new Error('Choose a file first.');
  if (file.size > MAX_MODEL_BYTES) {
    throw new Error(
      `That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_MODEL_BYTES / 1048576} MB.`
    );
  }
  const extension = kind === 'glb' ? 'glb' : kind === 'usdz' ? 'usdz' : 'png';
  const mime = kind === 'glb' ? 'model/gltf-binary' : kind === 'usdz' ? 'model/vnd.usdz+zip' : file.type;
  const objectPath = `${storeUuid}/${productId}/model.${extension}`;
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  if (mode === 'direct') {
    const supabase = await getDirectClient();
    // supabase-js's own upload() has no progress callback either; direct mode
    // is the legacy path and is not worth doubling this machinery for.
    const { error: uploadError } = await supabase.storage.from(MODEL_BUCKET)
      .upload(objectPath, file, { contentType: mime, upsert: true, cacheControl: '3600' });
    if (uploadError) throw new Error(friendlyError(uploadError));
    report(1);
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

    await putWithProgress(signed.body.uploadUrl, file, mime, report);
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

  // Session problems, before the row-level-security mapping below and not
  // after it. An expired token makes auth.uid() null, which makes every
  // is_store_member() check false, which makes an ordinary save fail RLS — so
  // an expired session used to be reported as "that item belongs to another
  // store", sending people to hunt a permissions problem they did not have.
  if (/JWT expired|PGRST301|invalid claim|JWSError|jwt malformed|bad_jwt/i.test(`${code} ${message}`)) {
    return 'Your session expired. Sign in again, then retry — nothing was saved.';
  }
  if (/Invalid Refresh Token|refresh_token_not_found|Already Used/i.test(`${code} ${message}`)) {
    return 'Your session ended. Sign in again to continue.';
  }

  // Reached only when the caller really is signed in and really is reaching
  // for another shop's row — but say the other possibility too, because from
  // the outside the two look identical.
  if (/row-level security/i.test(message)) {
    return 'That item belongs to another store. If it is yours, your session may have expired — sign in again and retry.';
  }
  if (/Invalid login credentials/i.test(message)) return 'That email and password do not match an account.';
  if (/User already registered/i.test(message)) return 'An account already exists for that email. Sign in instead.';
  if (/Password should be at least/i.test(message)) return 'Use a password of at least 6 characters.';
  if (/Email not confirmed/i.test(message)) return 'Confirm your email address first — check your inbox.';
  // Reads the constant rather than repeating the number, which is how this
  // came to still say 50 after the bucket was raised to 100.
  //
  // Storage enforces the BUCKET's file_size_limit, which is a different number
  // from this app's MAX_MODEL_BYTES and only matches it once
  // 0005_raise_model_limit.sql has actually been run against the project. A
  // file that passes the check in uploadModel() and is then refused here means
  // exactly that gap, so say so instead of quoting a limit the server does not
  // agree with.
  if (/exceeded the maximum allowed size|Payload too large/i.test(message)) {
    return `Supabase refused that model as too large. This app allows ${MAX_MODEL_BYTES / 1048576} MB, `
      + 'but the storage bucket enforces its own limit — if it still refuses a file under that, run '
      + 'supabase/migrations/0005_raise_model_limit.sql against the project to raise the bucket to 100 MB.';
  }
  return message;
}

/* ---------------------------------------------------------------- admin ----
   The superadmin portal.

   Nothing here grants anything. Every call below is refused by row level
   security unless the signed-in account is in platform_admins — see
   supabase/migrations/0003_platform_admin.sql. `isPlatformAdmin()` decides
   which portal to *render*; it is not what protects the data, and a browser
   that lies about it still gets nothing back.
--------------------------------------------------------------------------- */

/** Is the signed-in account a platform administrator? */
export async function isPlatformAdmin() {
  if (!session) return false;
  try {
    if (mode === 'direct') {
      const supabase = await getDirectClient();
      const { data, error } = await supabase.rpc('is_platform_admin');
      if (error) throw error;
      return Boolean(data);
    }
    return Boolean(await restCall('rpc/is_platform_admin', { method: 'POST', body: '{}' }));
  } catch {
    // A failure here must read as "not an admin", never as "assume yes".
    return false;
  }
}

/** The sign-up queue. Admin-only; anyone else gets an empty list. */
export async function listApplications(status = 'pending') {
  const query = status
    ? `store_applications?status=eq.${encodeURIComponent(status)}&order=created_at.asc`
    : 'store_applications?order=created_at.desc';
  return (await restCall(query)) || [];
}

/**
 * What the applicant's account looks like: does it exist, have they proved
 * they own the address, have they ever signed in.
 *
 * `auth.users` is readable by nobody; this goes through a security-definer
 * function that answers for one application at a time and returns only those
 * few facts. Approving re-checks them in the same transaction, so this is for
 * the reviewer's eyes, not the gate.
 */
export async function applicantAccount(applicationId) {
  const body = JSON.stringify({ application: applicationId });
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.rpc('applicant_account', { application: applicationId });
    if (error) throw new Error(friendlyError(error));
    return data;
  }
  return restCall('rpc/applicant_account', { method: 'POST', body });
}

/** Every store, including suspended ones the public policy hides. */
export async function listAllStores() {
  return (await restCall('stores?select=id,slug,name,plan,status,created_at&order=name.asc')) || [];
}

/**
 * Every 3D model uploaded, across every store, newest first — so the operator
 * can spot an oversized file or a listing nobody attached a model to, without
 * going shop by shop with database credentials.
 *
 * Read-only, and stays that way: 0004_admin_model_visibility.sql adds only a
 * SELECT policy. This function has no counterpart that writes someone else's
 * product; removing or replacing a model is still the owning store's job.
 */
export async function listUploadedModels(limit = 200) {
  const query =
    'product_assets?select=id,kind,object_path,byte_size,mime_type,created_at,' +
    'product:products(name,slug,status,store:stores(name,slug))' +
    `&order=created_at.desc&limit=${Number(limit) || 200}`;
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.from('product_assets')
      .select('id,kind,object_path,byte_size,mime_type,created_at,product:products(name,slug,status,store:stores(name,slug))')
      .order('created_at', { ascending: false })
      .limit(Number(limit) || 200);
    if (error) throw new Error(friendlyError(error));
    return data || [];
  }
  return (await restCall(query)) || [];
}

/** Every product with no model file attached — the gap the queue above can't show. */
export async function listMissingModels(limit = 200) {
  const query =
    'products?select=id,name,slug,status,store:stores(name,slug),product_assets(kind)' +
    `&order=created_at.desc&limit=${Number(limit) || 200}`;
  const rows = mode === 'direct'
    ? await (async () => {
        const supabase = await getDirectClient();
        const { data, error } = await supabase.from('products')
          .select('id,name,slug,status,store:stores(name,slug),product_assets(kind)')
          .order('created_at', { ascending: false })
          .limit(Number(limit) || 200);
        if (error) throw new Error(friendlyError(error));
        return data || [];
      })()
    : (await restCall(query)) || [];
  return rows.filter(row => !(row.product_assets || []).some(asset => asset.kind === 'glb'));
}

/**
 * Bytes uploaded per store, largest first — so a per-file cap that just went
 * up from 50 MB to 100 MB does not turn into a surprise against the project's
 * storage quota with nobody watching for it.
 */
export async function listStorageUsage() {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.rpc('storage_usage');
    if (error) throw new Error(friendlyError(error));
    return data || [];
  }
  return (await restCall('rpc/storage_usage', { method: 'POST', body: '{}' })) || [];
}

/** Recent administrative decisions, newest first. */
export async function listAudit(limit = 25) {
  return (await restCall(`admin_audit?order=at.desc&limit=${Number(limit) || 25}`)) || [];
}

/**
 * Approves an application: creates the store, links the applicant's account as
 * its owner, closes the application and writes the audit row — all in one
 * transaction, inside the database.
 */
export async function approveApplication(applicationId, storeSlug) {
  const body = JSON.stringify({ application: applicationId, store_slug: storeSlug || null });
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.rpc('approve_store_application', {
      application: applicationId, store_slug: storeSlug || null
    });
    if (error) throw new Error(friendlyError(error));
    return data;
  }
  return restCall('rpc/approve_store_application', { method: 'POST', body });
}

/** Rejects an application, with a note the reviewer can look back on. */
export async function rejectApplication(applicationId, note) {
  const body = JSON.stringify({ application: applicationId, note: note || null });
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.rpc('reject_store_application', {
      application: applicationId, note: note || null
    });
    if (error) throw new Error(friendlyError(error));
    return data;
  }
  return restCall('rpc/reject_store_application', { method: 'POST', body });
}
