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

import { MODEL_UPLOAD_LIMIT_BYTES } from './model-limits.mjs';

const CONFIG = (typeof window !== 'undefined' && window.FURNISHAR_CONFIG) || {};
const MODEL_BUCKET = 'furniture-models';
// The one upload limit (./model-limits.mjs explains the three numbers behind
// it). Checked here too so an oversized file is refused before spending any of
// the upload — on a slow connection, finding out after ten minutes is its own
// kind of broken.
const MAX_MODEL_BYTES = MODEL_UPLOAD_LIMIT_BYTES;
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
  if (next) lapsed = false;   // signed in again: nothing has lapsed
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
/**
 * True only for an OUTAGE: the project did not answer, or nothing did. A
 * project that answers but rejects the key is a configuration problem —
 * permanent until someone fixes it, so "Try again" would be a false promise.
 */
let outageDetected = false;
/** Whether the server holds database credentials at all, working or not. */
let serverHasDatabase = false;
/** Where catalogue posters are served from (0012); reported by the server. */
let posterBase = null;

/** Why the backend is unusable, if it is. Null once prepare() has succeeded. */
export function unavailable() {
  return unavailableReason;
}

/** Whether the backend is unusable because it did not answer (see above). */
export function isOutage() {
  return outageDetected;
}

/** Whether this deployment HAS a database, working or not. */
export function databaseConfigured() {
  return serverHasDatabase;
}

