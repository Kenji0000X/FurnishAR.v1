/**
 * Where the catalogue comes from — and the bug this replaced: a database that
 * answered with NO products used to be "filled in" with the bundled demo
 * furniture, so a new deployment showed a Cane Back Armchair nobody sold.
 *
 *   configured, answers []        → [], source 'supabase'
 *   configured, answers products  → exactly those
 *   configured, fails             → [], source 'unavailable' (never demo data)
 *   not configured                → data/catalog.json, which ships empty
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const saved = {};
let answer = () => new Response('[]', { status: 200 });
let requested = [];

before(() => {
  for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    saved[name] = process.env[name];
  }
  process.env.SUPABASE_URL = 'https://demo.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_testkey000000';
  saved.fetch = globalThis.fetch;
  globalThis.fetch = async url => { requested.push(String(url)); return answer(String(url)); };
});

after(() => {
  globalThis.fetch = saved.fetch;
  for (const [name, value] of Object.entries(saved)) {
    if (name === 'fetch') continue;
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const { getCatalog, getStores, toProduct, posterUrl } = await import('../lib/catalog.mjs');

const ROW = {
  id: 'p1', slug: 'real-bench', name: 'Real Bench', store_id: 's1', store_slug: 'shop', store_name: 'Shop',
  category: 'Bench', price_php: '1200.00', stock: 2, width_cm: '120', height_cm: '45', depth_cm: '40',
  model_glb_path: 's1/p1/model.glb', poster_path: 's1/p1/poster-0123456789abcdef.webp'
};

test('an empty database is an empty catalogue — the demo armchair never comes back', async () => {
  answer = () => new Response('[]', { status: 200 });
  const { products, source } = await getCatalog();
  assert.deepEqual(products, []);
  assert.equal(source, 'supabase');
  assert.ok(!JSON.stringify(products).includes('Cane Back'));
});

test('live products come back exactly as the database has them', async () => {
  answer = () => new Response(JSON.stringify([ROW]), { status: 200 });
  const { products, source } = await getCatalog();
  assert.equal(source, 'supabase');
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Real Bench');
});

test('a database that fails is reported as unavailable, not filled with demo furniture', async () => {
  answer = () => new Response('{"message":"boom"}', { status: 500 });
  const failed = await getCatalog();
  assert.deepEqual(failed, { products: [], source: 'unavailable' });
  answer = () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await getCatalog(), { products: [], source: 'unavailable' });
});

test('the test-only fixture catalogue is ignored whenever a database is configured', async () => {
  process.env.FURNISHAR_FIXTURE_CATALOG = 'tests/fixtures/catalog.json';
  try {
    answer = () => new Response('[]', { status: 200 });
    assert.deepEqual(await getCatalog(), { products: [], source: 'supabase' });
  } finally {
    delete process.env.FURNISHAR_FIXTURE_CATALOG;
  }
});

test('the shipped local catalogue is empty', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8')), []);
});

test('a card uses its own poster, a public image — never the model', () => {
  const product = toProduct(ROW, 'https://demo.supabase.co');
  assert.equal(product.thumbnail,
    'https://demo.supabase.co/storage/v1/object/public/product-posters/s1/p1/poster-0123456789abcdef.webp');
  assert.equal(product.modelGlb, '/api/sb/model/s1/p1/model.glb', 'the model stays behind the authorised route');
  assert.ok(!product.thumbnail.includes('furniture-models'));
});

test('no model, no poster: a picture of a model that is gone is not shown', () => {
  const product = toProduct({ ...ROW, model_glb_path: null }, 'https://demo.supabase.co');
  assert.equal(product.thumbnail, null);
  assert.equal(product.arReady, false);
  assert.equal(posterUrl(null, 'https://demo.supabase.co'), null);
});

test('stores come from the status column, and an empty answer is no stores', async () => {
  requested = [];
  answer = () => new Response('[]', { status: 200 });
  assert.deepEqual(await getStores(), {});
  assert.match(requested[0], /status=eq\.active/);
  assert.doesNotMatch(requested[0], /is_active/);
});
