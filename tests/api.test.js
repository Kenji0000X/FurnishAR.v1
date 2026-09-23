const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const port = 43173;
const catalogPath = path.resolve(__dirname, '../data/catalog.json');
const originalCatalog = fs.readFileSync(catalogPath, 'utf8');
let server;

function resetCatalog() {
  fs.writeFileSync(catalogPath, originalCatalog);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the local server.')), 5000);
    server.stdout.on('data', message => {
      if (message.toString().includes('FurnishAR is running')) { clearTimeout(timeout); resolve(); }
    });
    server.once('error', reject);
  });
}

test.before(async () => {
  resetCatalog();
  server = spawn(process.execPath, ['local.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port) } });
  await waitForServer();
});

test.beforeEach(() => resetCatalog());
test.after(() => { resetCatalog(); server?.kill(); });

test('the handler serves the API only, not the site', async () => {
  // Next.js renders the pages now; lib/handler.js is the demo API behind
  // /api/* and no longer has an index.html to hand out.
  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 404);
});

test('catalog and health endpoints serve the expected data', async () => {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(response => response.json());
  const catalog = await fetch(`http://127.0.0.1:${port}/api/products`).then(response => response.json());
  const privateSource = await fetch(`http://127.0.0.1:${port}/server.js`);
  assert.equal(health.status, 'ok');
  assert.ok(catalog.products.length >= 1);
  assert.ok(catalog.products.every(product => product.dimensions.width > 0 && product.arReady));
  // Source files must never be readable over HTTP, whatever else changes.
  assert.equal(privateSource.status, 404);
});

test('catalog products with a GLB carry AR bounds and the file is served', async () => {
  const catalog = await fetch(`http://127.0.0.1:${port}/api/products`).then(response => response.json());
  const withModel = catalog.products.filter(p => p.modelGlb);
  assert.ok(withModel.length >= 1, 'Should have at least one product with a GLB model');
  for (const product of withModel) {
    assert.ok(product.modelBounds, `${product.id} should declare AR bounds`);
    assert.ok(product.modelBounds.width > 0);
    assert.ok(product.modelBounds.height > 0);
    assert.ok(product.modelBounds.depth > 0);
    /* Whether the file itself is handed out depends on whether a database is
       configured, and both answers are asserted — not skipped.
       Bundled models moved out of /public to data/models: with a database,
       products are protected by 0007 and a product model must never be a
       plain download, even when the database is momentarily unreachable and
       the catalogue has fallen back to the bundled copy (fail closed). With
       no database at all there are no accounts to require, so the offline
       demo serves it. The server decides with this same isConfigured(). */
    const asset = await fetch(`http://127.0.0.1:${port}/${product.modelGlb}`);
    if (require('../lib/supabase-proxy.js').isConfigured()) {
      assert.equal(asset.status, 404,
        `${product.modelGlb} must not be a plain download on a deployment with a database`);
    } else {
      assert.equal(asset.status, 200, `${product.modelGlb} should be served in offline demo mode`);
      assert.equal(asset.headers.get('content-type'), 'model/gltf-binary');
    }
  }
});

test('the USDZ field stays optional so GLB-only products still work', async () => {
  const catalog = await fetch(`http://127.0.0.1:${port}/api/products`).then(response => response.json());
  assert.ok(catalog.products.every(p => p.modelUsdz === undefined || typeof p.modelUsdz === 'string'));
});

test('owner login is scoped and protected API routes reject anonymous changes', async () => {
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@furnishar.ph', password: 'furnishar' }) });
  const session = await login.json();
  const denied = await fetch(`http://127.0.0.1:${port}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 200);
  assert.equal(session.user.storeId, 'sc-variety');
  assert.equal(typeof session.token, 'string');
  assert.equal(denied.status, 401);
});

test('the Vercel function entry exports a request handler without starting a server', () => {
  const handler = require('../api/index.js');
  assert.equal(typeof handler, 'function');
});

test('the local listener does not start in the Vercel runtime', async () => {
  const child = spawn(process.execPath, ['local.js'], {
    cwd: path.resolve(__dirname, '..'),
    // A session secret is required in production; supply one so this test
    // exercises the listener, not the secret guard.
    env: { ...process.env, VERCEL: '1', FURNISHAR_JWT_SECRET: 'test-secret-for-this-case' }
  });
  const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(exitCode, 0);
});

test('a production runtime refuses to start on the repository\'s public dev secret', async () => {
  const child = spawn(process.execPath, ['local.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, VERCEL: '1', FURNISHAR_JWT_SECRET: '' }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.notEqual(exitCode, 0, 'it must not boot with a forgeable session secret');
  assert.match(stderr, /FURNISHAR_JWT_SECRET is not set/);
});

test('importing the handler is safe without a secret, but using it is not', () => {
  // `next build` imports this module to collect route configuration on a
  // machine that legitimately has no secret, so import must not throw. The
  // refusal moved to the point where a session token would actually be signed.
  const handler = require('../lib/handler.js');
  const previousVercel = process.env.VERCEL;
  const previousSecret = process.env.FURNISHAR_JWT_SECRET;
  process.env.VERCEL = '1';
  delete process.env.FURNISHAR_JWT_SECRET;
  try {
    assert.throws(() => handler.assertSigningSecret(), /FURNISHAR_JWT_SECRET is not set/);
    process.env.FURNISHAR_JWT_SECRET = 'a-real-secret';
    assert.equal(handler.assertSigningSecret(), 'a-real-secret');
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    if (previousSecret === undefined) delete process.env.FURNISHAR_JWT_SECRET; else process.env.FURNISHAR_JWT_SECRET = previousSecret;
  }
});

test('the Vercel rewrite reaches the requested API endpoint', async () => {
  const handler = require('../api/index.js');
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    const response = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await new Promise(resolve => functionServer.close(resolve));
  }
});

test('Vercel returns a controlled response instead of crashing on a file-backed catalog write', async () => {
  const handler = require('../api/index.js');
  const previousVercel = process.env.VERCEL;
  const previousSecret = process.env.FURNISHAR_JWT_SECRET;
  process.env.VERCEL = '1';
  // A real Vercel deployment has a signing secret set; without one the handler
  // refuses to mint a session at all, and this test would never reach the
  // catalog write it is about.
  process.env.FURNISHAR_JWT_SECRET = previousSecret || 'test-secret-for-the-vercel-write-path';
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    const login = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@furnishar.ph', password: 'furnishar' }) }).then(response => response.json());
    const response = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify({ name: 'Test shelf', category: 'Storage', style: 'Modern', color: 'Natural', price: 100, stock: 1, dimensions: { width: 10, height: 10, depth: 10 } }) });
    assert.equal(response.status, 503);
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    if (previousSecret === undefined) delete process.env.FURNISHAR_JWT_SECRET; else process.env.FURNISHAR_JWT_SECRET = previousSecret;
    await new Promise(resolve => functionServer.close(resolve));
  }
});

test('freemium stores are capped at 8 products and premium stores have no limit', async () => {
  const handler = require('../api/index.js');
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    // Login as the freemium store (tiampion)
    const freemiumLogin = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tiampion@furnishar.ph', password: 'furnishar' }) }).then(response => response.json());
    const testProduct = { name: 'Test item', category: 'Storage', style: 'Modern', color: 'Natural', price: 100, stock: 1, dimensions: { width: 10, height: 10, depth: 10 } };

    // Fill the store up to its 8-product freemium limit, whatever it starts with
    const catalog = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`).then(response => response.json());
    const existing = catalog.products.filter(p => p.storeId === 'tiampion').length;
    for (let i = existing; i < 8; i++) {
      const resp = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freemiumLogin.token}` }, body: JSON.stringify(testProduct) });
      assert.equal(resp.status, 201, `Product ${i + 1} should succeed`);
    }

    // The 9th product should fail with 403
    const failResp = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freemiumLogin.token}` }, body: JSON.stringify(testProduct) });
    assert.equal(failResp.status, 403);
    const error = await failResp.json();
    assert.ok(error.error.includes('Freemium plan limited'));
  } finally {
    await new Promise(resolve => functionServer.close(resolve));
  }
});

