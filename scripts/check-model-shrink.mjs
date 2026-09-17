/**
 * Does an oversized model get shrunk automatically, and does it still work?
 *
 * The advice for a 60 MB .glb is "run gltf-transform on it", which is useless
 * to a shop owner on a phone — so the portal does it instead, resizing
 * textures until the file fits before it uploads. Two things have to be true
 * for that to be worth anything, and both are checked here against a real
 * 48 MB model with real 2048-pixel textures:
 *
 *   1. The file that reaches Storage is actually under the limit.
 *   2. What arrives is still a loadable .glb, not a mangled one. A shrinker
 *      that produces a smaller broken file is worse than no shrinker, because
 *      it fails later and somewhere else.
 *
 *   node scripts/check-model-shrink.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { NodeIO } from '@gltf-transform/core';
import { makeOversizedGlb } from './make-oversized-glb.mjs';

const SB_PORT = 4951;
const APP_PORT = 4952;
const KEY = 'sb_publishable_shrinkcheck00';
const STORE = '21f61742-6d5d-4239-9592-05b2a79a0453';
const PRODUCT = '5a6a9821-98f1-4b14-bec9-ddd8272d6819';
const LIMIT = 40 * 1024 * 1024;   // must match UPLOAD_LIMIT_BYTES in the dialog

let uploadedBytes = null;

const supabase = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, PATCH, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-upsert, authorization, apikey, prefer');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'PUT' && req.url.includes('/upload/sign/')) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      uploadedBytes = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    return;
  }

  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith('/auth/v1/health')) return send(200, { name: 'GoTrue' });
    if (req.url.startsWith('/auth/v1/user')) return send(200, { id: 'u1', email: 'owner@furnishar.ph' });
    if (req.url.includes('grant_type=password')) {
      return send(200, { access_token: 'u1', refresh_token: 'u1-r', user: { id: 'u1', email: 'owner@furnishar.ph' } });
    }
    if (req.url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, false);
    if (req.url.startsWith('/rest/v1/store_members')) {
      return send(200, [{ role: 'owner', stores: { id: STORE, slug: 'sc-variety', name: 'S&C Variety Store', plan: 'freemium' } }]);
    }
    if (req.url.startsWith('/rest/v1/products')) {
      if (req.method === 'POST') return send(201, [{ id: PRODUCT, store_id: STORE, slug: 'big' }]);
      if (req.method === 'PATCH') return send(200, [{ id: PRODUCT, store_id: STORE }]);
      return send(200, []);
    }
    if (req.url.startsWith('/storage/v1/object/upload/sign')) {
      return send(200, { url: `/object/upload/sign/furniture-models/${STORE}/${PRODUCT}/model.glb?token=x` });
    }
    if (req.url.startsWith('/rest/v1/product_assets')) {
      if (req.method === 'GET') return send(200, [{ object_path: `${STORE}/${PRODUCT}/model.glb` }]);
      return send(201, null);
    }
    send(200, []);
  });
});
await new Promise(resolve => supabase.listen(SB_PORT, resolve));

if (await fetch(`http://127.0.0.1:${APP_PORT}/portal`).then(() => true).catch(() => false)) {
  console.error(`Something is already listening on ${APP_PORT}. Stop it first.`);
  process.exit(1);
}

console.log('building an oversized model…');
const oversized = await makeOversizedGlb(
  readFileSync(new URL('../public/models/cane-back-armchair.glb', import.meta.url)),
  45 * 1024 * 1024
);
console.log(`  ${(oversized.length / 1048576).toFixed(1)} MB, limit is ${LIMIT / 1048576} MB`);

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'shrink-check' },
  stdio: 'ignore',
  detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/portal`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 160)));

await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('form.login-form', { timeout: 20000 });
await page.fill('input[name="email"]', 'owner@furnishar.ph');
await page.fill('input[name="password"]', 'x');
await page.click('form.login-form button[type="submit"]');
await page.waitForSelector('.dashboard', { timeout: 20000 }).catch(() => {});

await page.click('button:has-text("+ Add product")');
await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
await page.fill('input[name="name"]', 'Oversized Cabinet');
await page.fill('input[name="price"]', '7500');
await page.fill('input[name="stock"]', '1');
await page.fill('input[name="width"]', '100');
await page.fill('input[name="height"]', '100');
await page.fill('input[name="depth"]', '100');
await page.setInputFiles('input[name="modelFile"]', {
  name: 'oversized.glb', mimeType: 'model/gltf-binary', buffer: oversized
});

// Watch for the shrinking status, which is the owner-visible part of this.
const statuses = new Set();
const poll = setInterval(async () => {
  const text = await page.locator('dialog.form-dialog button[type="submit"]').innerText().catch(() => '');
  if (text) statuses.add(text.replace(/\d+/g, 'N'));
}, 120);

console.log('uploading…');
await page.click('dialog.form-dialog button[type="submit"]');
await page.waitForSelector('dialog.form-dialog[open]', { state: 'detached', timeout: 180000 }).catch(() => {});
clearInterval(poll);

const shown = [...statuses].join(' | ');
const dialogError = (await page.locator('dialog.form-dialog .form-error').textContent().catch(() => '')) || '';

check('the owner was told it was being shrunk, not left staring at "Saving…"',
  [...statuses].some(s => /shrink|reading|checking/i.test(s)), shown.slice(0, 120));
check('the upload was not rejected for being too large', !/too large|will not fit/i.test(dialogError),
  dialogError.trim().slice(0, 100));
check('something actually reached Storage', Boolean(uploadedBytes), `${uploadedBytes?.length ?? 0} bytes`);

if (uploadedBytes) {
  check('what reached Storage is under the limit',
    uploadedBytes.length <= LIMIT,
    `${(uploadedBytes.length / 1048576).toFixed(1)} MB from ${(oversized.length / 1048576).toFixed(1)} MB`);

  // The part that matters most: smaller is worthless if it no longer loads.
  let parsed = null;
  try {
    parsed = await new NodeIO().readBinary(new Uint8Array(uploadedBytes));
  } catch (error) {
    parsed = null;
    console.log('   parse error:', error.message.slice(0, 120));
  }
  check('the shrunk file is still a valid glTF document', Boolean(parsed));
  if (parsed) {
    check('it still has its mesh geometry', parsed.getRoot().listMeshes().length > 0,
      `${parsed.getRoot().listMeshes().length} mesh(es)`);
    check('it still has its textures', parsed.getRoot().listTextures().length > 0,
      `${parsed.getRoot().listTextures().length} texture(s)`);
  }
}

await browser.close();
stop();
supabase.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nan oversized model is shrunk automatically and still loads');
process.exit(problems.length ? 1 : 0);
