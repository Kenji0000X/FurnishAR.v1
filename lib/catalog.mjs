/**
 * Catalogue reads, on the server.
 *
 * A server component can talk to Supabase directly with the server-only
 * credentials — there is no reason to make it call our own /api/sb route and
 * pay an HTTP round trip to reach code in the same process. The browser still
 * goes through /api/sb; this is the short path for rendering.
 *
 * If Supabase is not configured (or is unreachable), this falls back to the
 * bundled data/catalog.json so the site still renders a shop rather than an
 * empty page. That was true of the vanilla build and stays true here.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import env from './env.js';

const { loadSupabaseEnv } = env;

const ROOT = process.cwd();

/**
 * How a page refers to a model — a reference, not a file.
 *
 * This used to return the model's PUBLIC storage URL whenever the project URL
 * was known, which put a working download link for every shop's 3D file into
 * the HTML of the catalogue and every product page, signed in or not. It now
 * always returns an address on our own origin that answers only to a signed-in
 * caller the storage policy allows (see grantModelAccess in
 * lib/supabase-proxy.js and 0007). The browser trades it for a five-minute
 * signed URL at the moment it actually needs the file.
 *
 * Must stay in step with modelUrl() in public/supabase.js —
 * tests/supabase-mapping.test.js asserts both.
 */
export function modelUrl(objectPath) {
  if (!objectPath) return undefined;
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
    // Where the file lives, as opposed to the URL it is served from. The
    // thumbnail check compares against this: serving URLs change (they did,
    // when models stopped being public), the stored file does not.
    modelSource: row.model_glb_path || null,
    modelUsdz: modelUrl(row.model_usdz_path),
    modelBounds: {
      width: Number(row.bounds_width_cm),
      height: Number(row.bounds_height_cm),
      depth: Number(row.bounds_depth_cm)
    },
    description: row.description || '',
    // NOT row.ar_ready.
    //
    // That column is a boolean a store row can set without uploading
    // anything, and the bundled catalogue had it true on two products with no
    // model at all — so the grid showed an AR badge, the detail page offered
    // "Place in your room", and the planner then had nothing to place. A
    // product is AR-ready when it has a model. There is no second way to say
    // so, and no way to claim it.
    arReady: Boolean(row.model_glb_path),
    featured: row.featured,
    updatedAt: row.updated_at
  };
}

/**
 * Thumbnails, rendered from each product's own model by
 * scripts/render-thumbnails.mjs.
 *
 * Read once per process. A product with no entry has no thumbnail, and the
 * card shows its empty state rather than borrowing a picture from somewhere.
 */
let thumbnailCache = null;
async function thumbnails() {
  if (thumbnailCache) return thumbnailCache;
  try {
    const file = path.join(ROOT, 'data', 'thumbnails.json');
    thumbnailCache = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // No manifest yet is a perfectly ordinary state — nobody has run the
    // renderer. Every product then reports "no preview", which is true.
    thumbnailCache = {};
  }
  return thumbnailCache;
}

/**
 * Attaches each product's own thumbnail, and nothing else's.
 *
 * Keyed by product id, so there is no path by which one product can end up
 * displaying another's render.
 */
async function withThumbnails(products) {
  const manifest = await thumbnails();
  return products.map(product => {
    const entry = manifest[product.id] || manifest[product.slug];
    // A thumbnail is only usable if it was rendered from the model this
    // product still points at. If the shop replaced the .glb and nobody
    // re-rendered, the old picture is of the old furniture — so it is
    // withheld rather than shown as if current.
    // Compared on the stored file, not the serving URL: the demo model moved
    // from /models/x.glb to /api/demo-model/x.glb without changing, and
    // comparing URLs withheld its picture while its 3D badge stayed.
    const source = product.modelSource || product.modelGlb;
    const stale = entry && source && !source.endsWith(entry.source);
    return { ...product, thumbnail: entry && !stale ? entry.file : null };
  });
}

/**
 * The catalogue committed to the repo — the offline and unconfigured answer.
 *
 * Its model paths are relative ("models/x.glb"), which resolved correctly when
 * the whole app was served from "/". Products have their own URLs now, so a
 * relative path would resolve against /furniture/ and 404. They are made
 * root-relative here rather than edited in the JSON, so the file stays valid
 * for the vanilla build while both exist.
 */
