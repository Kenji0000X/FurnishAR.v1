/**
 * Renders every workspace and shopper route with realistic, awkward data and
 * saves screenshots — the evidence for a UI review, not a replacement for one.
 *
 * Stands up a fake Supabase (an owner with a long-named store, 7 products
 * incl. zero stock and a ₱1,250,000 piece, 11 orders in every state; an admin
 * with pending applications, long notes and emails; a buyer with orders that
 * need payment) and a production build pointed at it.
 *
 *   npm run build && node scripts/shoot-ui.mjs [outDir] [widths]
 *   e.g. node scripts/shoot-ui.mjs /tmp/shots 320,390,768,1280
 *
 * Also prints, per screen: horizontal overflow, and on workspace routes
 * whether the public bottom bar is present (it must not be).
 */
import { createServer } from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/furnishar-shots';
const WIDTHS = (process.argv[3] || '360,390,414,768,1280').split(',').map(Number);
const THEME = process.env.THEME || 'light';
const APP_PORT = 4491;
const SB_PORT = 4492;
const APP = `http://127.0.0.1:${APP_PORT}`;
mkdirSync(OUT, { recursive: true });

const STORE = '2b1c4e4e-0000-4000-8000-00000000000a';
const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
const day = 864e5;

const productRow = (i, over = {}) => ({
  id: `6f1c4e4e-0000-4000-8000-0000000000${String(10 + i)}`, slug: `piece-${i}`, store_id: STORE,
  name: ['Narra Three-Seat Sofa with Hand-Woven Rattan Back', 'Oak Dining Table', 'Molave Bookshelf', 'Rattan Lounge Chair',
         'Acacia Coffee Table', 'Bamboo Side Table', 'Mahogany King Bed Frame with Storage Drawers'][i],
  category: ['Sofa', 'Table', 'Storage', 'Chair', 'Table', 'Table', 'Bed'][i], style: 'Modern', color: 'Natural',
  price_php: String([48500, 22000, 15800, 9800, 12500, 3500, 1250000][i]), stock: [4, 0, 12, 2, 7, 0, 1][i],
  width_cm: '210.0', height_cm: '88.0', depth_cm: '92.0', preview_shape: 'sofa', description: 'Test piece.',
  ar_ready: true, featured: i === 0, status: i === 3 ? 'draft' : 'published', updated_at: iso(i * day),
  product_assets: i % 3 === 1 ? [] : [{ kind: 'glb', object_path: `${STORE}/p${i}/model.glb` }], ...over
});
const PRODUCTS = Array.from({ length: 7 }, (_, i) => productRow(i));
const CATALOG = PRODUCTS.filter(p => p.status === 'published').map(p => ({
  ...p, store_slug: 'sanjose-heritage', store_name: 'San Jose Heritage Furniture & Home Décor Trading',
  store_address: 'Rizal St., Brgy. Poblacion, Mamburao', store_contact_number: '0917 555 0101', store_hours: '8:00–18:00',
  bounds_width_cm: '210.0', bounds_height_cm: '88.0', bounds_depth_cm: '92.0', model_glb_path: null, model_usdz_path: null,
  store_fulfilment: 'stocked', store_payments_ready: true
}));

const order = (i, status, extra = {}) => ({
  id: `0000000${i}-aaaa-4aaa-8aaa-aaaaaaaaaaa${i % 10}`, reference: `F${(7340 + i * 17).toString(36).toUpperCase()}Q${i}`,
  kind: extra.kind || 'stock', status, store_id: STORE, product_id: PRODUCTS[i % 7].id, product_name: PRODUCTS[i % 7].name,
  quantity: 1 + (i % 3), unit_price: 48500, subtotal: 48500 * (1 + (i % 3)), fee_rate: 0.1, platform_fee: 4850 * (1 + (i % 3)),
  total: 53350 * (1 + (i % 3)), deposit_amount: 26675, amount_paid: ['paid', 'fulfilled'].includes(status) ? 53350 : 0,
  currency: 'PHP', created_at: iso(i * 3600e3), hold_expires_at: iso(-1800e3), buyer_name: 'Maria Isabel Santos-Villanueva',
  buyer_email: 'maria.isabel.santos.villanueva@gmail.com', fulfilment_method: i % 2 ? 'pickup' : 'delivery',
  delivery_address: 'Purok 3, Brgy. Talabaan, beside the blue sari-sari store', delivery_municipality: 'Mamburao',
  delivery_phone: '0917 123 4567', estimated_arrival: new Date(now + 3 * day).toISOString().slice(0, 10),
  delivery_status: status === 'paid' ? 'preparing' : null, request: extra.kind === 'custom' ? { notes: 'Narra, 6 seats, oil finish', width_cm: 180 } : null,
  stores: { name: 'San Jose Heritage Furniture & Home Décor Trading', slug: 'x', address: 'Mamburao', contact_number: '0917' },
  ...extra
});
const ORDERS = [
  order(1, 'paid'), order(2, 'requested', { kind: 'custom' }), order(3, 'pending_payment'), order(4, 'quoted', { kind: 'custom' }),
  order(5, 'deposit_paid', { kind: 'custom' }), order(6, 'balance_due', { kind: 'custom' }), order(7, 'paid'),
  order(8, 'fulfilled'), order(9, 'cancelled'), order(10, 'expired'), order(11, 'fulfilled')
];

