const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const SECRET = process.env.FURNISHAR_JWT_SECRET || 'replace-this-demo-secret-before-deployment';
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'client.js']);
const STORES = {
  'sc-variety': { name: 'S&C Variety Store', email: 'owner@furnishar.ph', password: 'furnishar' },
  tiampion: { name: 'Tiampion Buildings', email: 'tiampion@furnishar.ph', password: 'furnishar' },
  sanros: { name: 'Sanros General Merchandise', email: 'sanros@furnishar.ph', password: 'furnishar' }
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('Invalid JSON body.'); }
}

function sign(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verify(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

async function catalog() { return JSON.parse(await fsp.readFile(CATALOG_PATH, 'utf8')); }
async function save(products) {
  // Vercel function files are read-only. A real production deployment must use
  // a database/KV store for catalog writes instead of trying to edit this file.
  if (process.env.VERCEL) {
    const error = new Error('Inventory changes need persistent database storage. Configure a database or deploy the API to a stateful host before enabling catalog edits.');
    error.code = 'PERSISTENT_STORAGE_REQUIRED';
    throw error;
  }
  await fsp.writeFile(CATALOG_PATH, `${JSON.stringify(products, null, 2)}\n`);
}

function safeProduct(input, owner, existing = {}) {
  const dimensions = input.dimensions || {};
  const result = {
    ...existing,
    name: String(input.name || existing.name || '').trim().slice(0, 90),
    storeId: owner.storeId,
    store: STORES[owner.storeId].name,
    category: String(input.category || existing.category || 'Storage').trim().slice(0, 40),
    style: String(input.style || existing.style || 'Modern').trim().slice(0, 40),
    color: String(input.color || existing.color || 'Natural').trim().slice(0, 40),
    price: Number(input.price),
    stock: Number(input.stock),
    dimensions: { width: Number(dimensions.width), height: Number(dimensions.height), depth: Number(dimensions.depth) },
    model: String(input.model || existing.model || 'shelf').trim().slice(0, 30),
    description: String(input.description || existing.description || '').trim().slice(0, 400),
    arReady: true
  };
  if (!result.name || !Number.isFinite(result.price) || result.price < 0 || !Number.isInteger(result.stock) || result.stock < 0 || Object.values(result.dimensions).some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Enter a name, a valid price, non-negative stock, and positive dimensions.');
  return result;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'GET' && url.pathname === '/api/products') return send(res, 200, { products: await catalog() });
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const { email, password } = await body(req);
    const pair = Object.entries(STORES).find(([, store]) => store.email === String(email).toLowerCase() && store.password === password);
    if (!pair) return send(res, 401, { error: 'Incorrect email or password.' });
    const [storeId, store] = pair;
    const user = { storeId, store: store.name, role: 'owner', exp: Date.now() + 8 * 60 * 60 * 1000 };
    return send(res, 200, { token: sign(user), user: { storeId, store: store.name, role: 'owner' } });
  }
  const owner = verify(req);
  if (!owner) return send(res, 401, { error: 'Sign in as a store owner to manage inventory.' });
  const products = await catalog();
  if (req.method === 'POST' && url.pathname === '/api/products') {
    const next = safeProduct(await body(req), owner);
    next.id = `${next.category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
    products.push(next); await save(products); return send(res, 201, { product: next });
  }
  const match = url.pathname.match(/^\/api\/products\/([a-z0-9-]+)$/i);
  if (!match) return send(res, 404, { error: 'API route not found.' });
  const index = products.findIndex(product => product.id === match[1]);
  if (index < 0) return send(res, 404, { error: 'Product not found.' });
  if (products[index].storeId !== owner.storeId) return send(res, 403, { error: 'You can only manage your own store inventory.' });
  if (req.method === 'PUT') {
    products[index] = safeProduct(await body(req), owner, products[index]); await save(products); return send(res, 200, { product: products[index] });
  }
  if (req.method === 'DELETE') { const [removed] = products.splice(index, 1); await save(products); return send(res, 200, { product: removed }); }
  return send(res, 405, { error: 'Method not allowed.' });
}

async function requestHandler(req, res) {
  try {
    // Safely construct URL with fallback for missing host header (common in Vercel serverless)
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    
    const forwardedApiPath = url.searchParams.get('__furnishar_path');
    if (forwardedApiPath !== null) url.pathname = `/api/${forwardedApiPath.replace(/^\/+/, '')}`;
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!PUBLIC_FILES.has(relative)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const file = path.resolve(ROOT, 'public', relative);  // Changed: look in public/ subdirectory
    if (!(file.startsWith(`${ROOT}${path.sep}public`) && file.startsWith(`${path.resolve(ROOT, 'public')}${path.sep}`)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (error.code !== 'PERSISTENT_STORAGE_REQUIRED') console.error(error);
    send(res, error.code === 'PERSISTENT_STORAGE_REQUIRED' ? 503 : 500, { error: error.message || 'Server error.' });
  }
}

module.exports = requestHandler;
