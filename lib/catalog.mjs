/**
 * Catalogue reads, on the server.
 *
 * A server component can talk to Supabase directly with the server-only
 * credentials — there is no reason to make it call our own /api/sb route and
 * pay an HTTP round trip to reach code in the same process. The browser still
 * goes through /api/sb; this is the short path for rendering.
 *
 * WHERE THE PRODUCTS COME FROM
 *   Supabase configured, query succeeds     → exactly what it returned, even
 *                                             when that is nothing. An empty
 *                                             database is an empty catalogue,
 *                                             never a cue to show demo pieces.
 *   Supabase configured, query fails        → no products, source
 *                                             'unavailable', and the page says
 *                                             the catalogue could not be
 *                                             loaded rather than that it is
 *                                             empty.
 *   No Supabase at all (local development)  → data/catalog.json, the demo
 *                                             backend's own store (lib/
 *                                             handler.js), which starts empty
 *                                             and holds whatever a developer
 *                                             adds through the portal.
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

/**
 * The public address of a catalogue poster (0012), or null.
 *
 * Posters live in the PUBLIC product-posters bucket: a small WebP rendered
 * from this product's own model when the shop uploaded it. Their names carry
 * a hash of their contents, so the same URL is always the same picture and
 * can be cached for a year. Models are never addressed this way — they stay
 * behind /api/sb/model (modelUrl above).
 *
 * Must stay in step with posterUrl() in public/supabase.js.
 */
export function posterUrl(posterPath, supabaseUrl) {
  if (!posterPath || !supabaseUrl) return null;
  return `${String(supabaseUrl).replace(/\/$/, '')}/storage/v1/object/public/product-posters/${posterPath}`;
}

/** A row of public.catalog in the shape the rest of the app already uses. */
export function toProduct(row, supabaseUrl) {
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
    // The card's picture: this product's own poster, or nothing. A poster
    // without a model (one left behind) is not shown — the picture would
    // promise a 3D piece that is no longer there.
    thumbnail: row.model_glb_path ? posterUrl(row.poster_path, supabaseUrl) : null,
    // 0014: when the model was uploaded, so a card can tell a poster still
    // being made (minutes) from one that will never come (app/model-state.js).
    modelUploadedAt: row.model_glb_path ? row.model_uploaded_at || null : null,
    featured: row.featured,
    updatedAt: row.updated_at
  };
}

/**
 * Local development without a database: the demo backend's own file
 * (lib/handler.js reads and writes it). It ships empty — FurnishAR has no demo
 * furniture — and a model reference in it is only a path a developer typed.
 *
 * FURNISHAR_FIXTURE_CATALOG points the pages at a test fixture instead
 * (tests/fixtures/catalog.json), so the layout checks have cards to measure.
 * It is read only here, only when no database is configured — which a real
 * deployment always has — so it can never put fixture furniture in front of a
 * shopper.
 */
async function localCatalog() {
  try {
    const fixtures = path.join(ROOT, 'tests', 'fixtures') + path.sep;
    const fixture = process.env.FURNISHAR_FIXTURE_CATALOG
      ? path.resolve(ROOT, process.env.FURNISHAR_FIXTURE_CATALOG) : null;
    const file = fixture && fixture.startsWith(fixtures) ? fixture : path.join(ROOT, 'data', 'catalog.json');
    const products = JSON.parse(await readFile(file, 'utf8'));
    const rooted = value =>
      value && !/^(https?:|\/)/.test(value) ? `/${value.replace(/^\.?\//, '')}` : value;
    return products.map(product => ({
      ...product,
      modelSource: product.modelGlb || null,
      modelGlb: rooted(product.modelGlb),
      modelUsdz: rooted(product.modelUsdz),
      // Only the test fixture may carry a picture (a file in public/), so the
      // layout checks have real cards to measure. The demo backend's own file
      // has no posters: its pieces are not shown as real cards.
      thumbnail: fixture && fixture.startsWith(fixtures) && product.modelGlb ? product.thumbnail || null : null,
      // Derived from the asset, never read from the file.
      arReady: Boolean(product.modelGlb)
    }));
  } catch {
    return [];
  }
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
  return (await response.json()).map(row => toProduct(row, supabaseUrl));
}

/**
 * Every published product of every active store.
 *
 * Never throws. `source` says which of the three cases above this was, so a
 * page can tell "nothing is listed yet" from "the catalogue could not be
 * reached" — two different sentences for a shopper.
 */
export async function getCatalog() {
  let live;
  try {
    live = await fetchFromSupabase();
  } catch (error) {
    console.warn('[catalog] the catalogue could not be loaded:', error.message);
    return { products: [], source: 'unavailable' };
  }
  if (live) return { products: live, source: 'supabase' };
  return { products: await localCatalog(), source: 'local' };
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

/**
 * Public shop details, keyed by slug.
 *
 * Same three cases as the catalogue: a configured database answers for
 * itself (no active stores means none), a failure means none are shown, and
 * only a deployment with no database at all uses the pilot three above.
 *
 * This used to filter on `is_active=eq.true`, a column stores has never had
 * (it is `status`, 0001). PostgREST answered 400 every time and every page
 * silently fell back to the placeholder addresses above.
 */
export async function getStores() {
  const { supabaseUrl, supabaseAnonKey } = loadSupabaseEnv();
  if (!supabaseUrl || !supabaseAnonKey) return DEMO_STORES;
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/stores?select=slug,name,address,contact_number,hours&status=eq.active`,
      {
        headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
        next: { revalidate: 300, tags: ['stores'] }
      }
    );
    if (!response.ok) throw new Error(`Supabase returned ${response.status} for the stores`);
    const rows = await response.json();
    return Object.fromEntries(rows.map(row => [
      row.slug,
      { name: row.name, address: row.address, contactNumber: row.contact_number, hours: row.hours }
    ]));
  } catch (error) {
    console.warn('[stores] the store list could not be loaded:', error.message);
    return {};
  }
}

/** One product by slug, or by id for catalogues that predate slugs. */
export async function getProduct(idOrSlug) {
  const { products } = await getCatalog();
  return products.find(p => p.slug === idOrSlug || p.id === idOrSlug) || null;
}
