/**
 * Unit tests for the translation layer in public/supabase.js — the place where
 * a database row becomes the product shape the UI renders, and back again.
 * Wrong mapping here is invisible until AR silently mis-scales something, so
 * these run without any network or database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The module reads window.FURNISHAR_CONFIG at import time, exactly as a browser would.
globalThis.window = { FURNISHAR_CONFIG: { supabaseUrl: 'https://demo.supabase.co', supabaseAnonKey: 'anon-key' } };

const modulePromise = import(pathToFileURL(path.resolve(__dirname, '../public/supabase.js')).href);

const CATALOG_ROW = {
  id: '6f1c4e4e-0000-4000-8000-000000000001',
  slug: 'cane-back-armchair',
  name: 'Cane Back Armchair',
  store_id: '2b1c4e4e-0000-4000-8000-000000000002',
  store_slug: 'sc-variety',
  store_name: 'S&C Variety Store',
  category: 'Chair',
  style: 'Contemporary',
  color: 'Natural',
  price_php: '9850.00',
  stock: 5,
  width_cm: '70.0',
  height_cm: '88.0',
  depth_cm: '78.0',
  bounds_width_cm: '70.0',
  bounds_height_cm: '88.0',
  bounds_depth_cm: '78.0',
  preview_shape: 'chair',
  description: 'Woven cane back armchair.',
  ar_ready: true,
  featured: true,
  updated_at: '2026-09-15T00:00:00Z',
  model_glb_path: '2b1c4e4e-0000-4000-8000-000000000002/6f1c4e4e-0000-4000-8000-000000000001/model.glb',
  model_usdz_path: null
};

test('a catalog row becomes the product shape the UI renders', async () => {
  const { toProduct } = await modulePromise;
  const product = toProduct(CATALOG_ROW);

  assert.equal(product.name, 'Cane Back Armchair');
  assert.equal(product.storeId, 'sc-variety', 'storeId is the slug the filters use');
  assert.equal(product.store, 'S&C Variety Store');
  // Postgres numerics arrive as strings; the UI does arithmetic on them.
  assert.strictEqual(product.price, 9850);
  assert.strictEqual(product.dimensions.width, 70);
  assert.strictEqual(product.dimensions.height, 88);
  assert.strictEqual(product.dimensions.depth, 78);
  assert.strictEqual(product.modelBounds.height, 88);
  assert.equal(typeof product.price, 'number');
  assert.equal(product.model, 'chair');
  assert.equal(product.arReady, true);
});

test('an uploaded model resolves to a public storage URL', async () => {
  const { toProduct, modelUrl } = await modulePromise;
  const product = toProduct(CATALOG_ROW);
  assert.equal(
    product.modelGlb,
    'https://demo.supabase.co/storage/v1/object/public/furniture-models/2b1c4e4e-0000-4000-8000-000000000002/6f1c4e4e-0000-4000-8000-000000000001/model.glb'
  );
  assert.equal(product.modelUsdz, undefined, 'a missing USDZ stays undefined, not a broken URL');
  assert.equal(modelUrl(null), undefined);
});

test('a product maps back to a row the schema accepts', async () => {
  const { toRow } = await modulePromise;
  const row = toRow({
    name: 'Oak Stool',
    category: 'Chair',
    style: 'Modern',
    color: 'Oak',
    price: 1500,
    stock: 4,
    dimensions: { width: 35, height: 45, depth: 35 },
    modelBounds: { width: 35, height: 45, depth: 35 },
    model: 'chair',
    description: 'A stool.'
  }, 'store-uuid');

  assert.equal(row.store_id, 'store-uuid');
  assert.equal(row.slug, 'oak-stool', 'a slug is derived when none is given');
  assert.equal(row.price_php, 1500);
  assert.equal(row.width_cm, 35);
  assert.equal(row.preview_shape, 'chair');
  assert.equal(row.status, 'published');
  assert.equal(row.featured, false);
});

test('bounds are left null when the owner did not set them', async () => {
  const { toRow } = await modulePromise;
  const row = toRow({
    name: 'Plain Shelf', category: 'Storage', style: 'Modern', color: 'Natural',
    price: 100, stock: 1, dimensions: { width: 10, height: 10, depth: 10 }, model: 'shelf'
  }, 'store-uuid');
  assert.equal(row.bounds_width_cm, null, 'null lets the view fall back to the real dimensions');
});

test('slugs are safe for the (store_id, slug) unique key', async () => {
  const { slugify } = await modulePromise;
  assert.equal(slugify('  Harvest Dining Table  '), 'harvest-dining-table');
  assert.equal(slugify('S&C — Vanity / Sink #2'), 's-c-vanity-sink-2');
  assert.match(slugify('!!!'), /^item-\d+$/, 'an unusable name still yields a slug');
  assert.ok(slugify('x'.repeat(200)).length <= 60);
});

test('database errors are rewritten into something an owner can act on', async () => {
  const { friendlyError } = await modulePromise;
  assert.match(friendlyError({ message: 'new row violates row-level security policy for table "products"' }),
    /belongs to another store/);
  assert.match(friendlyError({ message: 'Freemium plan limited to 8 products. Upgrade to premium to list more.' }),
    /Freemium plan limited to 8 products/);
  assert.match(friendlyError({ message: 'Featured placement is a premium plan feature.' }), /premium plan/);
  assert.match(friendlyError({ message: 'Invalid login credentials' }), /do not match an account/);
  assert.match(friendlyError({ message: 'User already registered' }), /Sign in instead/);
  assert.match(friendlyError({ message: 'Email not confirmed' }), /Confirm your email/);
  // Anything unrecognised is passed through rather than swallowed.
  assert.equal(friendlyError({ message: 'connection terminated' }), 'connection terminated');
});