export async function prepare() {
  if (mode) return mode;
  unavailableReason = null;
  outageDetected = false;
  try {
    // ?probe=1 asks whether the project actually answers, not merely whether
    // the variables are present. A URL pointing at a deleted project passes the
    // plain check and then fails every real call with a 502 — which is how an
    // outage once looked like a broken sign-up form.
    const response = await fetch('/api/sb/status?probe=1', { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const status = await response.json();
      serverHasDatabase = Boolean(status.configured);
      posterBase = status.posterBase || null;
      // A project that answers but rejects the key is as unusable as one that
      // does not answer at all, and failing here gives a readable message
      // instead of an authentication error on the first sign-up.
      if (status.configured && status.reachable !== false && status.keyAccepted !== false) {
        mode = 'proxy';
        return mode;
      }
      if (status.configured && status.reachable === false) outageDetected = true;
      if (status.error) unavailableReason = status.error;
      else if (status.configured && status.reachable === false) {
        unavailableReason = 'The catalogue database did not respond.';
      }
    }
  } catch (error) {
    /* No answer at all. Offline is an outage, not "this site has no
       database" — the two need different screens (backend.js). */
    if (error instanceof TypeError) {
      outageDetected = true;
      unavailableReason = 'The server could not be reached. Check your internet connection.';
    }
  }

  if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) {
    posterBase = `${CONFIG.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/product-posters/`;
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
 * Set when GoTrue REFUSED to renew a session this tab held.
 *
 * That is how a session usually ends for real: the access token runs out,
 * the renewal is refused (signed out on another device, or the project's
 * session limit), and the session is dropped. Once it is dropped nothing is
 * held any more — which, without this, looks exactly like a first visit, and
 * the person is shown a generic "sign in" instead of "your session expired".
 * Read and cleared by app/alerts/sessionExpiry.js.
 */
let lapsed = false;
export function sessionLapsed() { return lapsed; }
export function forgetLapsedSession() { lapsed = false; }

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
      // A renewal that never got an answer — offline, or GoTrue having a bad
      // minute — says nothing about the session. Dropping it here used to
      // sign people out for a network blip.
      if (error instanceof TypeError || !(error?.status < 500)) return false;
      lapsed = true;
      storeSession(null);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/* ------------------------------------------------------------- mapping ----- */

/**
 * A reference to an uploaded model — never the file's own URL.
 *
 * The bucket is private (0007); a model is opened by trading this reference
 * for a short-lived signed URL with resolveModelUrl() below, which only works
 * for a signed-in account the storage policy allows. Kept identical to
 * modelUrl() in lib/catalog.mjs.
 */
export function modelUrl(objectPath) {
  if (!objectPath) return undefined;
  return `/api/sb/model/${objectPath}`;
}

/**
 * Trade a model reference for a URL the loader can fetch.
 *
 * A reference that is not one of ours (the demo catalogue's bundled model,
 * or an absolute URL) is returned as it is — there is nothing to authorise.
 * For our own references the current access token goes along, and what comes
 * back is either a five-minute signed URL or an Error carrying `status` and a
 * `code` — auth_required, session_expired, unavailable, upstream — that the
 * caller turns into a sentence through lib/alerts/messages.mjs. The raw
 * server response is never shown to anyone.
 */
export async function resolveModelUrl(reference) {
  if (!reference || !reference.startsWith('/api/sb/model/')) return reference;
  const current = await getSession().catch(() => null);
  const token = current?.access_token;
  const response = await fetch(reference, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' },
    cache: 'no-store'
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.ok && body?.url) return body.url;
  const error = new Error(body?.code || `HTTP ${response.status}`);
  error.status = response.status;
  error.code = body?.code || (response.status === 401 ? 'auth_required' : 'upstream');
  throw error;
}

/**
 * The public address of a catalogue poster (0012), or null. Posters are
 * public and content-addressed; models never are. Kept identical to
 * posterUrl() in lib/catalog.mjs.
 */
export function posterUrl(posterPath) {
  if (!posterPath || !posterBase) return null;
  return `${posterBase}${posterPath}`;
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
    // 0009: 'stocked' sells from the shelf, 'custom' builds to order.
    fulfilment: row.store_fulfilment || 'stocked',
    // 0011: a CONNECTED PayPal seller account. Older views lack the column;
    // undefined then reads as "unknown", and the server decides at checkout.
    paymentsReady: row.store_payments_ready ?? null,
    storeContact: row.store_contact_number || null,
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
    arReady: Boolean(row.model_glb_path),
    // Same rule as lib/catalog.mjs: a poster is shown only with its model.
    thumbnail: row.model_glb_path ? posterUrl(row.poster_path) : null,
    posterPath: row.poster_path || null,
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
    model_usdz_path: row.product_assets?.find(a => a.kind === 'usdz')?.object_path,
    poster_path: row.product_assets?.find(a => a.kind === 'poster')?.object_path
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
function putWithProgress(url, file, mime, onProgress, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mime);
    xhr.setRequestHeader('x-upsert', 'true');
    for (const [name, value] of Object.entries(extraHeaders)) xhr.setRequestHeader(name, value);
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
/**
 * Is this actually a .glb?
 *
 * A .glb is a container with a fixed 12-byte header: the ASCII magic "glTF",
 * a version, and the total byte length of the file. Reading it costs one slice
 * and catches what people really upload by mistake — a .gltf JSON renamed, a
 * zip, a half-finished download, a file that stopped copying — before any of
 * it is stored, and long before a shopper points a camera at it and is told
 * their device is at fault. Storage checks the mime type the browser claims;
 * it does not look inside, so nothing else in the chain does this.
 */
async function assertUsableGlb(file, kind) {
  if (kind !== 'glb') return;
  let header;
  try {
    header = new DataView(await file.slice(0, 12).arrayBuffer());
  } catch {
    throw new Error('That file could not be read. Try choosing it again.');
  }
  if (header.byteLength < 12) throw new Error('That file is too small to be a .glb model.');

  // 0x46546C67 is "glTF" read little-endian.
  if (header.getUint32(0, true) !== 0x46546c67) {
    throw new Error(
      'That is not a .glb model. Export it as binary glTF (.glb) — a .gltf, .zip or .obj will not work in AR.'
    );
  }
  // Only a file SHORTER than its header claims is definitely broken — that is
  // a transfer that stopped early, and three.js will fail on it. A file longer
  // than its declared length is unusual but not fatal: some exporters pad, and
  // the loader reads the declared length and ignores the rest. Refusing those
  // would reject working models, which is a worse failure than accepting an
  // odd one.
  const declaredLength = header.getUint32(8, true);
  if (declaredLength > file.size) {
    throw new Error(
      `That .glb is incomplete — its header declares ${declaredLength} bytes but the file is only ${file.size}. `
      + 'The download or export probably stopped early; get it again and retry.'
    );
  }
}

export async function uploadModel(file, { storeUuid, productId, kind = 'glb', onProgress } = {}) {
  if (!file) throw new Error('Choose a file first.');
  await assertUsableGlb(file, kind);
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

  // Read it back before calling this a success.
  //
  // An upload is two writes — the file into Storage, the row that points at
  // it — and the model is invisible to AR unless BOTH landed. A file with no
  // row is exactly the state that produces "this piece has no 3D model
  // uploaded yet" for a model the owner watched upload to 100%, with nothing
  // anywhere saying which of the two went missing. One small read closes that:
  // whatever the reason, the owner is told now, while the file is still in the
  // picker, instead of discovering it with a camera pointed at a wall.
  const linked = await listAssetPaths(productId, kind);
  if (!linked.length) {
    throw new Error(
      'The file uploaded, but it could not be linked to this product, so AR will not find it. '
      + 'Save again — if it keeps happening, the product may have been removed underneath it.'
    );
  }

  return { objectPath, url: modelUrl(objectPath) };
}

/** The stored asset paths for one product and kind. Empty means nothing linked. */
async function listAssetPaths(productId, kind) {
  try {
    if (mode === 'direct') {
      const supabase = await getDirectClient();
      const { data } = await supabase.from('product_assets')
        .select('object_path').eq('product_id', productId).eq('kind', kind);
      return data || [];
    }
    return (await restCall(
      `product_assets?select=object_path&product_id=eq.${productId}&kind=eq.${kind}`
    )) || [];
  } catch {
    // The row may well be there and only the read refused. Saying "it did not
    // link" on a failed read would be its own false alarm, so an unreadable
    // answer counts as linked and the portal's own listing will show the truth.
    return [{ unverified: true }];
  }
}

/**
 * The catalogue poster for a product (0012): a small image rendered from its
 * own model in the owner's browser. Uploaded to the public product-posters
 * bucket under a name made from its contents, then linked by the server,
 * which also removes the poster it replaced.
 *
 * Separate from uploadModel on purpose: a model that uploaded is a model
 * that works in AR, whatever happens to its picture. The caller reports a
 * failure here as "the preview could not be created", never as a failed model.
 */
export async function uploadPoster(blob, { storeUuid, productId } = {}) {
  if (!blob || !blob.size) throw new Error('There is no preview to upload.');
  const extension = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const hash = [...digest.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const objectPath = `${storeUuid}/${productId}/poster-${hash}.${extension}`;
  const token = session?.access_token;

  const signed = await fetch('/api/sb/storage/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ bucket: 'product-posters', objectPath })
  }).then(r => r.json().then(body => ({ ok: r.ok, body })));
  if (!signed.ok) throw new Error(friendlyError(signed.body));
  // Immutable: the name changes whenever the picture does.
  await putWithProgress(signed.body.uploadUrl, blob, blob.type || 'image/webp', () => {},
    { 'cache-control': 'public, max-age=31536000, immutable' });

  const linked = await fetch('/api/sb/models/poster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ objectPath, byteSize: blob.size })
  }).then(r => r.json().then(body => ({ ok: r.ok, body })));
  if (!linked.ok) throw new Error(linked.body?.error || 'The preview could not be linked to this product.');
  return { objectPath, url: posterUrl(objectPath) };
}

/**
 * Ask the server to refresh the cached catalogue after this store changed it
 * — a product saved, a model uploaded, a product deleted — so the change is
 * on the collection page for the next visitor instead of in up to a minute.
 * Advisory: if it fails, the normal 60-second refresh still happens.
 */
export async function refreshCatalog() {
  try {
    const token = session?.access_token;
    await fetch('/api/sb/models/revalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: '{}'
    });
  } catch { /* the 60-second refresh covers it */ }
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

/**
 * Asks Supabase to send the account-confirmation email again.
 *
 * The gap this closes: `approve_store_application` refuses an applicant whose
 * email is not confirmed, correctly — but until now there was nothing to do
 * about that except wait, because the confirmation email is a one-shot thing
 * Supabase sends once at sign-up. If it landed in spam, or the applicant
 * mistyped nothing but simply never saw it, the application sat "pending"
 * forever with no way forward for the applicant or the admin reviewing them.
 *
 * Deliberately does not throw on "already confirmed" — asking again for
 * something that already happened is not a failure worth alarming anyone
 * over, and the caller (sign-up panel or admin console) already knows to
 * re-check rather than trust this call's success alone.
 */
export async function resendConfirmation(email) {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { error } = await supabase.auth.resend({ type: 'signup', email });
    if (error && !/already confirmed/i.test(error.message || '')) throw new Error(friendlyError(error));
    return true;
  }
  try {
    await authCall('resend', { email });
  } catch (error) {
    if (!/already confirmed/i.test(error.message || '')) throw error;
  }
  return true;
}

/**
 * Signs up a shopper.
 *
 * One write, not two. The name and municipality travel as account metadata
 * and 0006's trigger turns them into the buyers row inside the same
 * transaction that creates the account — so there is no window where the
 * account exists and the profile does not, and no second call that could fail
 * after the password has already been accepted. Store sign-up above has that
 * second write and has the scar tissue to prove it.
 */
export async function signUpBuyer({ email, password, fullName, municipality }) {
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { role: 'buyer', full_name: fullName, municipality } }
    });
    if (error) throw new Error(friendlyError(error));
    return { user: data.user, needsEmailConfirmation: Boolean(data.user && !data.session) };
  }

  const result = await authCall('signup', {
    role: 'buyer', email, password, fullName, municipality
  });
  if (result.access_token) storeSession(result);
  return {
    user: result.user,
    needsEmailConfirmation: Boolean(result.user && !result.access_token)
  };
}

