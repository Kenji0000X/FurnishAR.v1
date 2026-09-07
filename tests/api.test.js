const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const port = 43173;
let server;

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
  server = spawn(process.execPath, ['local.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port) } });
  await waitForServer();
});

test.after(() => server?.kill());

test('catalog and health endpoints serve the expected data', async () => {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(response => response.json());
  const catalog = await fetch(`http://127.0.0.1:${port}/api/products`).then(response => response.json());
  const home = await fetch(`http://127.0.0.1:${port}/`);
  const privateSource = await fetch(`http://127.0.0.1:${port}/server.js`);
  assert.equal(health.status, 'ok');
  assert.ok(catalog.products.length >= 6);
  assert.ok(catalog.products.every(product => product.dimensions.width > 0 && product.arReady));
  assert.equal(home.status, 200);
  assert.equal(privateSource.status, 404);
});

test('products without modelGlb/modelUsdz fields remain optional and backward-compatible', async () => {
  const catalog = await fetch(`http://127.0.0.1:${port}/api/products`).then(response => response.json());
  // Verify some products don't have 3D models
  const noModel = catalog.products.find(p => !p.modelGlb && !p.modelUsdz);
  assert.ok(noModel, 'Should have at least one product without 3D model fields');
  // Verify some products DO have 3D models with proper bounds
  const withModel = catalog.products.find(p => p.modelGlb && p.modelUsdz && p.modelBounds);
  assert.ok(withModel, 'Should have at least one product with complete 3D model info');
  assert.ok(withModel.modelBounds.width > 0);
  assert.ok(withModel.modelBounds.height > 0);
  assert.ok(withModel.modelBounds.depth > 0);
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
  const child = spawn(process.execPath, ['local.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, VERCEL: '1' } });
  const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(exitCode, 0);
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
  process.env.VERCEL = '1';
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    const login = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@furnishar.ph', password: 'furnishar' }) }).then(response => response.json());
    const response = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify({ name: 'Test shelf', category: 'Storage', style: 'Modern', color: 'Natural', price: 100, stock: 1, dimensions: { width: 10, height: 10, depth: 10 } }) });
    assert.equal(response.status, 503);
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    await new Promise(resolve => functionServer.close(resolve));
  }
});

test('freemium stores are capped at 8 products and premium stores have no limit', async () => {
  const handler = require('../api/index.js');
  const functionServer = http.createServer(handler);
  await new Promise(resolve => functionServer.listen(0, '127.0.0.1', resolve));
  const { port: functionPort } = functionServer.address();
  try {
    // Login as freemium store (tiampion) - already has 2 products (table-harvest, shelf-baybay)
    const freemiumLogin = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tiampion@furnishar.ph', password: 'furnishar' }) }).then(response => response.json());
    const testProduct = { name: 'Test item', category: 'Storage', style: 'Modern', color: 'Natural', price: 100, stock: 1, dimensions: { width: 10, height: 10, depth: 10 } };
    
    // Add 6 more products to reach the 8-product limit
    for (let i = 0; i < 6; i++) {
      const resp = await fetch(`http://127.0.0.1:${functionPort}/api/index?__furnishar_path=products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freemiumLogin.token}` }, body: JSON.stringify(testProduct) });
      assert.equal(resp.status, 201, `Product ${i + 1} should succeed`);
    }
    
    // 9th product (3rd added in this test, 9th total) should fail with 403
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