const APPLICATIONS = [
  { id: 'a1', store_name: 'Calintaan Rattan & Bamboo Craft Cooperative Furniture Showroom', contact_email: 'calintaan.rattan.bamboo.coop@gmail.com',
    contact_phone: '0917 888 1234', message: 'We make hand-woven rattan chairs, lounge sets and bamboo dividers. Around 60 pieces, most made to order; we can deliver anywhere in Occidental Mindoro within a week.',
    status: 'pending', created_at: iso(2 * 3600e3) },
  { id: 'a2', store_name: 'Looc Woodworks', contact_email: 'loocwoodworks@yahoo.com', contact_phone: '0928 222 3344', message: null, status: 'pending', created_at: iso(day) },
  { id: 'a3', store_name: 'Sablayan Home Center', contact_email: 'owner@sablayanhome.ph', contact_phone: null, message: 'Appliances and furniture.', status: 'pending', created_at: iso(3 * day) },
  { id: 'a4', store_name: 'Old Shop', contact_email: 'old@shop.ph', status: 'approved', created_at: iso(9 * day), reviewed_at: iso(8 * day) }
];
const STORES = Array.from({ length: 9 }, (_, i) => ({
  id: i ? `s${i}` : STORE, slug: `store-${i}`, name: i ? `Store ${i} ${i === 2 ? 'with an unusually long trading name for testing wrapping' : ''}`.trim() : 'San Jose Heritage Furniture & Home Décor Trading',
  plan: i % 3 ? 'freemium' : 'premium', status: i === 4 ? 'suspended' : 'active', created_at: iso(i * 5 * day)
}));

const role = auth => (/tok-owner/.test(auth || '') ? 'owner' : /tok-admin/.test(auth || '') ? 'admin'
  : /tok-buyer/.test(auth || '') ? 'buyer' : 'guest');

