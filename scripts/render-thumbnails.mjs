/**
 * Renders each product's catalogue thumbnail FROM THAT PRODUCT'S OWN .glb.
 *
 * WHY A SCRIPT AND NOT A VIEWER IN EVERY CARD
 * A grid of live WebGL viewers is the honest-looking answer and the wrong one:
 * a dozen renderers on a phone is a dozen contexts, a dozen copies of the
 * decoder, and a scroll that stutters. A thumbnail rendered from the real
 * model is the same truth at a thousandth of the cost — it IS the model, just
 * photographed once instead of continuously. The detail page gets the live
 * viewer, where there is one product and the interaction is the point.
 *
 * WHAT THIS MUST NEVER DO
 * Invent a picture. If a product has no model, it gets no thumbnail and the
 * card says so. There is no stock photography, no "close enough" render of a
 * similar chair, and no reuse of another product's image. A shopper looking at
 * a card is looking at the thing they will be sent.
 *
 *   node scripts/render-thumbnails.mjs          # only models that changed
 *   node scripts/render-thumbnails.mjs --force  # all of them
 *
 * Output: public/thumbs/<id>.webp, plus data/thumbnails.json mapping product
 * id -> { file, source, hash } so the build can tell a stale thumbnail from a
 * current one.
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC, 'thumbs');
const MANIFEST = path.join(ROOT, 'data', 'thumbnails.json');
const FORCE = process.argv.includes('--force');

/** The square the model is photographed in. Cards crop from this. */
const SIZE = 900;

/* ----------------------------------------------------------- the page --- */
/*
   Same renderer settings as the product viewer, so the still and the live
   model are lit identically — a thumbnail that does not match the thing it
   opens is its own small lie.
*/
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}canvas{display:block}</style>
<script type="importmap">
{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}
</script></head><body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const SIZE = ${SIZE};
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

// A neutral studio: one key, one fill, one soft ambient. No environment map,
// no coloured rim — the point is to show the product's own material, not to
// style it.
scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c5bb, 2.0));
const key = new THREE.DirectionalLight(0xfff6ec, 2.2); key.position.set(3, 5, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0xeaf0ff, 0.7); fill.position.set(-4, 2, -3); scene.add(fill);

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));

