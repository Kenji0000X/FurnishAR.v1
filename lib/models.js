/**
 * 3D model housekeeping.                                    DFD: P4, P5, P9
 *
 *   POST /api/sb/models/poster       a store links the catalogue poster it just
 *                                    uploaded, and its previous poster file is
 *                                    removed
 *   POST /api/sb/models/revalidate   a store's catalogue changed (product
 *                                    saved, model uploaded, product deleted):
 *                                    refresh the cached catalogue now instead
 *                                    of in up to 60 seconds
 *   POST /api/sb/models/admin-cleanup  a platform admin deletes a 3D model
 *                                    that has gone unused for 365 days
 *
 * Every call runs AS THE SIGNED-IN USER (publishable key + their own token).
 * The database and Storage policies decide (0012); nothing here holds the
 * secret key or could override a refusal. `revalidate: true` in a result asks
 * the route handler to refresh the catalogue cache — kept out of this module
 * so it runs outside Next.js too (tests).
 */
const { serverCredentials, callSupabase } = require('./supabase-proxy.js');
const { isPlatformAdmin } = require('./auth.js');
const orders = require('./orders.js');

const { fail } = orders;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* <store>/<product>/poster-<16 hex of the image's SHA-256>.webp — the name is
   the content, so a poster URL never changes meaning and caches for a year. */
const POSTER_PATH = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/poster-[0-9a-f]{16}\.(webp|jpg|png)$/i;
const POSTER_BUCKET = 'product-posters';
const MODEL_BUCKET = 'furniture-models';

/** A PostgREST call as the user. Keeps the database's hint (e.g. not_eligible). */
async function asUser(ctx, path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ctx.key, Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const response = await callSupabase(`${ctx.url}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const error = new Error(typeof parsed?.message === 'string' ? parsed.message : `HTTP ${response.status}`);
    error.status = response.status;
    error.hint = parsed?.hint || null;
    error.dbCode = parsed?.code || null;
    throw error;
  }
  return parsed;
}

/**
 * Storage's own delete, as the user: the bucket's policies decide what goes.
 * Returns the names actually deleted — an object the policy refuses, or that
 * is already gone, is simply not in the list. That is what makes a retry
 * after an interruption harmless.
 */
async function deleteObjects(ctx, bucket, names) {
  const response = await callSupabase(`${ctx.url}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: { apikey: ctx.key, Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: names })
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error = new Error(`Storage refused the delete (${response.status}).`);
    error.status = 502;
    throw error;
  }
  return (Array.isArray(body) ? body : []).map(object => object.name);
}

async function roleOf(ctx) {
  try {
    return await asUser(ctx, 'rpc/my_role', { method: 'POST', body: {} });
  } catch {
    return 'guest';
  }
}

const ACTIONS = {
  /**
   * Link an uploaded poster to its product, then remove the one it replaced.
   * The row write is the store's own (RLS: members only, store_id set by a
   * trigger), so a path in someone else's folder is refused by the database.
   */
  async poster(ctx, body) {
    const objectPath = String(body.objectPath || '');
    const match = POSTER_PATH.exec(objectPath);
    if (!match) throw fail(400, 'Unknown preview image.');
    const [, storeId, productId] = match;
    const byteSize = Number(body.byteSize);
    const mime = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' }[match[3].toLowerCase()];

    const before = await asUser(ctx,
      `product_assets?select=object_path&product_id=eq.${productId}&kind=eq.poster`);
    await asUser(ctx, 'product_assets?on_conflict=product_id,kind', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        product_id: productId, store_id: storeId, kind: 'poster', bucket: POSTER_BUCKET,
        object_path: objectPath, byte_size: Number.isFinite(byteSize) && byteSize > 0 ? byteSize : null,
        mime_type: mime
      }
    }).catch(error => {
      throw fail(error.status === 401 || error.status === 403 || error.dbCode === '42501' ? 403 : 400,
        'The preview could not be linked to this product.');
    });

    const previous = (before || []).map(row => row.object_path).filter(path => path && path !== objectPath);
    if (previous.length) {
      // Best effort: the new poster is already live. A leftover file costs a
      // few kilobytes, not a wrong picture.
      await deleteObjects(ctx, POSTER_BUCKET, previous).catch(() => {});
    }
    return { objectPath, revalidate: true };
  },

  /** Only people who can change the catalogue may ask for it to be refreshed. */
  async revalidate(ctx) {
    const role = await roleOf(ctx);
    if (role !== 'owner' && role !== 'admin') throw fail(403, 'Only a store or an administrator can refresh the catalogue.');
    return { revalidate: true };
  },

  /**
   * Delete a model that has gone unused for 365 days. Never the product.
   *
   *   1. The admin is re-checked here, and again by every database call.
   *   2. The model is re-read from the database — the browser's "eligible"
   *      is never taken on trust; nothing but an asset id is read from it.
   *   3. Storage deletes the files as the admin. Its policy re-checks
   *      eligibility at that moment, so a model opened since the page loaded
   *      is left alone.
   *   4. admin_delete_stale_model() removes the rows and writes the audit,
   *      refusing if the file is somehow still there.
   *
   * A retry after any failure resumes where it stopped.
   */
  async 'admin-cleanup'(ctx, body) {
    const assetId = String(body.assetId || '');
    if (!UUID.test(assetId)) throw fail(400, 'Unknown model.');
    if (!await isPlatformAdmin({ url: ctx.url, key: ctx.key, token: ctx.token, call: callSupabase })) {
      throw fail(403, 'This is limited to platform administrators.');
    }

    const rows = await asUser(ctx, 'rpc/admin_model_lifecycle', { method: 'POST', body: { p_asset: assetId } });
    const model = Array.isArray(rows) ? rows[0] : null;
    if (!model) return { status: 'gone', revalidate: true };
    if (!model.eligible) {
      throw fail(409, 'This model was used recently and is no longer eligible for cleanup.', 'not_eligible');
    }

    await deleteObjects(ctx, MODEL_BUCKET, [model.object_path]);
    if (model.poster_path) await deleteObjects(ctx, POSTER_BUCKET, [model.poster_path]);

    let result;
    try {
      result = await asUser(ctx, 'rpc/admin_delete_stale_model', { method: 'POST', body: { p_asset: assetId } });
    } catch (error) {
      if (error.hint === 'not_eligible') {
        throw fail(409, 'This model was used recently and is no longer eligible for cleanup.', 'not_eligible');
      }
      if (error.hint === 'storage_pending') {
        // Storage kept the file: its policy found the model no longer
        // eligible, or the delete failed. Either way nothing was removed.
        throw fail(409, 'We couldn’t delete this model. Nothing was removed.', 'storage_pending');
      }
      if (error.dbCode === '42501') throw fail(403, 'This is limited to platform administrators.');
      throw fail(502, 'The model file was removed, but its record could not be cleared yet. Try again to finish.', 'partial');
    }
    return { ...result, revalidate: true };
  }
};

async function handleModels(req, action, body) {
  if (req.method !== 'POST' || !Object.hasOwn(ACTIONS, action)) {
    return { status: 404, body: { error: 'Unknown endpoint.' } };
  }
  const auth = await orders.authenticate(req);
  if (auth.error) return auth.error;
  try {
    return { status: 200, body: await ACTIONS[action](auth.ctx, body || {}) };
  } catch (error) {
    if (error.upstream) throw error;
    return { status: error.status || 500, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
  }
}

module.exports = { handleModels, ACTIONS, POSTER_PATH, POSTER_BUCKET, MODEL_BUCKET };
