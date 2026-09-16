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

const { loadSupabaseEnv, publicBundleCredentials } = env;

const MODEL_BUCKET = 'furniture-models';
const ROOT = process.cwd();

/**
 * Where the browser should fetch a model from.
 *
 * In proxy mode the project URL is deliberately not published to the page, so
 * models are addressed through our own origin. This must stay in step with
 * modelUrl() in public/supabase.js — tests/catalog.test.js asserts that.
 */
export function modelUrl(objectPath) {
  if (!objectPath) return undefined;
  const { supabaseUrl } = publicBundleCredentials();
  if (supabaseUrl) return `${supabaseUrl}/storage/v1/object/public/${MODEL_BUCKET}/${objectPath}`;
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
  return products.map(product => ({
    ...product,
    modelGlb: rooted(product.modelGlb),
    modelUsdz: rooted(product.modelUsdz)
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
    if (live && live.length) return { products: live, source: 'supabase' };
    if (live) return { products: await bundledCatalog(), source: 'bundled-empty' };
  } catch (error) {
    console.warn('[catalog] falling back to the bundled catalogue:', error.message);
  }
  return { products: await bundledCatalog(), source: 'bundled' };
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
