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
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { makeOversizedGlb, makeGeometryHeavyGlb } from './make-oversized-glb.mjs';

const SB_PORT = 4951;
const APP_PORT = 4952;
const KEY = 'sb_publishable_shrinkcheck00';
const STORE = '21f61742-6d5d-4239-9592-05b2a79a0453';
const PRODUCT = '5a6a9821-98f1-4b14-bec9-ddd8272d6819';
const LIMIT = 40 * 1024 * 1024;   // must match UPLOAD_LIMIT_BYTES in the dialog

let uploadedBytes = null;
let productCount = 0;
const scratch = mkdtempSync(join(tmpdir(), 'shrink-check-'));

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
      if (req.method === 'POST') {
        productCount += 1;
        // Still a real 36-character uuid: the proxy refuses an object path whose
        // middle segment is not one, so a counter tacked on the end would fail
        // the upload for a reason that has nothing to do with shrinking.
        const id = `${PRODUCT.slice(0, -1)}${productCount}`;
        return send(201, [{ id, store_id: STORE, slug: `big-${productCount}` }]);
      }
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
await page.waitForSelector('.console', { timeout: 20000 }).catch(() => {});

/** Uploads one oversized model through the real dialog and inspects the result. */
async function uploadAndInspect(name, bytes, size = { width: 100, height: 100, depth: 100 }) {
  uploadedBytes = null;
  await page.click('.console-head button:has-text("Add Product")');
  await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="price"]', '7500');
  await page.fill('input[name="stock"]', '1');
  // The model's own proportions: the portal now refuses a model whose shape
  // cannot be the entered size, so these have to describe the same piece.
  await page.fill('input[name="width"]', String(size.width));
  await page.fill('input[name="height"]', String(size.height));
  await page.fill('input[name="depth"]', String(size.depth));
  // Through a file on disk, not a buffer: Playwright refuses to marshal more
  // than 50 MB inline, and an oversized model is by definition more than that.
  const staged = join(scratch, `oversized-${Date.now()}.glb`);
  writeFileSync(staged, bytes);
  await page.setInputFiles('input[name="modelFile"]', staged);
  // The portal reads the model and checks its proportions before it will
  // save it. On a headless browser with no GPU, a dense model takes a while
  // to draw, so wait for the check the owner would see, then save.
  const checkStarted = Date.now();
  const settled = await page.waitForSelector(
    '.upload-state[data-state="ready"], .upload-state[data-state="scale-mismatch"], .upload-state[data-state="error"]',
    { timeout: 240000 }
  ).then(el => el.getAttribute('data-state')).catch(() => 'timeout');
  // …and for the first frame of the preview, which is what keeps a GPU-less
  // browser busy longest.
  await page.waitForSelector('.model-preview-stage[data-drawn="true"]', { timeout: 240000 }).catch(() => {});
  console.log(`  local check: ${settled}, preview drawn after ${((Date.now() - checkStarted) / 1000).toFixed(1)} s`);

  const statuses = new Set();
  const poll = setInterval(async () => {
    const text = await page.locator('dialog.form-dialog button[type="submit"]').innerText().catch(() => '');
    if (text) statuses.add(text.replace(/\d+/g, 'N'));
  }, 120);

  await page.click('dialog.form-dialog button[type="submit"]');
  await page.waitForSelector('dialog.form-dialog[open]', { state: 'detached', timeout: 240000 }).catch(() => {});
  clearInterval(poll);

  const error = (await page.locator('dialog.form-dialog .form-error').textContent().catch(() => '')) || '';
  // Close a dialog still open from a failure, so the next case can start.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  return { statuses: [...statuses], error: error.trim() };
}

/** Everything both cases must satisfy. */
async function assertShrunk(label, original) {
  check(`${label}: the upload was not rejected`, !/will not fit|still over/i.test(original.error),
    original.error.slice(0, 110));
  check(`${label}: something reached Storage`, Boolean(uploadedBytes), `${uploadedBytes?.length ?? 0} bytes`);
  if (!uploadedBytes) return;

  check(`${label}: what reached Storage is under the limit`,
    uploadedBytes.length <= LIMIT,
    `${(uploadedBytes.length / 1048576).toFixed(1)} MB from ${(original.size / 1048576).toFixed(1)} MB`);

  let parsed = null;
  try {
    parsed = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .readBinary(new Uint8Array(uploadedBytes));
  } catch (error) {
    console.log('   parse error:', error.message.slice(0, 140));
  }
  check(`${label}: the shrunk file is still a valid glTF document`, Boolean(parsed));
  if (parsed) {
    check(`${label}: it still has its mesh geometry`, parsed.getRoot().listMeshes().length > 0,
      `${parsed.getRoot().listMeshes().length} mesh(es)`);
  }
}

console.log('--- a texture-heavy model (4k maps) ---');
{
  const bytes = await makeOversizedGlb(
    readFileSync(new URL('../data/models/cane-back-armchair.glb', import.meta.url)),
    45 * 1024 * 1024
  );
  console.log(`  built ${(bytes.length / 1048576).toFixed(1)} MB, limit is ${LIMIT / 1048576} MB`);
  // Built from the cane-back armchair, so it is the armchair's size.
  const run = await uploadAndInspect('Texture Heavy Cabinet', bytes, { width: 70, height: 88, depth: 78 });
  check('texture-heavy: the owner saw it being worked on',
    run.statuses.some(s => /shrink|compress|reading|checking|simplif/i.test(s)),
    run.statuses.join(' | ').slice(0, 120));
  await assertShrunk('texture-heavy', { error: run.error, size: bytes.length });
}

console.log('--- a geometry-heavy model, no textures at all ---');
{
  // The reported case: 60.4 MB in, 60.4 MB out, because only textures were
  // ever touched and this file has none.
  const bytes = await makeGeometryHeavyGlb(60 * 1024 * 1024);
  console.log(`  built ${(bytes.length / 1048576).toFixed(1)} MB with 0 textures`);
  const run = await uploadAndInspect('Geometry Heavy Cabinet', bytes);
  check('geometry-heavy: the owner saw it being worked on',
    run.statuses.some(s => /shrink|compress|reading|checking|simplif/i.test(s)),
    run.statuses.join(' | ').slice(0, 120));
  await assertShrunk('geometry-heavy', { error: run.error, size: bytes.length });
}

console.log('--- 100 MB, the largest file the portal accepts at all ---');
{
  // The explicit ask: a 100 MB model must still come out usable, not refused.
  const bytes = await makeGeometryHeavyGlb(100 * 1024 * 1024);
  console.log(`  built ${(bytes.length / 1048576).toFixed(1)} MB`);
  const run = await uploadAndInspect('Hundred Megabyte Cabinet', bytes);
  await assertShrunk('100 MB', { error: run.error, size: bytes.length });
}

await browser.close();
stop();
supabase.close();
rmSync(scratch, { recursive: true, force: true });

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nan oversized model is shrunk automatically and still loads');
process.exit(problems.length ? 1 : 0);
