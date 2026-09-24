/**
 * Orders and payments, end to end in a real browser.             DFD: P10
 *
 * Starts its own stand-ins for Supabase and PayPal and a production build of
 * the app pointed at them, then walks the paths a person would:
 *   - a guest who taps Buy is asked to sign in, not sent to PayPal;
 *   - a buyer sees the shop price, the 10% fee and the total, is sent to
 *     PayPal for the DATABASE's amount, payable to the SHOP, comes back and
 *     sees the order paid — with the server secret, never the browser, having
 *     recorded it;
 *   - a buyer requests a custom build from a made-to-order shop;
 *   - the shop owner sees billing settings and the order, and sends a quote.
 *
 * Needs `npm run build` first. Usage: node scripts/check-billing.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const APP_PORT = 4481;
const SB_PORT = 4797;
const PP_PORT = 4798;
const APP = `http://127.0.0.1:${APP_PORT}`;
const SECRET = 's'.repeat(40);

const STOCK_STORE = '2b1c4e4e-0000-4000-8000-000000000002';
const CUSTOM_STORE = '2b1c4e4e-0000-4000-8000-000000000003';
const CHAIR = '6f1c4e4e-0000-4000-8000-000000000001';
const TABLE = '6f1c4e4e-0000-4000-8000-000000000009';

const problems = [];
// SHOTS=<dir> saves a screenshot of each screen checked, for a human to look at.
const shot = async (p, name) => { if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

/* ------------------------------------------------------------ fake data --- */

const row = (id, slug, name, store, storeName, fulfilment, price) => ({
  id, slug, name, store_id: store, store_slug: storeName.toLowerCase().replace(/\W+/g, '-'), store_name: storeName,
  store_address: 'Mamburao', store_contact_number: '+63 900 000 0000', store_hours: '8-6',
  category: 'Chair', style: 'Modern', color: 'Natural', price_php: String(price), stock: 5,
  width_cm: '70.0', height_cm: '88.0', depth_cm: '78.0', bounds_width_cm: '70.0', bounds_height_cm: '88.0',
  bounds_depth_cm: '78.0', preview_shape: 'chair', description: 'Test piece.', ar_ready: false, featured: false,
  updated_at: '2026-09-20T00:00:00Z', model_glb_path: null, model_usdz_path: null, store_fulfilment: fulfilment
});
const catalog = [
  row(CHAIR, 'billing-check-chair', 'Billing Check Chair', STOCK_STORE, 'Stock Shop', 'stocked', 1000),
  row(TABLE, 'billing-check-table', 'Billing Check Table', CUSTOM_STORE, 'Maker Shop', 'custom', 5000)
];
const stores = [
  { id: STOCK_STORE, slug: 'stock-shop', name: 'Stock Shop', address: 'Mamburao', contact_number: '+63', hours: '8-6', plan: 'premium', fulfilment: 'stocked' },
  { id: CUSTOM_STORE, slug: 'maker-shop', name: 'Maker Shop', address: 'Mamburao', contact_number: '+63', hours: '8-6', plan: 'premium', fulfilment: 'custom' }
];
const orders = [];
const recorded = [];
const paypalCreated = [];

const who = auth => (/tok-buyer/.test(auth || '') ? 'buyer' : /tok-owner/.test(auth || '') ? 'owner' : 'guest');

function dueFor(order) {
  const stage = { pending_payment: 'full', quoted: 'deposit', balance_due: 'balance' }[order.status] || null;
  const amount = stage === 'full' ? order.total : stage === 'deposit' ? order.deposit_amount : order.total - order.amount_paid;
  return { order_id: order.id, reference: order.reference, stage, amount, currency: 'PHP',
           payee_email: 'shop@pay.test', store_name: 'Stock Shop', product_name: order.product_name };
}

