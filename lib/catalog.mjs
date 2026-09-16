/**
 * Catalogue reads, on the server.
 *
 * The Supabase integration was removed, so this is the bundled catalogue that
 * ships with the deployment: data/catalog.json, plus the pilot shops below.
 * There is no network call and nothing to misconfigure.
 *
 * The shape returned here is the one the whole app is written against
 * (`getCatalog`, `getProduct`, `getStores`), so restoring a database later
 * means reimplementing these three functions and nothing else.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();

/**
 * The catalogue committed to the repo.
 *
 * Its model paths are relative ("models/x.glb"), which resolved correctly when
 * the whole app was served from "/". Products have their own URLs now, so a
 * relative path would resolve against /furniture/ and 404. They are made
 * root-relative here rather than edited in the JSON.
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

/**
 * The pilot shops, without the demo credentials that sit beside them in
 * lib/handler.js. Nothing here is secret — it is the shop information printed
 * on a product page.
 *
 * The addresses are still placeholders; see docs/MAINTENANCE.md. They must be
 * replaced with the real ones before launch.
 */
const STORES = {
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

/** Every published product. */
export async function getCatalog() {
  return { products: await bundledCatalog(), source: 'bundled' };
}

/** Public shop details, keyed by slug. */
export async function getStores() {
  return STORES;
}

/** One product by slug, or by id for catalogues that predate slugs. */
export async function getProduct(idOrSlug) {
  const { products } = await getCatalog();
  return products.find(p => p.slug === idOrSlug || p.id === idOrSlug) || null;
}
