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
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port) } });
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
