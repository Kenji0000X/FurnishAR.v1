/**
 * Does the browser actually see upload progress, not just "0%" then "100%"?
 *
 * public/supabase.js switched the model upload from `fetch` to XMLHttpRequest
 * specifically so a 100 MB file on a slow connection shows a moving number
 * instead of a status line that looks frozen for several minutes. That claim
 * is only true if a real browser reports real intermediate progress, which
 * depends on genuine TCP backpressure — a mocked response or a route
 * interception would make this pass for the wrong reason. So this stands up
 * a real Node HTTP server and deliberately reads the incoming PUT slowly,
 * which is what makes the browser's own network stack report progress as it
 * actually happens rather than handing the whole body to the socket layer in
 * one shot over loopback.
 *
 *   node scripts/check-upload-progress.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SB_PORT = 4801;
const APP_PORT = 4802;
const KEY = 'sb_publishable_progresscheck0';
const CHUNK_DELAY_MS = 8;
const FILE_MB = 24;
const STORE_ID = '21f61742-6d5d-4239-9592-05b2a79a0453';
const PRODUCT_ID = '5a6a9821-98f1-4b14-bec9-ddd8272d6819';

let receivedBytes = 0;

const supabase = createServer((req, res) => {
  // The real Storage API answers cross-origin requests; this mock must too,
  // or the browser's own CORS preflight blocks the PUT before it starts.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-upsert, authorization, apikey');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'PUT' && req.url.includes('/upload/sign/')) {
    // Read in small, deliberately slow steps so the kernel's receive buffer
    // actually fills and backpressures the sender.
    (async () => {
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
      }
      receivedBytes = bytes;
      res.writeHead(200);
      res.end('{}');
    })();
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
      return send(200, [{ role: 'owner', stores: { id: STORE_ID, slug: 'sc-variety', name: 'S&C Variety Store', plan: 'freemium' } }]);
    }
    if (req.url.startsWith('/rest/v1/products')) {
      if (req.method === 'POST') return send(201, [{ id: PRODUCT_ID, store_id: STORE_ID }]);
      return send(200, []);
    }
    if (req.url.startsWith('/storage/v1/object/upload/sign')) {
      // Supabase's real endpoint returns a relative /object/... path; the
      // proxy (lib/supabase-proxy.js) prefixes storage/v1 itself.
      return send(200, { url: `/object/upload/sign/furniture-models/${STORE_ID}/${PRODUCT_ID}/model.glb?token=x` });
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

// Detached: `next start` is a launcher, and killing it would leave the real
// next-server child holding the port for the next run.
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'upload-progress-check' },
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

await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('form.login-form', { timeout: 20000 });
await page.fill('input[name="email"]', 'owner@furnishar.ph');
await page.fill('input[name="password"]', 'x');
await page.click('form.login-form button[type="submit"]');
await page.waitForSelector('.dashboard', { timeout: 20000 }).catch(() => {});

await page.click('button:has-text("+ Add product")');
await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
await page.fill('input[name="name"]', 'Progress Test Bench');
await page.fill('input[name="price"]', '999');
await page.fill('input[name="stock"]', '1');
await page.fill('input[name="width"]', '80');
await page.fill('input[name="height"]', '45');
await page.fill('input[name="depth"]', '40');
await page.setInputFiles('input[name="modelFile"]', {
  name: 'model.glb',
  mimeType: 'model/gltf-binary',
  buffer: Buffer.alloc(FILE_MB * 1024 * 1024, 1)
});

const percentagesSeen = new Set();
const poll = setInterval(async () => {
  const text = await page.locator('dialog.form-dialog button[type="submit"]').innerText().catch(() => '');
  const match = text.match(/(\d+)%/);
  if (match) percentagesSeen.add(Number(match[1]));
}, 40);

await page.click('dialog.form-dialog button[type="submit"]');
await page.waitForSelector('dialog.form-dialog[open]', { state: 'detached', timeout: 30000 }).catch(() => {});
clearInterval(poll);

const values = [...percentagesSeen].sort((a, b) => a - b);
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

check('the button showed more than just 0% and 100%',
  values.some(v => v > 0 && v < 100), `values seen: ${values.join(', ')}`);
check('the full file arrived at the upload endpoint intact',
  receivedBytes === FILE_MB * 1024 * 1024, `${receivedBytes} of ${FILE_MB * 1024 * 1024} bytes`);

await browser.close();
stop();
supabase.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nupload progress reports real, moving numbers');
process.exit(problems.length ? 1 : 0);
