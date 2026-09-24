/**
 * The store owner's 3D model form, driven in a real browser.
 *
 * What the owner types is the size of the furniture; the model file supplies
 * its shape. This checks that promise end to end, through the rendered form:
 *
 *   • 30 × 30 × 40 cm with a model exported in metres, centimetres or
 *     millimetres is READY — the file's units never decide the size.
 *   • Switching cm → in → ft → cm rewrites the numbers and never the size:
 *     the saved row is 30 × 30 × 40 cm whichever unit it was typed in.
 *   • A cube against 30 × 30 × 40 is refused with both proportions shown,
 *     "Review dimensions" and "Replace 3D model", and cannot be saved.
 *   • A file that is not a model, or not a .glb, is refused before upload.
 *   • Nothing overflows sideways from 320 px to 1280 px.
 *
 * Supabase is a local mock (as in check-upload-progress.mjs), so this runs
 * without credentials and without touching real data. Screenshots of the
 * states go to the scratch directory named by SHOT_DIR, if set.
 *
 *   node scripts/check-model-form.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { makeTestGlb } from './make-test-glb.mjs';

const SB_PORT = 4811;
const APP_PORT = 4812;
const KEY = 'sb_publishable_modelformcheck0';
const STORE_ID = '21f61742-6d5d-4239-9592-05b2a79a0453';
const PRODUCT_ID = '5a6a9821-98f1-4b14-bec9-ddd8272d6819';
const SHOT_DIR = process.env.SHOT_DIR || '';
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const productWrites = [];
let uploads = 0;

const supabase = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, PATCH, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-upsert, authorization, apikey, prefer');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'PUT' && req.url.includes('/upload/sign/')) { uploads += 1; return send(200, {}); }
    if (req.url.startsWith('/auth/v1/health')) return send(200, { name: 'GoTrue' });
    if (req.url.startsWith('/auth/v1/user')) return send(200, { id: 'u1', email: 'owner@furnishar.ph' });
    if (req.url.includes('grant_type=password')) {
      return send(200, { access_token: 'u1', refresh_token: 'u1-r', user: { id: 'u1', email: 'owner@furnishar.ph' } });
    }
    if (req.url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, false);
    if (req.url.startsWith('/rest/v1/store_members')) {
      return send(200, [{ role: 'owner', stores: { id: STORE_ID, slug: 'sc-variety', name: 'S&C Variety Store', plan: 'freemium' } }]);
    }
    if (req.url.startsWith('/rest/v1/products')) {
      if (req.method === 'POST' || req.method === 'PATCH') {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* not JSON */ }
        productWrites.push({ method: req.method, body: Array.isArray(body) ? body[0] : body });
        return send(req.method === 'POST' ? 201 : 200, [{ id: PRODUCT_ID, store_id: STORE_ID }]);
      }
      return send(200, []);
    }
    if (req.url.startsWith('/storage/v1/object/upload/sign')) {
      return send(200, { url: `/object/upload/sign/furniture-models/${STORE_ID}/${PRODUCT_ID}/model.glb?token=x` });
    }
    if (req.url.startsWith('/rest/v1/product_assets')) {
      if (req.method === 'GET') return send(200, [{ id: 'a1' }]);
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
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'model-form-check' },
  stdio: 'ignore',
  detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/portal`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 160)));

async function signIn() {
  await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  await page.fill('input[name="email"]', 'owner@furnishar.ph');
  await page.fill('input[name="password"]', 'x');
  await page.click('form.login-form button[type="submit"]');
  await page.waitForSelector('.console', { timeout: 20000 });
}

async function openForm() {
  if (await page.locator('dialog.form-dialog[open]').count()) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.form-dialog[open]', { state: 'detached' }).catch(() => {});
  }
  await page.click('.console-head button:has-text("Add Product")');
  await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
}

async function fillBasics(name) {
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="price"]', '4500');
  await page.fill('input[name="stock"]', '2');
}

async function setSize(width, depth, height) {
  await page.fill('input[name="width"]', String(width));
  await page.fill('input[name="depth"]', String(depth));
  await page.fill('input[name="height"]', String(height));
}

async function chooseModel(name, buffer) {
  await page.setInputFiles('input[name="modelFile"]', { name, mimeType: 'model/gltf-binary', buffer });
}

async function settledState() {
  const handle = await page.waitForSelector(
    '.upload-state[data-state="ready"], .upload-state[data-state="scale-mismatch"], .upload-state[data-state="error"]',
    { timeout: 60000 }
  ).catch(() => null);
  return handle ? handle.getAttribute('data-state') : 'timeout';
}

const shot = async name => {
  if (!SHOT_DIR) return;
  // Headless Chromium draws WebGL in software, which can hold the dialog's
  // 220 ms entrance for a while; capture it once it has finished.
  await page.waitForFunction(() => {
    const d = document.querySelector('dialog.form-dialog');
    return d && getComputedStyle(d).opacity === '1';
  }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);   // and let any control finish its own transition
  // The whole viewport, not the element: the dialog is in the top layer and
  // an element capture can include the page behind a translucent backdrop.
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) }).catch(() => {});
};

const fields = () => page.evaluate(() => ['width', 'depth', 'height']
  .map(n => document.querySelector(`input[name="${n}"]`).value));

await signIn();

console.log('--- one physical size, whatever the file\'s units ---');
// makeTestGlb's size is [width, height, depth] in the file's own units.
for (const [label, size] of [
  ['metres', [0.3, 0.4, 0.3]],
  ['centimetres', [30, 40, 30]],
  ['millimetres', [300, 400, 300]]
]) {
  await openForm();
  await fillBasics(`Stool (${label})`);
  await setSize(30, 30, 40);
  await chooseModel(`stool-${label}.glb`, makeTestGlb(4096, { size }));
  const state = await settledState();
  check(`a model exported in ${label} is ready for AR at 30 × 30 × 40 cm`, state === 'ready', state);
  if (label === 'millimetres') {
    const checks = await page.$$eval('.scale-checks li', items => items.map(li => li.dataset.state));
    check('every readiness check is ticked', checks.every(s => s === 'done'), checks.join(', '));
    const overlay = (await page.locator('.model-preview-size').textContent().catch(() => '')) || '';
    check('the stage shows the size it was given', /W 30 cm.*D 30 cm.*H 40 cm/.test(overlay), overlay);
    await page.waitForSelector('.model-preview-stage[data-drawn="true"]', { timeout: 30000 }).catch(() => {});
    await shot('01-ready-desktop');
  }
}

console.log('--- switching units changes the numbers, never the size ---');
await page.check('input[name="sizeUnit"][value="in"]', { force: true });
const inches = await fields();
check('inches: 11.811 × 11.811 × 15.748', inches.join(' ') === '11.811 11.811 15.748', inches.join(' '));
const savedAs = (await page.locator('.size-saved').textContent().catch(() => '')) || '';
check('says what will be stored', savedAs.includes('30 × 30 × 40 cm'), savedAs);
check('still ready for AR after the switch',
  (await page.locator('.upload-state').getAttribute('data-state')) === 'ready');
await page.check('input[name="sizeUnit"][value="ft"]', { force: true });
const feet = await fields();
check('feet: 0.984 × 0.984 × 1.312', feet.join(' ') === '0.984 0.984 1.312', feet.join(' '));
await shot('02-feet');
await page.check('input[name="sizeUnit"][value="cm"]', { force: true });
const back = await fields();
check('back to cm: exactly 30 × 30 × 40, nothing rounded away', back.join(' ') === '30 30 40', back.join(' '));

// Saved while showing feet: the row still says centimetres.
await page.check('input[name="sizeUnit"][value="ft"]', { force: true });
productWrites.length = 0;
uploads = 0;
await page.click('dialog.form-dialog button[type="submit"]');
await page.waitForSelector('dialog.form-dialog[open]', { state: 'detached', timeout: 30000 }).catch(() => {});
const row = productWrites[0]?.body || {};
check('saved from feet as 30 × 30 × 40 cm',
  row.width_cm === 30 && row.depth_cm === 30 && row.height_cm === 40,
  JSON.stringify({ w: row.width_cm, d: row.depth_cm, h: row.height_cm }));
check('no second size is written (bounds left to fall back to the dimensions)',
  row.bounds_width_cm == null && row.bounds_height_cm == null && row.bounds_depth_cm == null,
  JSON.stringify({ bw: row.bounds_width_cm, bh: row.bounds_height_cm, bd: row.bounds_depth_cm }));
check('the model uploaded', uploads === 1, `${uploads} upload(s)`);

console.log('--- typing a new size in inches ---');
await openForm();
await fillBasics('Side table');
check('the unit choice is remembered on this browser',
  await page.isChecked('input[name="sizeUnit"][value="ft"]'));
await page.check('input[name="sizeUnit"][value="in"]', { force: true });
await setSize(12, 12, 24);
await chooseModel('side-table.glb', makeTestGlb(4096, { size: [0.3048, 0.6096, 0.3048] }));
check('12 × 12 × 24 in against a model of that size is ready', (await settledState()) === 'ready');
const savedIn = (await page.locator('.size-saved').textContent().catch(() => '')) || '';
check('12 in is stored as 30.5 cm (0.1 cm columns)', savedIn.includes('30.5 × 30.5 × 61 cm'), savedIn);
await page.check('input[name="sizeUnit"][value="cm"]', { force: true });

console.log('--- a model whose shape cannot be this size ---');
await openForm();
await fillBasics('Cube pretending to be a stool');
await setSize(30, 30, 40);
await chooseModel('cube.glb', makeTestGlb(4096, { size: [1, 1, 1] }));
check('a cube against 30 × 30 × 40 is a proportion mismatch', (await settledState()) === 'scale-mismatch');
const alertText = (await page.locator('.scale-attention').textContent().catch(() => '')) || '';
check('names the problem', /proportions don.t match the furniture dimensions/i.test(alertText), alertText.slice(0, 80));
check('shows the entered size', alertText.includes('30 × 30 × 40 cm'));
check('shows the model proportion', alertText.includes('1.00 : 1.00 : 1.00'));
check('shows the expected proportion', alertText.includes('0.75 : 0.75 : 1.00'));
check('offers Review dimensions and Replace 3D model',
  await page.locator('.scale-attention button:has-text("Review dimensions")').count() === 1
  && await page.locator('.scale-attention button:has-text("Replace 3D model")').count() === 1);
check('offers no way to ignore it', await page.locator('.scale-attention button:has-text("Ignore")').count() === 0);
check('no scale control anywhere', await page.locator('dialog.form-dialog input[name*="scale" i]').count() === 0);
check('the AR box size fields are gone', await page.locator('input[name="modelWidth"]').count() === 0);
await page.waitForSelector('.model-preview-stage[data-drawn="true"]', { timeout: 30000 }).catch(() => {});
await shot('03-mismatch-desktop');
productWrites.length = 0;
await page.click('dialog.form-dialog button[type="submit"]');
await page.waitForTimeout(800);
const refusal = (await page.locator('dialog.form-dialog .form-error').textContent().catch(() => '')) || '';
check('Save is refused, with the reason', /proportions don.t match/i.test(refusal), refusal.slice(0, 90));
check('nothing was written', productWrites.length === 0, `${productWrites.length} write(s)`);
await page.click('.scale-attention button:has-text("Review dimensions")');
check('Review dimensions puts focus in Width',
  await page.evaluate(() => document.activeElement?.getAttribute('name')) === 'width');
// Correcting the size to the cube's own proportions clears it without a new file.
await setSize(40, 40, 40);
check('entering a size the cube can be clears the mismatch', (await settledState()) === 'ready');

console.log('--- files that are not a usable model ---');
await openForm();
await fillBasics('Broken');
await setSize(50, 50, 50);
await chooseModel('broken.glb', Buffer.from('this is not a model at all, just some text padded out'));
check('an unreadable .glb is refused before upload', (await settledState()) === 'error');
const failText = (await page.locator('.model-preview-note.is-error').textContent().catch(() => '')) || '';
check('says it could not be read', /could not be read/i.test(failText), failText.slice(0, 70));
await page.setInputFiles('input[name="modelFile"]', { name: 'chair.obj', mimeType: 'text/plain', buffer: Buffer.from('v 0 0 0') });
const wrongType = (await page.locator('.upload-state').textContent().catch(() => '')) || '';
check('a non-.glb file is refused by name', /not a \.glb/i.test(wrongType), wrongType.slice(0, 70));

console.log('--- physical size validation ---');
await openForm();
await fillBasics('Validation');
await page.check('input[name="sizeUnit"][value="ft"]', { force: true });
await setSize(999, 2, 3);
await page.click('dialog.form-dialog button[type="submit"]');
await page.waitForTimeout(300);
const widthError = (await page.locator('#size-error-width').textContent().catch(() => '')) || '';
check('999 ft is refused, with the limit in feet', /32\.81 ft limit \(1000 cm\)/.test(widthError), widthError);
check('the field is marked invalid', (await page.getAttribute('input[name="width"]', 'aria-invalid')) === 'true');
await setSize(20, 2, 3);
const large = (await page.locator('.size-large').textContent().catch(() => '')) || '';
check('20 ft (610 cm) is allowed but questioned', /Width is over 16\.4 ft/.test(large), large);
await page.check('input[name="sizeUnit"][value="cm"]', { force: true });

console.log('--- no sideways overflow, phone to desktop ---');
await openForm();
await fillBasics('A very long product name that should not push anything sideways at all');
await setSize(30, 30, 40);
await chooseModel('an-extremely-long-model-file-name-exported-from-a-3d-tool-v12-final-final.glb', makeTestGlb(4096, { size: [1, 1, 1] }));
await settledState();
for (const width of [320, 360, 390, 414, 768, 1024, 1280]) {
  await page.setViewportSize({ width, height: 860 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.form-dialog');
    const wide = [...dialog.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      const d = dialog.getBoundingClientRect();
      return r.width > 0 && (r.right > d.right + 1 || r.left < d.left - 1);
    }).map(el => el.className || el.tagName).slice(0, 3);
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      dialog: dialog.scrollWidth - dialog.clientWidth,
      wide
    };
  });
  check(`${width}px: nothing wider than the dialog`, overflow.page <= 0 && overflow.dialog <= 0 && !overflow.wide.length,
    JSON.stringify(overflow));
  if (width === 390) {
    await page.locator('.scale-attention').scrollIntoViewIfNeeded().catch(() => {});
    await shot('04-mismatch-390');
  }
}
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.waitForTimeout(300);
await shot('05-mismatch-dark');

await browser.close();
stop();
supabase.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe model form keeps one physical size and refuses what cannot be it');
process.exit(problems.length ? 1 : 0);
