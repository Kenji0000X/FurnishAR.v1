/**
 * Catalogue posters and the empty catalogue (0012), in a real browser.
 *
 *   1. A store owner adds a product with a .glb. The form renders a poster
 *      from that model, uploads it to the PUBLIC product-posters bucket (small
 *      WebP, cached for a year) and links it — the model itself stays in the
 *      private bucket.
 *   2. The collection shows that card from the poster alone: zero requests
 *      for any model while browsing.
 *   3. Card states: a model with no poster says "3D model available"; no
 *      model says "No 3D model yet" with no 3D badge; a poster that fails to
 *      load says "Preview unavailable" — never a broken image, never "no model".
 *   4. An empty database is an empty collection: the message, no filters,
 *      no "0 pieces", and no demo furniture.
 *
 *   node scripts/check-posters.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { makeTestGlb } from './make-test-glb.mjs';

const SB_PORT = 4931;
const APP_PORT = 4932;
const KEY = 'sb_publishable_posterscheck0';
const STORE = '31f61742-6d5d-4239-9592-05b2a79a0453';
const SHOTS = process.env.SHOTS || '/tmp/claude-0/posters';
mkdirSync(SHOTS, { recursive: true });

/* ------------------------------------------------ a small fake Supabase --- */
const objects = new Map();          // `${bucket}/${path}` → { bytes, type, cacheControl }
const products = new Map();         // id → row
const assets = [];                  // product_assets rows
const log = { uploads: [], modelSigns: 0, accessRecords: 0, revalidations: 0, posterLinks: 0 };
let catalogEmpty = false;
let nextId = 1;
const uuid = () => `6a6a${String(nextId++).padStart(4, '0')}-98f1-4b14-bec9-ddd8272d6819`;

const catalogRows = () => catalogEmpty ? [] : [...products.values()]
  .filter(p => p.status === 'published')
  .map(p => ({
    ...p, store_id: STORE, store_slug: 'sc-variety', store_name: 'S&C Variety Store', store_fulfilment: 'stocked',
    model_glb_path: assets.find(a => a.product_id === p.id && a.kind === 'glb')?.object_path || null,
    model_usdz_path: null,
    poster_path: assets.find(a => a.product_id === p.id && a.kind === 'poster')?.object_path || null
  }));

const supabase = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, PATCH, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-upsert, authorization, apikey, prefer, cache-control');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const raw = body.toString('utf8');
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const url = req.url;

    if (req.method === 'PUT' && url.includes('/object/upload/sign/')) {
      const key = decodeURIComponent(url.split('/object/upload/sign/')[1].split('?')[0]);
      objects.set(key, { bytes: body, type: req.headers['content-type'], cacheControl: req.headers['cache-control'] || null });
      log.uploads.push({ key, type: req.headers['content-type'], size: body.length, cacheControl: req.headers['cache-control'] || null });
      return send(200, { Key: key });
    }
    if (req.method === 'GET' && url.startsWith('/storage/v1/object/public/')) {
      const key = decodeURIComponent(url.split('/storage/v1/object/public/')[1].split('?')[0]);
      const object = objects.get(key);
      if (!object || !key.startsWith('product-posters/')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': object.type, 'Cache-Control': object.cacheControl || 'no-cache', 'Timing-Allow-Origin': '*' });
      return res.end(object.bytes);
    }
    if (url.startsWith('/storage/v1/object/upload/sign/')) {
      const key = url.split('/storage/v1/object/upload/sign/')[1];
      return send(200, { url: `/object/upload/sign/${key}?token=x` });
    }
    if (url.startsWith('/storage/v1/object/sign/')) {
      log.modelSigns += 1;
      const key = url.split('/storage/v1/object/sign/')[1];
      return send(200, { signedURL: `/object/upload/sign/${key}?token=signed` });
    }
    if (req.method === 'DELETE' && url.startsWith('/storage/v1/object/')) {
      const bucket = url.split('/storage/v1/object/')[1];
      const names = JSON.parse(raw || '{}').prefixes || [];
      for (const name of names) objects.delete(`${bucket}/${name}`);
      return send(200, names.map(name => ({ name })));
    }

    if (url.startsWith('/auth/v1/health')) return send(200, { name: 'GoTrue' });
    if (url.startsWith('/auth/v1/user')) return send(200, { id: 'u1', email: 'owner@furnishar.ph' });
    if (url.includes('grant_type=password')) {
      return send(200, { access_token: 'u1', refresh_token: 'u1-r', user: { id: 'u1', email: 'owner@furnishar.ph' } });
    }
    if (url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, false);
    if (url.startsWith('/rest/v1/rpc/my_role')) { log.revalidations += 1; return send(200, 'owner'); }
    if (url.startsWith('/rest/v1/rpc/record_model_access')) { log.accessRecords += 1; return send(200, true); }
    if (url.startsWith('/rest/v1/store_members')) {
      return send(200, [{ role: 'owner', stores: { id: STORE, slug: 'sc-variety', name: 'S&C Variety Store', plan: 'premium' } }]);
    }
    if (url.startsWith('/rest/v1/stores')) {
      return send(200, [{ slug: 'sc-variety', name: 'S&C Variety Store', address: 'Mamburao', contact_number: '0917', hours: '9-5' }]);
    }
    if (url.startsWith('/rest/v1/catalog')) return send(200, catalogRows());

    if (url.startsWith('/rest/v1/products')) {
      if (req.method === 'POST') {
        const row = { ...JSON.parse(raw || '{}'), id: uuid(), status: 'published', updated_at: new Date().toISOString() };
        products.set(row.id, row);
        return send(201, [row]);
      }
      if (req.method === 'PATCH') {
        const id = /id=eq\.([\w-]+)/.exec(url)?.[1];
        products.set(id, { ...products.get(id), ...JSON.parse(raw || '{}') });
        return send(200, [products.get(id)]);
      }
      // The owner's own list, with their assets embedded.
      return send(200, [...products.values()].map(p => ({
        ...p, product_assets: assets.filter(a => a.product_id === p.id).map(a => ({ kind: a.kind, object_path: a.object_path }))
      })));
    }
    if (url.startsWith('/rest/v1/product_assets')) {
      if (req.method === 'POST') {
        const row = JSON.parse(raw || '{}');
        if (row.kind === 'poster') log.posterLinks += 1;
        const at = assets.findIndex(a => a.product_id === row.product_id && a.kind === row.kind);
        if (at >= 0) assets[at] = row; else assets.push(row);
        return send(201, null);
      }
      const product = /product_id=eq\.([\w-]+)/.exec(url)?.[1];
      const kind = /kind=eq\.(\w+)/.exec(url)?.[1];
      return send(200, assets.filter(a => (!product || a.product_id === product) && (!kind || a.kind === kind))
        .map(a => ({ object_path: a.object_path })));
    }
    send(200, []);
  });
});
await new Promise(resolve => supabase.listen(SB_PORT, resolve));

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'posters-check' },
  stdio: 'ignore', detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/portal`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};
const BASE = `http://127.0.0.1:${APP_PORT}`;