/**
 * What kind of account is signed in: guest | buyer | owner | admin | pending.
 *
 * The server answers this, from the tables. Nothing here is decided by what
 * the browser remembers about how someone signed up — an account is a buyer
 * because it has a buyers row, not because a form said so an hour ago.
 */
export async function myRole() {
  if (!session && mode !== 'direct') return 'guest';
  try {
    if (mode === 'direct') {
      const supabase = await getDirectClient();
      const { data, error } = await supabase.rpc('my_role');
      if (error) throw error;
      return String(data || 'guest');
    }
    return String(await restCall('rpc/my_role', { method: 'POST', body: '{}' }) || 'guest');
  } catch (error) {
    // A REFUSAL reads as "not signed in", never as "assume allowed": the
    // token is no good, so nobody is.
    if (error?.status === 401 || error?.status === 403 || /^PGRST30/.test(error?.code || '')) return 'guest';
    // An UNANSWERED question is not an answer. Offline, or the database
    // down, says nothing about who this is — and reading it as 'guest' is
    // how an outage used to be announced as "your session has expired",
    // followed by signing the person out. Callers say what really happened.
    const unreachable = new Error('The server could not be reached.');
    unreachable.code = 'unreachable';
    unreachable.status = error?.status || 0;
    throw unreachable;
  }
}

