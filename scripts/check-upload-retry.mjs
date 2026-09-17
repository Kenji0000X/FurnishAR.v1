/**
 * What happens when the model upload fails and the owner tries again?
 *
 * Saving is two steps: create the product row, then upload the file. The
 * second can fail on its own — a file Storage refuses, a dropped connection —
 * and the row from the first step still exists. Reported from production: the
 * upload returned 400, the retry returned 409, and neither said anything
 * useful. Two faults behind that:
 *
 *   1. putWithProgress() threw away Storage's response body, so "The object
 *      exceeded the maximum allowed size" reached the owner as the far less
 *      helpful "The model could not be uploaded (400)".
 *   2. The retry re-INSERTED the product, colliding with unique (store_id,
 *      slug) — PostgREST 409 — telling the owner they already had a product
 *      with that name, about the row they had just half-created themselves.
 *
 * This drives both: a first attempt Storage refuses, then a retry.
 *
 *   node scripts/check-upload-retry.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { makeTestGlb } from './make-test-glb.mjs';

const SB_PORT = 4911;
const APP_PORT = 4912;
const KEY = 'sb_publishable_uploadretry00';
const STORE = '21f61742-6d5d-4239-9592-05b2a79a0453';
const PRODUCT = '5a6a9821-98f1-4b14-bec9-ddd8272d6819';

let uploadAttempts = 0;
const productWrites = [];   // { method, conflicted }
const existingSlugs = new Set();

const supabase = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, PATCH, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-upsert, authorization, apikey, prefer');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'PUT' && req.url.includes('/upload/sign/')) {
    uploadAttempts += 1;
    const attempt = uploadAttempts;
    req.resume();
    req.on('end', () => {
      if (attempt === 1) {
        // Exactly what Supabase Storage says when the bucket's own
        // file_size_limit refuses a file.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          statusCode: '413', error: 'Payload too large',
          message: 'The object exceeded the maximum allowed size'
        }));
      }
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
        const slug = (JSON.parse(raw || '{}').slug) || '';
        if (existingSlugs.has(slug)) {
          // The real 23505 PostgREST returns for unique (store_id, slug).
          productWrites.push({ method: 'POST', conflicted: true });
          return send(409, {
            code: '23505',
            details: `Key (store_id, slug)=(${STORE}, ${slug}) already exists.`,
            message: 'duplicate key value violates unique constraint "products_store_id_slug_key"'
          });
        }
        existingSlugs.add(slug);
        productWrites.push({ method: 'POST', conflicted: false });
        return send(201, [{ id: PRODUCT, store_id: STORE, slug }]);
      }
      if (req.method === 'PATCH') {
        productWrites.push({ method: 'PATCH', conflicted: false });
        return send(200, [{ id: PRODUCT, store_id: STORE }]);
      }
      return send(200, []);
    }
    if (req.url.startsWith('/storage/v1/object/upload/sign')) {
      return send(200, { url: `/object/upload/sign/furniture-models/${STORE}/${PRODUCT}/model.glb?token=x` });
    }
    if (req.url.startsWith('/rest/v1/product_assets')) return send(201, null);
    send(200, []);
  });
});
await new Promise(resolve => supabase.listen(SB_PORT, resolve));

if (await fetch(`http://127.0.0.1:${APP_PORT}/portal`).then(() => true).catch(() => false)) {
  console.error(`Something is already listening on ${APP_PORT}. Stop it first.`);
  process.exit(1);
}

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'upload-retry-check' },
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

await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('form.login-form', { timeout: 20000 });
await page.fill('input[name="email"]', 'owner@furnishar.ph');
await page.fill('input[name="password"]', 'x');
await page.click('form.login-form button[type="submit"]');
await page.waitForSelector('.dashboard', { timeout: 20000 }).catch(() => {});

async function fillAndSubmit() {
  await page.fill('input[name="name"]', 'Retry Test Bench');
  await page.fill('input[name="price"]', '1200');
  await page.fill('input[name="stock"]', '2');
  await page.fill('input[name="width"]', '80');
  await page.fill('input[name="height"]', '45');
  await page.fill('input[name="depth"]', '40');
  await page.setInputFiles('input[name="modelFile"]', {
    name: 'model.glb', mimeType: 'model/gltf-binary', buffer: makeTestGlb(512 * 1024)
  });
  await page.click('dialog.form-dialog button[type="submit"]');
  await page.waitForTimeout(2500);
}

console.log('--- first attempt: Storage refuses the file ---');
await page.click('button:has-text("+ Add product")');
await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
await fillAndSubmit();

const firstError = (await page.locator('dialog.form-dialog .form-error').textContent().catch(() => '')) || '';
check('says why Storage refused it, not just a status code',
  /too large|maximum allowed size|exceeded/i.test(firstError) && !/^The model could not be uploaded \(\d+\)\.$/.test(firstError.trim()),
  firstError.trim().slice(0, 110));
check('the dialog stayed open so it can be retried',
  await page.locator('dialog.form-dialog[open]').count() > 0);

console.log('--- retry: the same form, submitted again ---');
await fillAndSubmit();

const retryError = (await page.locator('dialog.form-dialog .form-error').textContent().catch(() => '')) || '';
const conflicts = productWrites.filter(w => w.conflicted);
check('the retry did not collide with the half-created row',
  conflicts.length === 0, `${conflicts.length} conflict(s); writes: ${productWrites.map(w => w.method).join(', ')}`);
check('the retry updated the existing row instead of inserting a second one',
  productWrites.some(w => w.method === 'PATCH'), productWrites.map(w => w.method).join(', '));
check('no "you already have a product with that name" on a retry of your own upload',
  !/already have a product/i.test(retryError), retryError.trim().slice(0, 80));
check('the retry succeeded and the dialog closed',
  await page.locator('dialog.form-dialog[open]').count() === 0);
check('the file did reach Storage on the second attempt', uploadAttempts === 2, `${uploadAttempts} attempt(s)`);

await browser.close();
stop();
supabase.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\na refused upload explains itself, and the retry works');
process.exit(problems.length ? 1 : 0);