const supabase = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const send = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    const u = req.url;
    const who = role(req.headers.authorization);
    if (u.startsWith('/auth/v1/health')) return send(200, {});
    if (u.startsWith('/auth/v1/user')) return who === 'guest' ? send(401, {}) : send(200, { id: `${who}-1`, email: `${who}@gmail.com` });
    if (u.startsWith('/rest/v1/rpc/my_role')) return send(200, who);
    if (u.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, who === 'admin');
    if (u.startsWith('/rest/v1/catalog')) return send(200, CATALOG);
    if (u.startsWith('/rest/v1/municipalities')) return send(200, ['Abra de Ilog', 'Mamburao', 'Sablayan', 'San Jose'].map(name => ({ name })));
    if (u.startsWith('/rest/v1/buyers')) return send(200, who === 'buyer' ? [{ full_name: 'Maria Isabel Santos-Villanueva', municipality: 'Mamburao', created_at: iso(30 * day) }] : []);
    if (u.startsWith('/rest/v1/store_members')) {
      return send(200, who === 'owner' ? [{ role: 'owner', stores: { id: STORE, slug: 'sanjose', name: STORES[0].name, plan: 'freemium' } }] : []);
    }
    if (u.startsWith('/rest/v1/products')) {
      if (who === 'admin') return send(200, PRODUCTS.filter(p => !p.product_assets.length).map(p => ({ ...p, store: { name: STORES[0].name, slug: 'x' } })));
      return send(200, PRODUCTS);
    }
    if (u.startsWith('/rest/v1/orders')) return send(200, who === 'guest' ? [] : ORDERS);
    if (u.startsWith('/rest/v1/store_payout')) return send(200, [{ paypal_email: null, notify_email: 'orders@sanjoseheritage.ph', delivery_days: 3, pickup_days: 1 }]);
    if (u.startsWith('/rest/v1/store_payment_accounts')) return send(200, process.env.PAYPAL_CONNECTED ? [{ environment: 'sandbox', merchant_id: 'SANJOSE7KQ2X', onboarding_status: 'CONNECTED', last_checked_at: iso(3600e3), status_detail: 'Linked by Merchant ID and accepted by PayPal as a payee.' }] : []);
    if (u.startsWith('/rest/v1/stores')) return send(200, u.includes('select=fulfilment') ? [{ fulfilment: 'stocked' }] : STORES);
    if (u.startsWith('/rest/v1/rpc/store_fee_summary')) return send(200, { accrued: 14550, collected: 0, settled: 4850, outstanding: 9700 });
    if (u.startsWith('/rest/v1/store_applications')) return send(200, who === 'admin' ? APPLICATIONS : []);
    if (u.startsWith('/rest/v1/rpc/applicant_account')) return send(200, { found: true, confirmed: true, confirmed_at: iso(2 * day), last_sign_in_at: iso(3600e3), disabled: false });
    if (u.startsWith('/rest/v1/admin_audit')) {
      return send(200, who === 'admin' ? Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, actor_email: 'adminfurnishar@gmail.com',
        action: ['application.approved', 'application.rejected', 'fees.settled'][i % 3], subject: 'a1', detail: { store_name: APPLICATIONS[i % 3].store_name, amount: 4850 }, at: iso(i * 7200e3) })) : []);
    }
    if (u.startsWith('/rest/v1/product_assets')) {
      return send(200, who === 'admin' ? PRODUCTS.filter(p => p.product_assets.length).map((p, i) => ({ id: `as${i}`, kind: 'glb', object_path: `${STORE}/${p.id}/narra-three-seat-sofa-final-v7-compressed.glb`, byte_size: (i + 1) * 7.3e6, created_at: iso(i * day), product: { id: p.id, name: p.name, slug: p.slug, status: p.status, store: { name: STORES[0].name, slug: 'x' } } })) : []);
    }
    if (u.startsWith('/rest/v1/rpc/admin_model_lifecycle')) {
      // 0012: a spread of lifecycles — active, half a year idle, never opened,
      // and two past the 365-day line.
      const idle = [3, 12, 200, 30, 386, 540];
      return send(200, who === 'admin' ? PRODUCTS.filter(p => p.product_assets.length).map((p, i) => {
        const days = idle[i % idle.length];
        return {
          asset_id: `0000000${i}-0000-4000-8000-000000000000`, kind: 'glb', object_path: `${STORE}/${p.id}/model.glb`,
          byte_size: (i + 1) * 7.3e6, uploaded_at: iso((days + 40) * day), last_accessed_at: i === 3 ? null : iso(days * day),
          last_used_at: iso(days * day), idle_days: days, eligible: days >= 365,
          eligible_on: new Date(Date.now() + (365 - days) * day).toISOString().slice(0, 10),
          product_id: p.id, product_name: p.name, product_slug: p.slug, product_status: p.status,
          store_id: STORE, store_name: STORES[0].name, poster_path: null,
          notice_sent_at: days >= 365 ? iso((days - 335) * day) : null, notice_due: days >= 335 && days < 365
        };
      }) : []);
    }
    if (u.startsWith('/rest/v1/rpc/storage_usage')) return send(200, [{ store_id: STORE, store_name: STORES[0].name, file_count: 5, total_bytes: 73e6 }, { store_id: 's1', store_name: 'Store 1', file_count: 1, total_bytes: 4e6 }]);
    if (u.startsWith('/rest/v1/rpc/fee_overview')) {
      return send(200, STORES.slice(0, 5).map((s, i) => ({ store_id: s.id, store_name: s.name, fulfilment: 'stocked', sales: 160050 - i * 30000, accrued: 14550 - i * 2000, collected: 0, refunded: 0, settled: 4850, outstanding: Math.max(0, 9700 - i * 2000), payment_status: i === 0 ? 'CONNECTED' : i === 2 ? 'ERROR' : 'NOT_CONNECTED', payment_environment: i === 0 ? 'sandbox' : null, merchant_id_masked: i === 0 ? '••••••••7KQ2X' : null })));
    }
    if (u.startsWith('/rest/v1/rpc/my_account_state')) return send(200, { role: who });
    send(200, []);
  });
});