/** The signed-in shopper's own row, or null. RLS returns nobody else's. */
export async function buyerProfile() {
  if (!session && mode !== 'direct') return null;
  try {
    if (mode === 'direct') {
      const supabase = await getDirectClient();
      const { data } = await supabase.from('buyers')
        .select('full_name,municipality,created_at').maybeSingle();
      return data || null;
    }
    const rows = await restCall('buyers?select=full_name,municipality,created_at&limit=1');
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * Edits the signed-in shopper's own row.
 *
 * There is no `user_id` in what this sends, and that is the point: the update
 * policy is `user_id = auth.uid()`, so the row this reaches is decided by the
 * token, never by anything the browser names. Passing an id would not let a
 * caller edit somebody else's row — it would simply match nothing.
 */
export async function updateBuyerProfile({ fullName, municipality }) {
  const patch = { full_name: fullName, municipality };
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('buyers').update(patch).eq('user_id', user.id);
    if (error) throw new Error(friendlyError(error));
    return true;
  }
  /* Filtered explicitly, even though RLS already scopes an unfiltered PATCH
     to the caller's own row. An unfiltered update is the kind of statement
     that is correct only as long as a policy stays correct, and this one is
     one dropped policy away from rewriting every shopper's town. */
  const id = session?.user?.id;
  if (!id) throw new Error('Sign in before changing your details.');
  await restCall(`buyers?user_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch)
  });
  return true;
}

/**
 * The municipalities the sign-up form offers.
 *
 * Read from the table rather than hard-coded here, so the form and the check
 * constraint behind it cannot drift into disagreeing about what a valid town
 * is — which would show a shopper a choice the database then refuses.
 */
export async function listMunicipalities() {
  try {
    if (mode === 'direct') {
      const supabase = await getDirectClient();
      const { data } = await supabase.from('municipalities').select('name').order('name');
      return (data || []).map(row => row.name);
    }
    const rows = await restCall('municipalities?select=name&order=name.asc');
    return Array.isArray(rows) ? rows.map(row => row.name) : [];
  } catch {
    return [];
  }
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
  if (/Invalid login credentials/i.test(message)) return 'Invalid email or password.';
  if (/User already registered/i.test(message)) return 'An account already exists for that email. Sign in instead.';
  if (/Password should be at least/i.test(message)) return 'Use a password of at least 6 characters.';
  if (/Email not confirmed/i.test(message)) return 'Confirm your email address first — check your inbox.';
  // Reads the constant rather than repeating the number. A file that passes
  // the check in uploadModel() and is then refused here means the bucket's own
  // file_size_limit is below this app's, so say that instead of quoting a
  // limit the server does not agree with.
  if (/exceeded the maximum allowed size|Payload too large/i.test(message)) {
    return `Supabase refused that model as too large. This app uploads models up to ${MAX_MODEL_BYTES / 1048576} MB, `
      + 'which is under the storage limit of every Supabase plan, so the bucket\'s own limit has been set lower. '
      + 'Check file_size_limit on the furniture-models bucket (supabase/migrations/0005_raise_model_limit.sql).';
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
    'product:products(id,name,slug,status,store:stores(name,slug))' +
    // 3D files only: catalogue posters (0012) are pictures, not models.
    `&kind=in.(glb,usdz)&order=created_at.desc&limit=${Number(limit) || 200}`;
  if (mode === 'direct') {
    const supabase = await getDirectClient();
    const { data, error } = await supabase.from('product_assets')
      .select('id,kind,object_path,byte_size,mime_type,created_at,product:products(id,name,slug,status,store:stores(name,slug))')
      .in('kind', ['glb', 'usdz'])
      .order('created_at', { ascending: false })
      .limit(Number(limit) || 200);
    if (error) throw new Error(friendlyError(error));
    return data || [];
  }
  return (await restCall(query)) || [];
}

/**
 * Every model file with its lifecycle (0012), longest unused first. The
 * database works out last use, idle days and cleanup eligibility; the console
 * only displays them, so the 365-day rule lives in one place.
 */
/**
 * The store's own models and where each stands against the one-year rule
 * (0013): last use, whether the owners were emailed, the earliest day an
 * admin could delete it. Worked out by the database, shown as-is.
 */
export async function listStoreModelLifecycle(storeUuid) {
  return (await restCall('rpc/store_model_lifecycle', {
    method: 'POST', body: JSON.stringify({ p_store: storeUuid })
  })) || [];
}

/** "Keep 3D model": records a use of the store's own model, resetting its year. */
export async function keepModel(assetId) {
  return restCall('rpc/keep_model', { method: 'POST', body: JSON.stringify({ p_asset: assetId }) });
}

export async function listModelLifecycle() {
  return (await restCall('rpc/admin_model_lifecycle', { method: 'POST', body: '{}' })) || [];
}

/**
 * Delete a model unused for 365 days (never its product). Everything is
 * re-checked on the server; only the asset id goes from here.
 * Resolves to the server's answer, or throws an Error with `code`.
 */
export async function cleanupStaleModel(assetId) {
  const token = session?.access_token;
  const response = await fetch('/api/sb/models/admin-cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ assetId })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'We couldn’t delete this model. Nothing was removed.');
    error.code = body.code || null;
    throw error;
  }
  return body;
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

/* ------------------------------------------------ orders & billing (0009) --- */

/**
 * Is online payment switched on for this deployment? Answered by the server,
 * which alone knows whether PayPal and the payment recorder are configured.
 * An unconfigured or unreachable backend reads as "off", never as an error.
 */
export async function billingConfig() {
  try {
    const response = await fetch('/api/sb/orders/config', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) return { payments: false, email: false, feeRate: 0.1, currency: 'PHP', depositRate: 0.5 };
    return await response.json();
  } catch {
    return { payments: false, email: false, feeRate: 0.1, currency: 'PHP', depositRate: 0.5 };
  }
}

/**
 * One order action on the server (lib/orders.js). The body names things —
 * a product, a quantity, an order — never an amount; the server and the
 * database decide what is owed.
 */
export async function orderAction(action, payload = {}) {
  return serverAction('orders', action, payload);
}

/**
 * The payment methods a shop can be paid through right now ('paypal',
 * 'maya'), as the server decides: what the shop is set up for, intersected
 * with what this deployment has switched on. Empty on any failure.
 */
export async function storePaymentProviders(storeUuid) {
  try {
    const response = await fetch(`/api/sb/orders/providers?store=${encodeURIComponent(storeUuid)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body?.providers) ? body.providers : [];
  } catch {
    return [];
  }
}

/**
 * One call to this app's own server endpoints (/api/sb/<section>/<action>)
 * as the signed-in user: orders, account onboarding, the shop's PayPal
 * connection. POST with a body, or GET without one.
 */
async function serverAction(section, action, payload = null, retried = false) {
  const current = await getSession().catch(() => null);
  const headers = { Accept: 'application/json' };
  if (payload) headers['Content-Type'] = 'application/json';
  if (current?.access_token) headers.Authorization = `Bearer ${current.access_token}`;
  const response = await fetch(`/api/sb/${section}/${action}`, {
    method: payload ? 'POST' : 'GET', headers, body: payload ? JSON.stringify(payload) : undefined, cache: 'no-store'
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401 && !retried && session?.refresh_token) {
    const renewed = await refreshSession();
    if (renewed) return serverAction(section, action, payload, true);
  }
  if (!response.ok) {
    const error = new Error(body?.error || 'That could not be completed. Please try again.');
    error.status = response.status;
    error.code = body?.code || (response.status === 401 ? 'auth_required' : undefined);
    throw error;
  }
  return body;
}

/* ---------------------------------------------- Google sign-in (0011) --- */

/**
 * Where "Continue with Google" goes. A plain navigation to this app's own
 * server, which keeps the PKCE verifier in an httpOnly cookie and sends the
 * browser to Google. `next` is re-checked on the server.
 */
export function googleSignInUrl({ next, intent } = {}) {
  const query = new URLSearchParams();
  if (next) query.set('next', next);
  if (intent) query.set('intent', intent);
  const tail = query.toString();
  return `/api/sb/auth/google${tail ? `?${tail}` : ''}`;
}

/**
 * Finishes Google sign-in on /auth/callback: the server trades the one-time
 * code for a session (without Google's own tokens) and this tab keeps it
 * exactly like a password sign-in. Returns { next, intent } from the flow.
 */
export async function completeGoogleSignIn(code) {
  const response = await fetch('/api/sb/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code }),
    cache: 'no-store',
    credentials: 'same-origin'
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.session?.access_token) {
    const error = new Error('Google sign-in could not be completed.');
    error.code = body?.code || (response.status >= 500 ? 'provider_unavailable' : 'failed');
    error.status = response.status;
    throw error;
  }
  storeSession(body.session);
  return { next: body.next || null, intent: body.intent || null };
}

/** The signed-in account's role and what onboarding still needs. */
export function accountState() {
  return serverAction('account', 'state');
}

/** Onboarding: 'buyer' ({ municipality, fullName? }) or 'apply' ({ storeName, phone, message }). */
export function accountAction(action, payload) {
  return serverAction('account', action, payload || {});
}

/** The shop's PayPal seller connection: 'connect' | 'refresh'. */
export function paymentsAction(action, payload) {
  return serverAction('payments', action, payload || {});
}

/** The deployment's PayPal configuration and its problems — admins only. */
export function adminPaymentsConfig() {
  return serverAction('payments', 'admin');
}

const ORDER_FIELDS = 'id,reference,kind,status,store_id,product_id,product_name,quantity,unit_price,subtotal,'
  + 'fee_rate,platform_fee,total,deposit_amount,amount_paid,currency,request,quote_note,lead_time_days,'
  + 'decline_reason,hold_expires_at,created_at,updated_at,paid_at,buyer_name,buyer_email,'
  + 'fulfilment_method,delivery_address,delivery_municipality,delivery_phone,delivery_notes,'
  + 'estimated_arrival,delivery_status,delivered_at,fulfilled_at,stores(name,slug,address,contact_number)';

/** The signed-in buyer's own orders (RLS decides which rows exist). */
export async function listMyOrders() {
  if (!session) return [];
  return (await restCall(`orders?select=${ORDER_FIELDS}&order=created_at.desc&limit=50`)) || [];
}

/**
 * One order with its payments, for its receipt. RLS decides who may read it:
 * the buyer, the shop's members, or an admin. Anyone else gets nothing.
 */
export async function getOrderReceipt(orderId) {
  const rows = await restCall(
    `orders?id=eq.${encodeURIComponent(orderId)}&select=${ORDER_FIELDS},`
    + 'payments(stage,amount,capture_id,captured_at,applied,provider)&limit=1'
  );
  return (rows || [])[0] || null;
}

/** A store's incoming orders, for its owner. */
export async function listStoreOrders(storeUuid) {
  return (await restCall(
    `orders?select=${ORDER_FIELDS}&store_id=eq.${encodeURIComponent(storeUuid)}&order=created_at.desc&limit=100`
  )) || [];
}

const ACCOUNT_FIELDS = 'provider,environment,merchant_id,onboarding_status,payments_receivable,email_confirmed,'
  + 'partner_fee_granted,status_detail,connected_at,last_checked_at,updated_at';

/** How a store is paid, what kind it is, and what it owes FurnishAR. */
export async function storeBilling(storeUuid) {
  const id = encodeURIComponent(storeUuid);
  const [payout, store, fees, accounts, remittances] = await Promise.all([
    restCall(`store_payout?store_id=eq.${id}&select=paypal_email,notify_email,delivery_days,pickup_days`),
    restCall(`stores?id=eq.${id}&select=fulfilment`),
    restCall('rpc/store_fee_summary', { method: 'POST', body: JSON.stringify({ p_store: storeUuid }) }),
    // 0011. Read under RLS: this store's members and admins only.
    // 0015: one row per provider; PayPal's and Maya's are kept apart here.
    restCall(`store_payment_accounts?store_id=eq.${id}&select=${ACCOUNT_FIELDS},settlement_mode&order=updated_at.desc`)
      // settlement_mode arrives with 0015; before it, read the PayPal columns alone.
      .catch(() => restCall(`store_payment_accounts?store_id=eq.${id}&select=${ACCOUNT_FIELDS}&order=updated_at.desc`))
      .catch(() => []),
    restCall(`store_remittances?store_id=eq.${id}&select=amount,reference,created_at&order=created_at.desc&limit=20`)
      .catch(() => [])
  ]);
  const rows = accounts || [];
  return {
    paymentAccounts: rows.filter(a => (a.provider || 'paypal') === 'paypal'),
    mayaAccounts: rows.filter(a => a.provider === 'maya'),
    remittances: remittances || [],
    fulfilment: store?.[0]?.fulfilment || 'stocked',
    deliveryDays: payout?.[0]?.delivery_days ?? 3,
    pickupDays: payout?.[0]?.pickup_days ?? 1,
    paypalEmail: payout?.[0]?.paypal_email || '',
    notifyEmail: payout?.[0]?.notify_email || '',
    fees: fees || { accrued: 0, settled: 0, outstanding: 0 }
  };
}

/** Every store's fees — platform admin only (the function checks). */
export async function feeOverview() {
  return (await restCall('rpc/fee_overview', { method: 'POST', body: '{}' })) || [];
}

/** Admin: enable or disable Maya for a store (0015 checks is_platform_admin). */
export async function setMayaAccount({ storeUuid, environment, enabled, settlement, submerchant, city, postal }) {
  return restCall('rpc/admin_set_maya_account', {
    method: 'POST',
    body: JSON.stringify({
      p_store: storeUuid, p_env: environment, p_enabled: Boolean(enabled), p_settlement: settlement || null,
      p_submerchant: submerchant || null, p_city: city || null, p_postal: postal || null
    })
  });
}

/** Admin: a payout FurnishAR made to a store for Maya payments it collected. */
export async function recordStoreRemittance({ storeUuid, amount, reference, note }) {
  return restCall('rpc/record_store_remittance', {
    method: 'POST',
    body: JSON.stringify({ p_store: storeUuid, p_amount: Number(amount), p_reference: reference || null, p_note: note || null })
  });
}

export async function recordFeeSettlement({ storeUuid, amount, reference, note }) {
  return restCall('rpc/record_fee_settlement', {
    method: 'POST',
    body: JSON.stringify({ p_store: storeUuid, p_amount: Number(amount), p_reference: reference || null, p_note: note || null })
  });
}
