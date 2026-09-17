/**
 * When a model will not show in AR, does the app say why?
 *
 * Every failure used to end at one sentence — "3D preview unavailable on this
 * device" — for causes that have nothing to do with the device: a piece with
 * no model uploaded, a file the server refuses to serve, a protection page
 * standing in for the file, a corrupt .glb. That message sends a shop owner to
 * blame the phone, which was the one part working.
 *
 * Each case is a SEPARATE product with its own model path, all in one
 * catalogue response. An earlier version of this flipped server state between
 * runs and was fooled by /plan's own ISR cache (revalidate = 60) serving the
 * previous scenario's data — so the scenarios are data now, not state.
 *
 *   node scripts/check-ar-model.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SB_PORT = 4941;
const APP_PORT = 4942;
const KEY = 'sb_publishable_armodelcheck0';
const STORE = '21f61742-6d5d-4239-9592-05b2a79a0453';
const GLB = readFileSync(new URL('../public/models/cane-back-armchair.glb', import.meta.url));

/** One product per failure mode; the path's middle segment picks the behaviour. */
const CASES = [
  { id: 'aaaaaaa1-0000-4000-8000-000000000001', slug: 'good-chair', name: 'Good Chair', behaviour: 'ok' },
  { id: 'aaaaaaa2-0000-4000-8000-000000000002', slug: 'no-model-chair', name: 'No Model Chair', behaviour: null },
  { id: 'aaaaaaa3-0000-4000-8000-000000000003', slug: 'server-error-chair', name: 'Server Error Chair', behaviour: 'fail500' },
  { id: 'aaaaaaa4-0000-4000-8000-000000000004', slug: 'protected-chair', name: 'Protected Chair', behaviour: 'html' },
  { id: 'aaaaaaa5-0000-4000-8000-000000000005', slug: 'corrupt-chair', name: 'Corrupt Chair', behaviour: 'corrupt' }
];

const catalogRow = ({ id, slug, name, behaviour }) => ({
  id, slug, name,
  store_id: STORE, store_slug: 'sc-variety', store_name: 'S&C Variety Store',
  category: 'Chair', style: 'Modern', color: 'Natural',
  price_php: 5400, stock: 3,
  width_cm: 70, height_cm: 88, depth_cm: 78,
  bounds_width_cm: 70, bounds_height_cm: 88, bounds_depth_cm: 78,
  preview_shape: 'chair', description: 'Test piece', ar_ready: true, featured: false,
  status: 'published', updated_at: new Date().toISOString(),
  model_glb_path: behaviour ? `${STORE}/${behaviour}/model.glb` : null,
  model_usdz_path: null
});

const supabase = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url.startsWith('/storage/v1/object/public/furniture-models/')) {
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (req.url.includes('/fail500/')) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify({ error: 'Internal Error' }));
      }
      if (req.url.includes('/html/')) {
        // A protection interstitial standing in for the file: 200, but HTML.
        res.writeHead(200, { 'Content-Type': 'text/html', ...cors });
        return res.end('<html><body>Authentication Required</body></html>');
      }
      if (req.url.includes('/corrupt/')) {
        const broken = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(64, 7)]);
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', ...cors });
        return res.end(broken);
      }
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': GLB.length, ...cors });
      return res.end(GLB);
    }

    if (req.url.startsWith('/auth/v1/health')) return send(200, { name: 'GoTrue' });
    if (req.url.startsWith('/rest/v1/catalog')) return send(200, CASES.map(catalogRow));
    send(200, []);
  });
});
await new Promise(resolve => supabase.listen(SB_PORT, resolve));

if (await fetch(`http://127.0.0.1:${APP_PORT}/plan`).then(() => true).catch(() => false)) {
  console.error(`Something is already listening on ${APP_PORT}. Stop it first.`);
  process.exit(1);
}

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: KEY, FURNISHAR_JWT_SECRET: 'ar-model-check' },
  stdio: 'ignore',
  detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/plan`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

// /plan is prerendered at build time (revalidate = 60), and the build had no
// Supabase to read, so the first responses carry the BUNDLED catalogue — the
// one armchair, whose model loads fine from /models/. Asserting against that
// silently tests the wrong products: an earlier version of this check passed
// and failed at random depending on whether ISR had regenerated yet. So wait
// for the page to actually be serving this mock's catalogue, and say so
// rather than guessing at a timeout.
let fresh = false;
for (let i = 0; i < 40 && !fresh; i++) {
  const html = await fetch(`http://127.0.0.1:${APP_PORT}/plan`, { cache: 'no-store' })
    .then(r => r.text()).catch(() => '');
  fresh = html.includes('Corrupt Chair');
  if (!fresh) await new Promise(r => setTimeout(r, 2000));
}
if (!fresh) {
  console.error('FAILED: /plan never served the test catalogue — ISR did not regenerate in time.');
  stop();
  supabase.close();
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

/** Opens one product straight into AR and returns what the stage says. */
async function launchAR(productId) {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${APP_PORT}/plan?product=${productId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.click('#ar-button').catch(() => {});
  await page.waitForTimeout(6000);
  const fallback = await page.locator('.fallback-message').innerText().catch(() => '');
  await context.close();
  return fallback.trim();
}

const byId = slug => CASES.find(c => c.slug === slug).id;

console.log('--- the model loads normally ---');
{
  const message = await launchAR(byId('good-chair'));
  check('no failure message when the model is fine', !message, message.slice(0, 90));
}

console.log('--- the piece has no model uploaded ---');
{
  const message = await launchAR(byId('no-model-chair'));
  check('says the model is missing', /no 3D model uploaded/i.test(message), message.slice(0, 95));
  check('does not blame the device', message && !/unavailable on this device/i.test(message));
}

console.log('--- the model URL returns 500 ---');
{
  const message = await launchAR(byId('server-error-chair'));
  check('names the HTTP status instead of guessing',
    /could not be downloaded \(HTTP 500\)/i.test(message), message.slice(0, 95));
  check('does not blame the device', message && !/unavailable on this device/i.test(message));
}

console.log('--- a protection page stands in for the file ---');
{
  const message = await launchAR(byId('protected-chair'));
  check('recognises a web page served in place of a model',
    /web page instead of a file|protection/i.test(message), message.slice(0, 110));
}

console.log('--- the file is not a readable .glb ---');
{
  const message = await launchAR(byId('corrupt-chair'));
  check('says the file is corrupt and can be re-uploaded',
    /corrupt or incomplete/i.test(message), message.slice(0, 95));
}

await browser.close();
stop();
supabase.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nevery AR model failure names its real cause');
process.exit(problems.length ? 1 : 0);