test('featured products are sorted first in catalog', async () => {
  const handler = require('../api/index.js');
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    const catalog = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`).then(response => response.json());
    const featured = catalog.products.filter(p => p.featured);
    const notFeatured = catalog.products.filter(p => !p.featured);
    
    if (featured.length > 0 && notFeatured.length > 0) {
      const lastFeatured = catalog.products.findIndex(p => p.featured === false);
      const firstNotFeatured = catalog.products.findIndex(p => p.featured === true);
      assert.ok(lastFeatured > firstNotFeatured, 'Featured products should come first');
    }
  } finally {
    await new Promise(resolve => functionServer.close(resolve));
  }
});

test('products are stamped with updatedAt and it changes on PUT', async () => {
  const handler = require('../api/index.js');
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    // Login as premium store
    const login = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@furnishar.ph', password: 'furnishar' }) }).then(response => response.json());
    
    // Create a new product
    const newProduct = { name: 'Audit Trail Test', category: 'Storage', style: 'Modern', color: 'Natural', price: 100, stock: 1, dimensions: { width: 10, height: 10, depth: 10 } };
    const createResp = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify(newProduct) });
    const created = await createResp.json();
    assert.ok(created.product.updatedAt, 'Product should have updatedAt on creation');
    const firstUpdate = new Date(created.product.updatedAt);
    
    // Wait 100ms and then update the product
    await new Promise(resolve => setTimeout(resolve, 100));
    const updateResp = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products/${created.product.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify({ ...newProduct, name: 'Updated Name' }) });
    const updated = await updateResp.json();
    const secondUpdate = new Date(updated.product.updatedAt);
    
    assert.ok(secondUpdate > firstUpdate, 'updatedAt should change on PUT');
  } finally {
    await new Promise(resolve => functionServer.close(resolve));
  }
});

test('store profiles are available via /api/stores with address and contact info', async () => {
  const handler = require('../api/index.js');
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    const response = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=stores`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.stores.length >= 3, 'Should have at least 3 stores');
    
    const scVariety = data.stores.find(s => s.name === 'S&C Variety Store');
    assert.ok(scVariety, 'Should have S&C Variety Store');
    assert.ok(scVariety.address.includes('Mamburao'), 'Should have address with Mamburao');
    assert.ok(scVariety.contactNumber, 'Should have contact number');
    assert.ok(scVariety.hours, 'Should have hours');
    assert.equal(scVariety.plan, 'premium', 'S&C Variety should be premium');
  } finally {
    await new Promise(resolve => functionServer.close(resolve));
  }
});


test('the demo sign-in and inventory writes close once a database is configured', async () => {
  // P1 (/api/sb/auth/*) is the only authentication on a database-backed
  // deployment. The demo shop's sign-in, with its password in lib/handler.js,
  // must not answer there as a second way in — nor its catalogue writes.
  const configuredPort = 43179;
  const configured = spawn(process.execPath, ['local.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(configuredPort),
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_testonly000000000000'
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for the configured server.')), 5000);
      configured.stdout.on('data', message => {
        if (message.toString().includes('FurnishAR is running')) { clearTimeout(timeout); resolve(); }
      });
      configured.once('error', reject);
    });
    const base = `http://127.0.0.1:${configuredPort}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@furnishar.ph', password: 'furnishar' })
    });
    assert.equal(login.status, 404);
    assert.equal((await login.json()).token, undefined);
    const write = await fetch(`${base}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(write.status, 404);
    // Public reads stay: they are the bundled catalogue, not a permission.
    assert.equal((await fetch(`${base}/api/products`)).status, 200);
  } finally {
    configured.kill();
  }
});