async function bundledCatalog() {
  const file = path.join(ROOT, 'data', 'catalog.json');
  const products = JSON.parse(await readFile(file, 'utf8'));
  const rooted = value =>
    value && !/^(https?:|\/)/.test(value) ? `/${value.replace(/^\.?\//, '')}` : value;
  /* The demo model is no longer a static file (it used to be /models/x.glb in
     /public, a download for anyone). catalog.json keeps its logical
     "models/x.glb" path — the thumbnail renderer reads that from disk — and
     the page gets the route that serves it only in database-less demo mode. */
  const demoModel = value => {
    const match = /^\.?\/?models\/([\w-]+\.glb)$/.exec(value || '');
    return match ? `/api/demo-model/${match[1]}` : rooted(value);
  };
  return products.map(product => ({
    ...product,
    modelSource: product.modelGlb || null,
    modelGlb: demoModel(product.modelGlb),
    modelUsdz: rooted(product.modelUsdz),
    // Same rule as the Supabase path: derived from the asset, never read from
    // the file. data/catalog.json ships `"arReady": true` on two products
    // that have no modelGlb at all.
    arReady: Boolean(product.modelGlb)
  }));
}

async function fetchFromSupabase() {
  const { supabaseUrl, supabaseAnonKey } = loadSupabaseEnv();
  if (!supabaseUrl || !supabaseAnonKey) return null;

  const query = 'catalog?select=*&order=featured.desc,name.asc';
  const response = await fetch(`${supabaseUrl}/rest/v1/${query}`, {
    headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
    // Shops publish through the portal, so a shopper should not wait on a
    // cache to expire to see new stock, but every visitor in the same minute
    // can share one query.
    next: { revalidate: 60, tags: ['catalog'] }
  });
  if (!response.ok) throw new Error(`Supabase returned ${response.status} for the catalogue`);
  return (await response.json()).map(toProduct);
}

/**
 * Every published product of every active store.
 *
 * Never throws: a shop with a broken backend should still show its committed
 * catalogue rather than an error page.
 */
export async function getCatalog() {
  try {
    const live = await fetchFromSupabase();
    if (live && live.length) {
      return { products: await withThumbnails(live), source: 'supabase' };
    }
    if (live) {
      return { products: await withThumbnails(await bundledCatalog()), source: 'bundled-empty' };
    }
  } catch (error) {
    console.warn('[catalog] falling back to the bundled catalogue:', error.message);
  }
  return { products: await withThumbnails(await bundledCatalog()), source: 'bundled' };
}

/**
 * The pilot shops, without the demo credentials that sit beside them in
 * lib/handler.js. Nothing here is secret — it is the shop information printed
 * on a product page.
 *
 * The addresses are still placeholders; see docs/MAINTENANCE.md. They must be
 * replaced with the real ones before launch.
 */
const DEMO_STORES = {
  'sc-variety': {
    name: 'S&C Variety Store',
    address: '123 Main Street, Mamburao, Occidental Mindoro (PLACEHOLDER - UPDATE BEFORE LAUNCH)',
    contactNumber: '+63 (0)43-288-1234',
    hours: 'Mon-Sun: 8:00 AM - 6:00 PM'
  },
  tiampion: {
    name: 'Tiampion Buildings',
    address: '456 Commerce Avenue, Mamburao, Occidental Mindoro (PLACEHOLDER - UPDATE BEFORE LAUNCH)',
    contactNumber: '+63 (0)43-288-5678',
    hours: 'Mon-Sat: 9:00 AM - 5:00 PM'
  },
  sanros: {
    name: 'Sanros General Merchandise',
    address: '789 Market Place, Mamburao, Occidental Mindoro (PLACEHOLDER - UPDATE BEFORE LAUNCH)',
    contactNumber: '+63 (0)43-288-9999',
    hours: 'Mon-Sun: 7:00 AM - 8:00 PM'
  }
};

/** Public shop details, keyed by slug. Supabase when configured, else the pilot three. */
export async function getStores() {
  const { supabaseUrl, supabaseAnonKey } = loadSupabaseEnv();
  if (supabaseUrl && supabaseAnonKey) {
    try {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/stores?select=slug,name,address,contact_number,hours&is_active=eq.true`,
        {
          headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
          next: { revalidate: 300, tags: ['stores'] }
        }
      );
      if (response.ok) {
        const rows = await response.json();
        if (rows.length) {
          return Object.fromEntries(
            rows.map(row => [
              row.slug,
              {
                name: row.name,
                address: row.address,
                contactNumber: row.contact_number,
                hours: row.hours
              }
            ])
          );
        }
      }
    } catch (error) {
      console.warn('[stores] falling back to the bundled shop list:', error.message);
    }
  }
  return DEMO_STORES;
}

/** One product by slug, or by id for catalogues that predate slugs. */
export async function getProduct(idOrSlug) {
  const { products } = await getCatalog();
  return products.find(p => p.slug === idOrSlug || p.id === idOrSlug) || null;
}