await new Promise(r => supabase.listen(SB_PORT, '127.0.0.1', r));
try { execSync(`fuser -k ${APP_PORT}/tcp`, { stdio: 'ignore' }); } catch {}
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  stdio: 'ignore', detached: true,
  env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_shoot00000000',
    PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYMENT_RECORDER_SECRET: 's'.repeat(40),
    FURNISHAR_JWT_SECRET: 'shoot-ui-secret', SITE_URL: APP, PAYPAL_API_BASE: 'http://127.0.0.1:1' }
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${APP}/api/sb/status`)).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const SCREENS = [
  { name: 'home', path: '/', as: null },
  { name: 'collection', path: '/collection', as: null },
  { name: 'product', path: '/furniture/piece-0', as: null },
  { name: 'login', path: '/login', as: null },
  { name: 'diagnose', path: '/diagnose', as: null },
  { name: 'account', path: '/account', as: 'tok-buyer' },
  { name: 'portal', path: '/portal', as: 'tok-owner', wait: '#portal-title' },
  { name: 'portal-form', path: '/portal', as: 'tok-owner', wait: '#portal-title', open: 'form' },
  { name: 'admin', path: '/admin', as: 'tok-admin', wait: '#console-title' },
  { name: 'admin-applications', path: '/admin/applications', as: 'tok-admin', wait: '#console-title' },
  { name: 'admin-stores', path: '/admin/stores', as: 'tok-admin', wait: '#console-title' },
  { name: 'admin-models', path: '/admin/models', as: 'tok-admin', wait: '#console-title' },
  { name: 'admin-billing', path: '/admin/billing', as: 'tok-admin', wait: '#console-title' },
  { name: 'admin-activity', path: '/admin/activity', as: 'tok-admin', wait: '#console-title' }
];
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;

const report = [];
try {
  for (const width of WIDTHS) {
    for (const screen of SCREENS) {
      if (only && !only.test(screen.name)) continue;
      const height = width < 700 ? Math.round(width * 2.16) : 900;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: width < 700, isMobile: width < 700 });
      const page = await context.newPage();
      await page.goto(`${APP}/faq`);
      await page.evaluate(([token, theme]) => {
        localStorage.setItem('furnishar-storage-notice', 'seen');
        localStorage.setItem('furnishar-theme', theme);
        if (token) sessionStorage.setItem('furnishar-sb-session', JSON.stringify({
          access_token: token, refresh_token: `${token}-r`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u', email: `${token.slice(4)}@gmail.com` }
        }));
      }, [screen.as, THEME]);
      await page.goto(`${APP}${screen.path}`, { waitUntil: 'networkidle' }).catch(() => {});
      if (screen.wait) await page.locator(screen.wait).first().waitFor({ timeout: 15000 }).catch(() => {});
      await page.addStyleTag({ content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important} .reveal{opacity:1!important;transform:none!important;filter:none!important}' });
      await page.waitForTimeout(700);
      if (screen.open === 'form') {
        await page.getByRole('button', { name: /Add Product/i }).first().click().catch(() => {});
        await page.waitForTimeout(600);
      }
      const facts = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        height: document.documentElement.scrollHeight,
        publicBottomNav: Boolean(document.querySelector('.bottom-nav')) && getComputedStyle(document.querySelector('.bottom-nav')).display !== 'none',
        workspaceNav: Boolean(document.querySelector('.workspace-tabbar')) && getComputedStyle(document.querySelector('.workspace-tabbar')).display !== 'none'
      }));
      // PROBE=1 lists the deepest elements that stick out past the right edge.
      if (process.env.PROBE) console.log(screen.name, width, await page.evaluate(PROBE => {
        const vw = document.documentElement.clientWidth;
        if (PROBE === 'top') return [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > vw + 1 && !(el.parentElement.getBoundingClientRect().right > vw + 1)).slice(0, 12).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} w=${Math.round(el.getBoundingClientRect().width)} parent=${el.parentElement.className}`);
        return [...document.querySelectorAll('body *')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.right > vw + 1 && r.width > 0 && ![...el.children].some(c => c.getBoundingClientRect().right > vw + 1);
        }).slice(0, 12).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} right=${Math.round(el.getBoundingClientRect().right)} "${(el.textContent || '').trim().slice(0, 30)}"`);
      }, process.env.PROBE));
      report.push({ width, screen: screen.name, ...facts });
      await page.screenshot({ path: `${OUT}/${screen.name}-${width}${THEME === 'dark' ? '-dark' : ''}.png`, fullPage: true });
      await page.screenshot({ path: `${OUT}/${screen.name}-${width}${THEME === 'dark' ? '-dark' : ''}-fold.png` });
      await context.close();
    }
  }
} finally {
  await browser.close();
  try { process.kill(-app.pid); } catch {}
  supabase.close();
}
console.table(report);