const supabase = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const body = raw ? JSON.parse(raw) : {};
    const u = req.url;
    const role = who(req.headers.authorization);
    if (u.startsWith('/auth/v1/health')) return send(200, {});
    if (u.startsWith('/auth/v1/user')) return role === 'guest' ? send(401, {}) : send(200, { id: `${role}-1`, email: `${role}@test.ph` });
    if (u.startsWith('/rest/v1/rpc/my_role')) return send(200, role);
    if (u.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, false);
    if (u.startsWith('/rest/v1/catalog')) return send(200, catalog);
    if (u.startsWith('/rest/v1/stores')) return send(200, u.includes(`id=eq.${STOCK_STORE}`) ? [stores[0]] : stores);
    if (u.startsWith('/rest/v1/buyers')) return send(200, role === 'buyer' ? [{ full_name: 'Ana Reyes', municipality: 'Mamburao' }] : []);
    if (u.startsWith('/rest/v1/municipalities')) return send(200, [{ name: 'Mamburao' }]);
    if (u.startsWith('/rest/v1/store_members')) {
      return send(200, role === 'owner' ? [{ role: 'owner', stores: { id: STOCK_STORE, slug: 'stock-shop', name: 'Stock Shop', plan: 'premium' } }] : []);
    }
    if (u.startsWith('/rest/v1/store_payout')) return send(200, [{ paypal_email: 'shop@pay.test', notify_email: null }]);
    if (u.startsWith('/rest/v1/rpc/store_fee_summary')) return send(200, { accrued: 200, settled: 0, outstanding: 200 });
    if (u.startsWith('/rest/v1/orders')) {
      const mine = orders.filter(o => (role === 'buyer' ? true : role === 'owner' ? o.store_id === STOCK_STORE : false));
      return send(200, mine.map(o => ({ ...o, stores: { name: o.store_id === STOCK_STORE ? 'Stock Shop' : 'Maker Shop', slug: 'x' } })));
    }
    if (u.startsWith('/rest/v1/rpc/create_stock_order')) {
      if (role !== 'buyer') return send(403, { code: '42501', message: 'Only a shopper account can place orders.' });
      const qty = body.p_quantity;
      const order = { id: `0000000${orders.length + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, reference: `REF${orders.length + 1}`,
        kind: 'stock', status: 'pending_payment', store_id: STOCK_STORE, product_id: CHAIR, product_name: 'Billing Check Chair',
        quantity: qty, subtotal: 1000 * qty, platform_fee: 100 * qty, total: 1100 * qty, amount_paid: 0,
        created_at: new Date().toISOString(), hold_expires_at: new Date(Date.now() + 1800e3).toISOString(),
        buyer_name: 'Ana Reyes', buyer_email: 'buyer@test.ph' };
      orders.push(order);
      return send(200, { order_id: order.id, reference: order.reference });
    }
    if (u.startsWith('/rest/v1/rpc/begin_payment')) {
      const order = orders.find(o => o.id === body.p_order);
      return order ? send(200, dueFor(order)) : send(403, { code: '42501', message: 'That order is not yours.' });
    }
    if (u.startsWith('/rest/v1/rpc/record_capture')) {
      recorded.push(body);
      if (body.p_secret !== SECRET) return send(403, { code: '42501', message: 'Payments are recorded by the server only.' });
      const order = orders.find(o => o.id === body.p_order);
      order.status = 'paid';
      order.amount_paid = body.p_amount;
      return send(200, { order_id: order.id, status: 'paid', applied: true, duplicate: false });
    }
    if (u.startsWith('/rest/v1/rpc/order_contacts')) return send(200, { reference: 'REF', buyer_email: 'buyer@test.ph', store_emails: ['shop@test.ph'] });
    if (u.startsWith('/rest/v1/rpc/create_custom_request')) {
      const order = { id: `0000000${orders.length + 1}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, reference: `REQ${orders.length + 1}`,
        kind: 'custom', status: 'requested', store_id: STOCK_STORE, product_id: TABLE, product_name: 'Custom: Billing Check Table',
        quantity: 1, request: body.p_request, amount_paid: 0, created_at: new Date().toISOString(),
        buyer_name: 'Ana Reyes', buyer_email: 'buyer@test.ph' };
      orders.push(order);
      return send(200, { order_id: order.id, reference: order.reference });
    }
    if (u.startsWith('/rest/v1/rpc/quote_custom_order')) {
      const order = orders.find(o => o.id === body.p_order);
      Object.assign(order, { status: 'quoted', subtotal: body.p_price, platform_fee: body.p_price * 0.1,
        total: body.p_price * 1.1, deposit_amount: body.p_price * 0.55, lead_time_days: body.p_lead_days });
      return send(200, { order_id: order.id, status: 'quoted' });
    }
    if (u.startsWith('/rest/v1/products')) return send(200, []);
    send(200, []);
  });
});