try {
  console.log('--- an owner adds a product with a 3D model ---');
  const owner = await browser.newPage();
  await owner.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
  await owner.waitForSelector('form.login-form', { timeout: 20000 });
  await owner.fill('input[name="email"]', 'owner@furnishar.ph');
  await owner.fill('input[name="password"]', 'x');
  await owner.click('form.login-form button[type="submit"]');
  await owner.waitForSelector('.console', { timeout: 20000 });
  await owner.click('.console-head button:has-text("Add Product")');
  await owner.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
  await owner.fill('input[name="name"]', 'Poster Test Bench');
  await owner.fill('input[name="price"]', '1200');
  await owner.fill('input[name="stock"]', '2');
  // POSTER_FIXTURE=armchair renders a real scanned model instead of a box,
  // to judge the poster's framing and lighting by eye (saved to $SHOTS).
  const armchair = process.env.POSTER_FIXTURE === 'armchair';
  await owner.fill('input[name="width"]', armchair ? '70' : '80');
  await owner.fill('input[name="height"]', armchair ? '88' : '45');
  await owner.fill('input[name="depth"]', armchair ? '78' : '40');
  await owner.setInputFiles('input[name="modelFile"]', armchair
    ? { name: 'armchair.glb', mimeType: 'model/gltf-binary', buffer: readFileSync(new URL('../tests/fixtures/models/armchair.glb', import.meta.url)) }
    : { name: 'bench.glb', mimeType: 'model/gltf-binary', buffer: makeTestGlb(128 * 1024, { size: [0.8, 0.45, 0.4] }) });
  await owner.locator('.scale-checks li[data-state="done"]:has-text("Ready for AR")').waitFor({ timeout: 20000 }).catch(() => {});
  await owner.click('dialog.form-dialog button[type="submit"]');
  await owner.waitForSelector('dialog.form-dialog[open]', { state: 'detached', timeout: 30000 }).catch(() => {});
  await owner.waitForTimeout(800);

  const model = log.uploads.find(u => u.key.startsWith('furniture-models/'));
  const poster = log.uploads.find(u => u.key.startsWith('product-posters/'));
  check('the model went to the private models bucket', Boolean(model), model?.key);
  check('a poster was rendered and uploaded to the public posters bucket', Boolean(poster), poster?.key);
  check('named by its content, so it can be cached for good', /\/poster-[0-9a-f]{16}\.(webp|jpg)$/.test(poster?.key || ''), poster?.key);
  check('a small WebP, not a multi-megabyte PNG', poster?.type === 'image/webp' && poster.size > 500 && poster.size < 200 * 1024,
    `${poster?.type} ${poster ? Math.round(poster.size / 1024) : '?'} KB`);
  check('uploaded with a one-year immutable cache header', /max-age=31536000/.test(poster?.cacheControl || '') && /immutable/.test(poster?.cacheControl || ''),
    poster?.cacheControl);
  check('linked to its product through the server', log.posterLinks === 1, String(log.posterLinks));
  check('the catalogue was asked to refresh', log.revalidations >= 1, String(log.revalidations));
  if (poster) writeFileSync(`${SHOTS}/poster.${poster.type === 'image/webp' ? 'webp' : 'jpg'}`, objects.get(poster.key).bytes);

  const decoded = poster ? await owner.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  }, `http://127.0.0.1:${SB_PORT}/storage/v1/object/public/${poster.key}`).catch(() => null) : null;
  check('the poster is a real 640 × 640 image', decoded?.w === 640 && decoded?.h === 640, JSON.stringify(decoded));

  const inventory = await owner.locator('#inventory').innerText();
  check('the portal says the model is ready', /3D model ready/.test(inventory));
  check('and does not ask to regenerate a preview that exists', !/Catalogue preview needed/.test(inventory));
  check('it says the catalogue preview is ready', /Catalogue preview ready/.test(inventory));

  /* Three more listings, straight into the fake database. */
  const add = (name, extra = []) => {
    const id = uuid();
    products.set(id, { id, slug: name.toLowerCase().replace(/\s+/g, '-'), name, category: 'Table', style: 'Modern', color: 'Natural',
      price_php: 900, stock: 1, width_cm: 60, height_cm: 70, depth_cm: 60, status: 'published', updated_at: new Date().toISOString() });
    for (const kind of extra) {
      assets.push({ product_id: id, kind, object_path: kind === 'glb' ? `${STORE}/${id}/model.glb` : `${STORE}/${id}/poster-deadbeefdeadbeef.webp` });
    }
  };
  add('Plain Side Table');                       // no model, no poster
  add('Unposted Cabinet', ['glb']);              // model, no poster yet
  add('Broken Poster Shelf', ['glb', 'poster']); // poster path whose file is missing
  await fetch(`${BASE}/api/sb/models/revalidate`, { method: 'POST', headers: { Authorization: 'Bearer u1', 'Content-Type': 'application/json' }, body: '{}' });

  console.log('--- a shopper browses the collection ---');
  const shopper = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const modelRequests = [];
  const posterRequests = [];
  shopper.on('request', request => {
    const url = request.url();
    if (/\.glb(\?|$)|\/api\/sb\/model\/|\/object\/sign\//.test(url)) modelRequests.push(url);
    if (url.includes('/product-posters/')) posterRequests.push(url);
  });
  // Measured, not guessed (brief §48): Largest Contentful Paint and layout
  // shift from the browser's own observers, installed before the page runs.
  await shopper.addInitScript(() => {
    window.__perf = { lcp: 0, cls: 0 };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__perf.lcp = entry.startTime;
        const el = entry.element;
        window.__perf.lcpElement = el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` : '?';
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__perf.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const signsBefore = log.modelSigns;
  await shopper.goto(`${BASE}/collection`, { waitUntil: 'networkidle' });
  await shopper.waitForTimeout(800);
  await shopper.screenshot({ path: `${SHOTS}/collection-390.png`, fullPage: true });

  check('no model is downloaded or even requested while browsing', modelRequests.length === 0 && log.modelSigns === signsBefore,
    modelRequests.slice(0, 3).join(', '));

  const perf = await shopper.evaluate(async () => {
    const posters = performance.getEntriesByType('resource').filter(r => r.name.includes('/product-posters/'));
    // Decode cost of a poster from its bytes, not a copy the page already decoded.
    const img = document.querySelector('img.product-thumb');
    let decodeMs = null;
    if (img) {
      const blob = await fetch(img.currentSrc || img.src).then(r => r.blob());
      const t0 = performance.now();
      const bitmap = await createImageBitmap(blob);
      decodeMs = Math.round((performance.now() - t0) * 10) / 10;
      bitmap.close();
    }
    return {
      lcp: Math.round(window.__perf.lcp),
      lcpElement: window.__perf.lcpElement,
      cls: Math.round(window.__perf.cls * 1000) / 1000,
      posterBytes: posters.reduce((sum, r) => sum + (r.encodedBodySize || r.transferSize || 0), 0),
      posterCount: posters.length,
      decodeMs
    };
  });
  console.log(`  (measured: LCP ${perf.lcp} ms on ${perf.lcpElement}, CLS ${perf.cls}, ${perf.posterCount} poster(s) ${Math.round(perf.posterBytes / 1024)} KB, decode ${perf.decodeMs} ms)`);
  check('no layout shift while the posters arrive (CLS < 0.1)', perf.cls < 0.1, String(perf.cls));
  check('browsing costs poster bytes only: under 100 KB per poster',
    perf.posterCount > 0 && perf.posterBytes > 0 && perf.posterBytes / perf.posterCount < 100 * 1024, `${Math.round(perf.posterBytes / 1024)} KB for ${perf.posterCount}`);
  check('a poster decodes quickly (< 50 ms)', perf.decodeMs !== null && perf.decodeMs < 50, `${perf.decodeMs} ms`);
  check('Largest Contentful Paint under 2.5 s on this local server', perf.lcp > 0 && perf.lcp < 2500, `${perf.lcp} ms`);
  check('the card image is the poster', posterRequests.some(url => url.includes('/poster-')), posterRequests[0]);
  const card = name => shopper.locator(`.product-card:has-text("${name}")`);
  check('the modelled piece shows its poster and a 3D badge',
    await card('Poster Test Bench').locator('img.product-thumb').count() === 1
    && await card('Poster Test Bench').locator('.model-badge').count() === 1);
  const cls = await card('Poster Test Bench').locator('img.product-thumb').evaluate(img => ({
    loading: img.loading, decoding: img.decoding, w: img.getAttribute('width'), h: img.getAttribute('height'),
    complete: img.complete && img.naturalWidth > 0
  }));
  check('with its size declared and async decoding, so nothing jumps', cls.w === '640' && cls.h === '640' && cls.decoding === 'async', JSON.stringify(cls));
  check('and it actually loaded', cls.complete);

  const plain = await card('Plain Side Table').innerText();
  check('no model: "No 3D model yet", and no 3D badge',
    /No 3D model yet/i.test(plain) && await card('Plain Side Table').locator('.model-badge').count() === 0);
  check('and no "View in my space" on a piece that has no model',
    !/View in my space/i.test(plain) && /Not available in AR/i.test(plain));
  const unposted = await card('Unposted Cabinet').innerText();
  check('model but no poster: "3D model available", not "no model"', /3D model available/i.test(unposted) && !/No 3D model/i.test(unposted));
  await card('Broken Poster Shelf').locator('.product-thumb-empty').waitFor({ timeout: 5000 }).catch(() => {});
  const broken = await card('Broken Poster Shelf').innerText();
  check('a poster that fails says "Preview unavailable", not "no model"', /Preview unavailable/i.test(broken) && !/No 3D model/i.test(broken), broken.slice(0, 80));
  check('and leaves no broken-image icon behind', await card('Broken Poster Shelf').locator('img').count() === 0);

  console.log('--- the owner sees what needs a preview ---');
  await owner.reload({ waitUntil: 'domcontentloaded' });
  await owner.waitForSelector('#inventory', { timeout: 20000 });
  await owner.waitForTimeout(800);
  const needs = await owner.locator('.console-overview').innerText();
  check('"Needs attention" counts listings without a catalogue preview', /without a catalogue preview/i.test(needs));
  check('with a Regenerate preview action on the listing',
    await owner.locator('tr:has-text("Unposted Cabinet") button:has-text("Regenerate preview")').count() === 1);

  console.log('--- an empty database is an empty collection ---');
  catalogEmpty = true;
  await fetch(`${BASE}/api/sb/models/revalidate`, { method: 'POST', headers: { Authorization: 'Bearer u1', 'Content-Type': 'application/json' }, body: '{}' });
  const errors = [];
  const empty = await browser.newPage({ viewport: { width: 390, height: 844 } });
  empty.on('pageerror', error => errors.push(error.message));
  await empty.goto(`${BASE}/collection`, { waitUntil: 'networkidle' });
  await empty.screenshot({ path: `${SHOTS}/collection-empty-390.png`, fullPage: true });
  const text = await empty.locator('main').innerText();
  check('it says nothing has been listed yet', /No furniture has been listed yet/.test(text) && /approved stores will appear here/.test(text));
  check('no "0 pieces", no sort, no filters', !/0 pieces/.test(text) && await empty.locator('.filters, .sort-control, .result-count').count() === 0);
  check('no marquee frame and no product cards', await empty.locator('.marquee-section, .product-card').count() === 0);
  check('no demo furniture comes back', !/Cane Back/i.test(text));
  check('no product-page links', await empty.locator('a[href^="/furniture/"]').count() === 0);
  await empty.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  check('the home page renders with an empty catalogue', await empty.locator('h1').count() >= 1
    && await empty.locator('a[href^="/furniture/"]').count() === 0);
  check('without page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  stop();
  supabase.close();
}

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nposters come from the model, cards never load a model, and an empty catalogue is empty');
process.exit(problems.length ? 1 : 0);
