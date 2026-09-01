const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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