const paypalOrders = new Map();
const paypal = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'pp', expires_in: 3600 });
    if (req.url === '/v2/checkout/orders' && req.method === 'POST') {
      const body = JSON.parse(raw);
      paypalCreated.push(body);
      const id = `PPORDER${String(paypalOrders.size + 1).padStart(6, '0')}`;
      paypalOrders.set(id, { id, status: 'APPROVED', purchase_units: [{ ...body.purchase_units[0] }], payer: { email_address: 'payer@pp.test' } });
      // Approval is PayPal's business; the stand-in approves at once and
      // sends the buyer straight back, as PayPal does after they confirm.
      return send(201, { id, links: [{ rel: 'payer-action', href: `${body.payment_source.paypal.experience_context.return_url}&token=${id}` }] });
    }
    const match = req.url.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/);
    if (match) {
      const order = paypalOrders.get(match[1]);
      if (!order) return send(404, { name: 'RESOURCE_NOT_FOUND' });
      if (match[2]) {
        const unit = order.purchase_units[0];
        order.status = 'COMPLETED';
        unit.payments = { captures: [{ id: `CAP${match[1]}`, status: 'COMPLETED', custom_id: unit.custom_id, amount: unit.amount }] };
      }
      return send(200, order);
    }
    send(404, {});
  });
});

