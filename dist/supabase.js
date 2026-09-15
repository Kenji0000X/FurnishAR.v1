/**
 * Supabase backend for FurnishAR.
 *
 * Loaded only when public/config.js supplies a project URL and anon key. The
 * anon key is meant to be public — every table is protected by row level
 * security, so the key alone grants nothing beyond what a shopper may see.
 * The service role key must never appear in this file or any other file that
 * reaches a browser.
 *
 * Everything here speaks the app's own product shape, so client.js does not
 * care which backend is answering.
 */

const CONFIG = (typeof window !== 'undefined' && window.FURNISHAR_CONFIG) || {};
const MODEL_BUCKET = 'furniture-models';
const MAX_MODEL_BYTES = 50 * 1024 * 1024; // matches the bucket's file_size_limit

let client = null;
let loading = null;

export function isConfigured() {
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
}

async function getClient() {
  if (client) return client;
  if (!isConfigured()) throw new Error('Supabase is not configured for this deployment.');
  loading ||= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const { createClient } = await loading;
  client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return client;
}

/**
 * Forces the client library to load so a CDN or network failure is discovered
 * at start-up, while there is still time to fall back to the bundled
 * catalogue, rather than halfway through a query.
 */
export async function prepare() {
  await getClient();
  return true;
}

/** Public URL for an uploaded model. The bucket is public, so no signing. */
export function modelUrl(objectPath) {
  if (!objectPath) return undefined;
  return `${CONFIG.supabaseUrl}/storage/v1/object/public/${MODEL_BUCKET}/${objectPath}`;
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
  const supabase = await getClient();
  const { data, error } = await supabase
    .from('catalog')
    .select('*')
    .order('featured', { ascending: false })
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data.map(toProduct);
}

export async function listStores() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from('stores')
    .select('id, slug, name, address, contact_number, hours, plan')
    .eq('status', 'active');
  if (error) throw new Error(error.message);
  return data.map(store => ({
    id: store.slug,
    uuid: store.id,
    name: store.name,
    address: store.address,
    contactNumber: store.contact_number,
    hours: store.hours,
    plan: store.plan
  }));
}

/** Everything the signed-in owner can edit, drafts included. */
export async function listOwnProducts(storeUuid) {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from('products')
    .select('*, product_assets(kind, object_path)')
    .eq('store_id', storeUuid)
    .neq('status', 'archived')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data.map(row => toProduct({
    ...row,
    store_slug: row.store_slug,
    model_glb_path: row.product_assets?.find(a => a.kind === 'glb')?.object_path,
    model_usdz_path: row.product_assets?.find(a => a.kind === 'usdz')?.object_path
  }));
}

export async function saveProduct(product, storeUuid) {
  const supabase = await getClient();
  const row = toRow(product, storeUuid);
  const query = product.id
    ? supabase.from('products').update(row).eq('id', product.id).select().single()
    : supabase.from('products').insert(row).select().single();
  const { data, error } = await query;
  if (error) throw new Error(friendlyError(error));
  return data;
}

export async function deleteProduct(id) {
  const supabase = await getClient();
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw new Error(friendlyError(error));
}

/**
 * Uploads a .glb/.usdz for a product. The path is always
 * <store_id>/<product_id>/<file>, which is exactly what the storage policy and
 * the product_assets check constraint require, so a file can never land in
 * another shop's folder.
 */
export async function uploadModel(file, { storeUuid, productId, kind = 'glb' }) {
  if (!file) throw new Error('Choose a file first.');
  if (file.size > MAX_MODEL_BYTES) {
    throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 50 MB.`);
  }
  const extension = kind === 'glb' ? 'glb' : kind === 'usdz' ? 'usdz' : 'png';
  const mime = kind === 'glb' ? 'model/gltf-binary' : kind === 'usdz' ? 'model/vnd.usdz+zip' : file.type;
  const objectPath = `${storeUuid}/${productId}/model.${extension}`;

  const supabase = await getClient();
  const { error: uploadError } = await supabase.storage
    .from(MODEL_BUCKET)
    .upload(objectPath, file, { contentType: mime, upsert: true, cacheControl: '3600' });
  if (uploadError) throw new Error(friendlyError(uploadError));

  // store_id is set by a trigger from the product, so it cannot be spoofed here.
  const { error } = await supabase.from('product_assets').upsert({
    product_id: productId,
    store_id: storeUuid,
    kind,
    bucket: MODEL_BUCKET,
    object_path: objectPath,
    byte_size: file.size,
    mime_type: mime
  }, { onConflict: 'product_id,kind' });
  if (error) throw new Error(friendlyError(error));
  return { objectPath, url: modelUrl(objectPath) };
}

/* ----------------------------------------------------------------- auth --- */

export async function signUp({ email, password, storeName, phone, message }) {
  const supabase = await getClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { store_name: storeName, contact_phone: phone } }
  });
  if (error) throw new Error(friendlyError(error));

  // The account exists but owns nothing yet. The application is what an admin
  // reviews before linking it to a store.
  const { error: applicationError } = await supabase.from('store_applications').insert({
    store_name: storeName,
    contact_email: email,
    contact_phone: phone || null,
    message: message || null
  });
  if (applicationError && !/duplicate key/i.test(applicationError.message)) {
    throw new Error(friendlyError(applicationError));
  }
  return {
    user: data.user,
    needsEmailConfirmation: Boolean(data.user && !data.session)
  };
}

export async function signIn({ email, password }) {
  const supabase = await getClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendlyError(error));
  return data;
}

export async function signOut() {
  const supabase = await getClient();
  await supabase.auth.signOut();
}

export async function getSession() {
  const supabase = await getClient();
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

/** The store this signed-in user may act for, or null while unapproved. */
export async function getMembership() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from('store_members')
    .select('role, stores(id, slug, name, plan)')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(friendlyError(error));
  if (!data) return null;
  return {
    role: data.role,
    storeUuid: data.stores.id,
    storeId: data.stores.slug,
    store: data.stores.name,
    plan: data.stores.plan
  };
}

export async function onAuthChange(handler) {
  const supabase = await getClient();
  supabase.auth.onAuthStateChange((event, session) => handler(event, session));
}

/* ------------------------------------------------------------- realtime --- */

/**
 * Live catalogue. Any insert, update or delete a shop makes is pushed to every
 * open browser, so a shopper's list stays current without a refresh.
 * Requires Realtime to be enabled for public.products in the dashboard.
 */
export async function subscribeToCatalog(handler) {
  const supabase = await getClient();
  const channel = supabase
    .channel('catalog-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, handler)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'product_assets' }, handler)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/* ---------------------------------------------------------------- errors --- */

/** Turns Postgres and GoTrue errors into something a shop owner can act on. */
export function friendlyError(error) {
  const message = error?.message || String(error);
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