window.__render = src => new Promise((resolve) => {
  loader.load(src, gltf => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;

    // Normalised and centred, so every product in the grid is framed at the
    // same scale regardless of the units its author exported in. Consistent
    // framing is what makes a catalogue readable.
    model.scale.setScalar(1 / longest);
    model.position.copy(centre).multiplyScalar(-1 / longest);

    const pivot = new THREE.Group();
    pivot.add(model);
    // Three-quarter view: the standard furniture catalogue angle, because it
    // shows a front, a side and the seat in one image.
    pivot.rotation.y = -0.6;
    scene.add(pivot);

    // Frame it by the projected height so tall and wide pieces both fill the
    // square without being cropped.
    const fov = camera.fov * Math.PI / 180;
    camera.position.set(0, 0.16, (1.05 / 2) / Math.tan(fov / 2) * 1.35);
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    resolve({ ok: true, triangles: renderer.info.render.triangles,
              dims: { x: size.x, y: size.y, z: size.z } });
    scene.remove(pivot);
  }, undefined, error => resolve({ ok: false, error: String(error?.message || error) }));
});
window.__ready = true;
</script></body></html>`;

/* ------------------------------------------------------------ helpers --- */

/** Serves /public plus three.js, so the page can import the same modules the app does. */
function serve(port) {
  const types = {
    '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
    '.html': 'text/html', '.json': 'application/json'
  };
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(PAGE);
    }
    /* Product models live in data/models, not /public: a model in /public
       is a download for anyone on the live site. This local server is the
       renderer's own, so it may read them. */
    const base = url.startsWith('/three/')
      ? path.join(ROOT, 'node_modules')
      : url.startsWith('/models/') && url.endsWith('.glb')
        ? path.join(ROOT, 'data')
        : PUBLIC;
    const file = path.join(base, url.replace(/^\/three\//, 'three/'));
    if (!file.startsWith(base) || !existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

/** Local path for a model the catalogue addresses as "/models/x.glb". */
function localModelPath(modelGlb) {
  if (!modelGlb || /^https?:/.test(modelGlb)) return null;
  const relative = modelGlb.replace(/^\//, '');
  // Bundled product models moved out of /public to data/models.
  const file = /^models\/[\w-]+\.glb$/.test(relative)
    ? path.join(ROOT, 'data', relative)
    : path.join(PUBLIC, relative);
  return existsSync(file) ? file : null;
}

const hashOf = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

/* --------------------------------------------------------------- main --- */

const catalog = JSON.parse(await readFile(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
await mkdir(OUT_DIR, { recursive: true });

let manifest = {};
try { manifest = JSON.parse(await readFile(MANIFEST, 'utf8')); } catch { manifest = {}; }

const jobs = [];
const skipped = [];
for (const product of catalog) {
  const id = product.id || product.slug;
  if (!id) continue;
  if (!product.modelGlb) {
    // Deliberate: no model means no picture. The card renders its own empty
    // state rather than borrowing an image from anywhere.
    skipped.push({ id, why: 'no model uploaded' });
    delete manifest[id];
    continue;
  }
  const file = localModelPath(product.modelGlb);
  if (!file) {
    skipped.push({ id, why: `model not on disk (${product.modelGlb})` });
    continue;
  }
  const hash = hashOf(file);
  const out = path.join(OUT_DIR, `${id}.webp`);
  if (!FORCE && manifest[id]?.hash === hash && existsSync(out)) {
    skipped.push({ id, why: 'unchanged' });
    continue;
  }
  jobs.push({ id, product, file, hash, out, src: product.modelGlb });
}

console.log(`${catalog.length} product(s): ${jobs.length} to render, ${skipped.length} skipped`);
for (const s of skipped) console.log(`  -  ${s.id}: ${s.why}`);

if (!jobs.length) {
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('nothing to do');
  process.exit(0);
}

const PORT = 4931;
const server = await serve(PORT);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({
  viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1
})).newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForFunction(() => window.__ready, { timeout: 60000 });

let failures = 0;
for (const job of jobs) {
  const result = await page.evaluate(src => window.__render(src), job.src);
  if (!result.ok) {
    // A model that will not load must not quietly become a missing thumbnail
    // that looks like "no model uploaded" — those are different problems and
    // the shop owner needs to be able to tell them apart.
    console.log(`  FAIL ${job.id}: ${result.error}`);
    failures += 1;
    continue;
  }
  const raw = path.join(OUT_DIR, `${job.id}.png`);
  await page.locator('canvas').screenshot({ path: raw, omitBackground: true });
  await run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-c:v', 'libwebp',
    '-quality', '86', '-compression_level', '6', job.out]);
  await run('rm', ['-f', raw]);

  manifest[job.id] = {
    file: `/thumbs/${job.id}.webp`,
    source: job.src,
    hash: job.hash,
    triangles: result.triangles,
    renderedAt: new Date().toISOString()
  };
  console.log(`  ok   ${job.id} <- ${job.src} (${result.triangles} triangles)`);
}

await browser.close();
server.close();

// Drop thumbnails for products that no longer exist, so the folder cannot
// accumulate images of deleted listings.
const live = new Set(catalog.map(p => p.id || p.slug).filter(Boolean));
for (const id of Object.keys(manifest)) if (!live.has(id)) delete manifest[id];
for (const file of await readdir(OUT_DIR)) {
  const id = file.replace(/\.webp$/, '');
  if (file.endsWith('.webp') && !manifest[id]) await run('rm', ['-f', path.join(OUT_DIR, file)]);
}

await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(failures ? `\n${failures} model(s) failed to render` : '\nall thumbnails rendered from their own models');
process.exit(failures ? 1 : 0);