await new Promise(resolve => supabase.listen(SB_PORT, '127.0.0.1', resolve));
await new Promise(resolve => paypal.listen(PP_PORT, '127.0.0.1', resolve));
try { execSync(`fuser -k ${APP_PORT}/tcp`, { stdio: 'ignore' }); } catch {}
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  stdio: 'ignore', detached: true,
  env: {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_billingcheck0000',
    PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_API_BASE: `http://127.0.0.1:${PP_PORT}`,
    PAYMENT_RECORDER_SECRET: SECRET, FURNISHAR_JWT_SECRET: 'billing-check', SITE_URL: APP
  }
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${APP}/api/sb/orders/config`)).ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
async function page(token) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await context.newPage();
  await p.goto(`${APP}/faq`);
  await p.evaluate(value => {
    localStorage.setItem('furnishar-storage-notice', 'seen');
    if (value) sessionStorage.setItem('furnishar-sb-session', JSON.stringify({
      access_token: value, refresh_token: `${value}-r`, expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'u', email: `${value}@test.ph` }
    }));
  }, token);
  return p;
}

try {
  const config = await (await fetch(`${APP}/api/sb/orders/config`)).json();
  check('payments are switched on by the server', config.payments === true);
  check('the config says nothing secret', !JSON.stringify(config).includes(SECRET) && !JSON.stringify(config).includes('secret'));

  console.log('--- a guest is asked to sign in ---');
  const guest = await page(null);
  await guest.goto(`${APP}/furniture/billing-check-chair`);
  await guest.getByRole('button', { name: 'Buy with PayPal' }).click();
  check('the sign-in dialog opens', await guest.locator('dialog.auth-gate[open]').isVisible());
  check('and nothing was sent to PayPal', paypalCreated.length === 0);

  console.log('--- a buyer pays the shop ---');
  const buyer = await page('tok-buyer');
  buyer.on('response', async r => { if (r.url().includes('/api/sb/orders/') && !r.ok()) console.log('  (', r.status(), r.url(), await r.text().catch(() => ''), ')'); });
  buyer.on('pageerror', e => console.log('  (pageerror', e.message, ')'));
  await buyer.goto(`${APP}/furniture/billing-check-chair`);
  await buyer.locator('.quantity-field select').selectOption('2');
  const breakdown = await buyer.locator('.price-breakdown').innerText();
  await shot(buyer, 'product-stocked');
  check('price, 10% fee and total are shown', /2,000\.00/.test(breakdown) && /200\.00/.test(breakdown) && /2,200\.00/.test(breakdown), breakdown.replace(/\s+/g, ' '));
  await buyer.getByRole('button', { name: 'Buy with PayPal' }).click();
  await buyer.waitForURL(/\/account/, { timeout: 20000 }).catch(async () => {
    console.log('  (still on', buyer.url(), '—', (await buyer.locator('[role="alert"], [role="status"]').allInnerTexts()).join(' | '), ')');
  });
  await buyer.locator('.order-status', { hasText: 'Paid' }).first().waitFor({ timeout: 20000 }).catch(() => {});
  const created = paypalCreated[0]?.purchase_units?.[0];
  check('PayPal was asked for the database amount', created?.amount?.value === '2200.00', created?.amount?.value);
  check('payable to the shop, not FurnishAR', created?.payee?.email_address === 'shop@pay.test');
  check('the capture was recorded with the server secret', recorded.at(-1)?.p_secret === SECRET);
  await shot(buyer, 'account-orders');
  check('the order shows as paid', await buyer.locator('.order-status', { hasText: 'Paid' }).first().isVisible());
  check('the return address was cleaned', !buyer.url().includes('token='), buyer.url());

  console.log('--- a buyer requests a custom build ---');
  await buyer.goto(`${APP}/furniture/billing-check-table`);
  check('made-to-order is said, not a stock count', /Made to order/.test(await buyer.locator('.detail-availability').innerText()));
  await buyer.getByRole('button', { name: 'Request a custom build' }).click();
  await buyer.locator('dialog.request-dialog textarea[name="notes"]').fill('Narra, 6 seats');
  await shot(buyer, 'custom-request');
  await buyer.getByRole('button', { name: 'Send request' }).click();
  await buyer.locator('text=/Request REQ\\d+ sent/').first().waitFor({ timeout: 10000 }).catch(() => {});
  check('the request is confirmed', await buyer.locator('text=/Request REQ\\d+ sent/').first().isVisible());

  console.log('--- the shop sees it and quotes ---');
  const owner = await page('tok-owner');
  await owner.goto(`${APP}/portal`);
  await owner.locator('#billing-title').waitFor({ timeout: 20000 }).catch(() => {});
  check('billing settings are in the portal', await owner.locator('#billing-title').isVisible());
  check('the fee owed is shown', /200\.00/.test(await owner.locator('.billing-summary').innerText().catch(() => '')));
  await owner.getByRole('button', { name: 'Send quote' }).first().click();
  await owner.locator('.order-quote input[name="price"]').fill('5000');
  await owner.locator('.order-quote input[name="leadDays"]').fill('14');
  await shot(owner, 'portal-quote');
  await owner.locator('.order-quote button[type="submit"]').click();
  await owner.locator('.order-status', { hasText: 'Quote ready' }).first().waitFor({ timeout: 10000 }).catch(() => {});
  check('the quote is sent', await owner.locator('.order-status', { hasText: 'Quote ready' }).first().isVisible());
} finally {
  await browser.close();
  try { process.kill(-app.pid); } catch {}
  supabase.close();
  paypal.close();
}

console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall billing checks passed');
process.exit(problems.length ? 1 : 0);
