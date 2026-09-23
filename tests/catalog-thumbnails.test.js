const test = require('node:test');
const assert = require('node:assert/strict');

/*
 * A product's picture, its 3D badge and its "View in my space" must agree.
 *
 * The thumbnail is withheld when it was rendered from a different file than
 * the product now points at. That comparison used to be made against the
 * URL the model is SERVED from — so when the demo model moved from
 * /models/x.glb to /api/demo-model/x.glb, unchanged, its picture was
 * withheld as "stale" while the badge stayed: a card claiming 3D with no
 * render. It is made against the stored file now.
 */
test('the bundled armchair keeps its picture when its serving URL changes', async () => {
  // A database that refuses the connection: the catalogue falls back to the
  // bundled copy, which is the case under test. Nothing leaves the machine.
  process.env.SUPABASE_URL = 'http://127.0.0.1:9';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_catalogtest0000';
  const { getCatalog } = await import('../lib/catalog.mjs');
  const { products, source } = await getCatalog();
  assert.equal(source, 'bundled');

  const armchair = products.find(p => p.modelSource === 'models/cane-back-armchair.glb');
  assert.ok(armchair, 'the bundled armchair is in the catalogue');
  assert.match(armchair.modelGlb, /^\/api\/demo-model\/cane-back-armchair\.glb$/);
  assert.equal(armchair.thumbnail, '/thumbs/armchair-cane-back.webp');
  assert.equal(armchair.arReady, true, 'picture and badge agree');

  for (const product of products.filter(p => !p.modelGlb)) {
    assert.equal(product.thumbnail, null, `${product.name} has no model, so no picture`);
  }
});
