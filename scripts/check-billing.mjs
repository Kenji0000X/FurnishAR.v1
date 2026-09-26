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
 *   - the shop owner sees billing settings and the order, and sends a quote;
 *   - (0011) checkout pays the shop's CONNECTED PayPal merchant id; a shop
 *     that is not connected offers no checkout; the owner connects PayPal
 *     through Partner Referrals and the status comes from PayPal; a new
 *     Google account signs in, onboards as a buyer with only a municipality;
 *     the admin sees the fee mode truthfully and the sandbox marker.
 *   - (0015) a Maya-only shop offers "Buy with Maya"; the checkout is created
 *     with Maya's PUBLIC key for the database's amount, payable to
 *     FurnishAR's own Maya account (platform collect); the buyer returns to
 *     /account/payment/return, where the server re-reads the payment with the
 *     SECRET key and records it as Maya; a webhook redelivery changes
 *     nothing; the admin sees Maya's configuration and a provider filter.
 *
 * Needs `npm run build` first. Usage: node scripts/check-billing.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const APP_PORT = 4481;
const SB_PORT = 4797;
const PP_PORT = 4798;
const MY_PORT = 4799;
const APP = `http://127.0.0.1:${APP_PORT}`;
const SECRET = 's'.repeat(40);

const STOCK_STORE = '2b1c4e4e-0000-4000-8000-000000000002';
const CUSTOM_STORE = '2b1c4e4e-0000-4000-8000-000000000003';
const CHAIR = '6f1c4e4e-0000-4000-8000-000000000001';
const TABLE = '6f1c4e4e-0000-4000-8000-000000000009';
const OFFLINE_STORE = '2b1c4e4e-0000-4000-8000-000000000004';
const STOOL = '6f1c4e4e-0000-4000-8000-000000000010';
const MAYA_STORE = '2b1c4e4e-0000-4000-8000-000000000005';
const LAMP = '6f1c4e4e-0000-4000-8000-000000000011';

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
  updated_at: '2026-09-20T00:00:00Z', model_glb_path: null, model_usdz_path: null, store_fulfilment: fulfilment,
  store_payments_ready: store !== OFFLINE_STORE
});
const catalog = [
  row(CHAIR, 'billing-check-chair', 'Billing Check Chair', STOCK_STORE, 'Stock Shop', 'stocked', 1000),
  row(TABLE, 'billing-check-table', 'Billing Check Table', CUSTOM_STORE, 'Maker Shop', 'custom', 5000),
  row(STOOL, 'billing-check-stool', 'Billing Check Stool', OFFLINE_STORE, 'Unconnected Shop', 'stocked', 800),
  row(LAMP, 'billing-check-lamp', 'Billing Check Lamp', MAYA_STORE, 'Maya Shop', 'stocked', 1000)
];
const stores = [
  { id: STOCK_STORE, slug: 'stock-shop', name: 'Stock Shop', address: 'Mamburao', contact_number: '+63', hours: '8-6', plan: 'premium', fulfilment: 'stocked' },
  { id: CUSTOM_STORE, slug: 'maker-shop', name: 'Maker Shop', address: 'Mamburao', contact_number: '+63', hours: '8-6', plan: 'premium', fulfilment: 'custom' }
];
const orders = [];
const recorded = [];
const paypalCreated = [];
const delivered = [];
const attempts = new Map();          // provider order id (PayPal order / Maya checkout) → the recorded attempt
const mayaCheckouts = [];            // what Maya was asked for, with the key it was asked with
const mayaPayments = new Map();      // FurnishAR reference → Maya's payments for it
const mayaReads = [];                // every payment read, with its key
const claimedEvents = new Set();     // payment_webhook_events
const serverCalls = [];              // every server_* call, to check the secret
// The owner's PayPal account: starts NOT connected, then goes through onboarding.
let ownerAccount = null;
let newbieOnboarded = false;

const who = auth => (/tok-buyer/.test(auth || '') ? 'buyer' : /tok-owner/.test(auth || '') ? 'owner'
  : /tok-admin/.test(auth || '') ? 'admin' : /tok-newbie/.test(auth || '') ? (newbieOnboarded ? 'buyer' : 'onboarding') : 'guest');

function dueFor(order, provider = 'paypal') {
  const stage = { pending_payment: 'full', quoted: 'deposit', balance_due: 'balance' }[order.status] || null;
  const amount = stage === 'full' ? order.total : stage === 'deposit' ? order.deposit_amount : order.total - order.amount_paid;
  const maya = order.store_id === MAYA_STORE;
  if (maya !== (provider === 'maya')) return null;   // this shop does not take that method
  return { order_id: order.id, reference: order.reference, stage, amount, currency: 'PHP',
           platform_fee: order.platform_fee, provider,
           merchant_id: maya ? null : 'STOCKMERCHANT1', partner_fee_granted: false,
           settlement_mode: maya ? 'platform_collect' : null, provider_account_ref: null, provider_profile: null,
           store_name: maya ? 'Maya Shop' : 'Stock Shop', product_name: order.product_name };
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
    if (u.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, role === 'admin');
    if (u.startsWith('/auth/v1/authorize')) {
      // Supabase would send the browser to Google; the stand-in plays Google
      // choosing an account and returning through Supabase at once.
      const back = new URL(new URL(u, 'http://x').searchParams.get('redirect_to'));
      back.searchParams.set('code', 'google-code-12345');
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (u.startsWith('/auth/v1/token?grant_type=pkce')) {
      return body.auth_code === 'google-code-12345' && body.code_verifier
        ? send(200, { access_token: 'tok-newbie', refresh_token: 'tok-newbie-r', expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', provider_token: 'GOOGLE-SECRET-TOKEN',
            user: { id: 'newbie-1', email: 'newbie@gmail.com', user_metadata: { full_name: 'Nina Gomez' } } })
        : send(404, { error_code: 'flow_state_not_found' });
    }
    if (u.startsWith('/rest/v1/rpc/my_account_state')) {
      return send(200, { role, email: `${role}@gmail.com`, name: 'Nina Gomez', buyer: null, application: null });
    }
    if (u.startsWith('/rest/v1/rpc/complete_buyer_onboarding')) {
      if (role !== 'onboarding' || body.p_municipality !== 'Sablayan') return send(400, { code: 'P0001', message: 'Choose your municipality in Occidental Mindoro.' });
      newbieOnboarded = true;
      return send(200, { created: true, role: 'buyer', full_name: 'Nina Gomez', email: 'newbie@gmail.com' });
    }
    if (u.startsWith('/rest/v1/rpc/server_')) {
      serverCalls.push({ fn: u.split('?')[0].slice('/rest/v1/rpc/'.length), body });
      if (body.p_secret !== SECRET) return send(403, { code: '42501', message: 'Only the FurnishAR server may do this.' });
    }
    if (u.startsWith('/rest/v1/rpc/server_record_payment_attempt')) {
      attempts.set(body.p_provider_order, { order_id: body.p_order, stage: body.p_stage, amount: body.p_amount, currency: 'PHP',
        platform_fee: body.p_platform_fee, fee_mode: body.p_fee_mode, payee_merchant_id: body.p_merchant, environment: body.p_env,
        provider: body.p_provider || 'paypal', provider_order_id: body.p_provider_order, provider_reference: body.p_reference ?? null });
      return send(200, { ok: true });
    }
    if (u.startsWith('/rest/v1/rpc/server_payment_attempt_by_reference')) {
      return send(200, [...attempts.values()].find(a => a.provider === body.p_provider && a.provider_reference === body.p_reference) || null);
    }
    if (u.startsWith('/rest/v1/rpc/server_claim_webhook_event')) {
      if (claimedEvents.has(body.p_event_id)) return send(200, false);
      claimedEvents.add(body.p_event_id);
      return send(200, true);
    }
    if (u.startsWith('/rest/v1/rpc/server_finish_webhook_event')) return send(200, null);
    if (u.startsWith('/rest/v1/rpc/store_payment_providers')) {
      return send(200, body.p_store === OFFLINE_STORE ? [] : body.p_store === MAYA_STORE ? ['maya'] : ['paypal']);
    }
    if (u.startsWith('/rest/v1/rpc/server_payment_attempt')) return send(200, attempts.get(body.p_provider_order) || null);
    if (u.startsWith('/rest/v1/rpc/server_update_payment_attempt')) return send(200, { ok: true });
    if (u.startsWith('/rest/v1/rpc/server_admin_emails')) return send(200, ['admin@furnishar.test']);
    if (u.startsWith('/rest/v1/rpc/server_store_contacts')) return send(200, { store_id: STOCK_STORE, store_name: 'Stock Shop', store_emails: ['owner@test.ph'] });
    if (u.startsWith('/rest/v1/rpc/server_payment_onboarding_started')) {
      if (role !== 'owner' || body.p_store !== STOCK_STORE) return send(403, { code: '42501', message: "Only this store's owner can connect its PayPal account." });
      ownerAccount = { environment: body.p_env, tracking_id: body.p_tracking_id, merchant_id: null, onboarding_status: 'ONBOARDING_STARTED' };
      return send(200, { ok: true });
    }
    if (u.startsWith('/rest/v1/rpc/server_record_payment_account')) {
      const before = ownerAccount?.onboarding_status || 'NOT_CONNECTED';
      ownerAccount = { ...ownerAccount, merchant_id: body.p_merchant_id ?? ownerAccount?.merchant_id ?? null, onboarding_status: body.p_status,
        status_detail: body.p_detail,
        payments_receivable: body.p_receivable, email_confirmed: body.p_email_confirmed, last_checked_at: new Date().toISOString() };
      return send(200, { found: true, store_id: STOCK_STORE, before, status: body.p_status });
    }
    if (u.startsWith('/rest/v1/store_payment_accounts')) return send(200, role === 'owner' && ownerAccount ? [ownerAccount] : []);
    if (u.startsWith('/rest/v1/rpc/fee_overview')) {
      return role === 'admin' ? send(200, [
        { store_id: STOCK_STORE, store_name: 'Stock Shop', fulfilment: 'stocked', sales: 2200, accrued: 200, collected: 0, refunded: 0,
          settled: 0, outstanding: 200, payment_status: 'CONNECTED', payment_environment: 'sandbox', merchant_id_masked: '•••••••••••NT1' },
        { store_id: OFFLINE_STORE, store_name: 'Unconnected Shop', fulfilment: 'stocked', sales: 0, accrued: 0, collected: 0, refunded: 0,
          settled: 0, outstanding: 0, payment_status: 'NOT_CONNECTED', payment_environment: null, merchant_id_masked: null }
      ]) : send(403, { code: '42501', message: 'Only a platform administrator may view fees.' });
    }
    if (u.startsWith('/rest/v1/catalog')) return send(200, catalog);
    if (u.startsWith('/rest/v1/stores')) return send(200, u.includes(`id=eq.${STOCK_STORE}`) ? [stores[0]] : stores);
    if (u.startsWith('/rest/v1/buyers')) return send(200, role === 'buyer' ? [{ full_name: 'Ana Reyes', municipality: 'Mamburao' }] : []);
    if (u.startsWith('/rest/v1/municipalities')) return send(200, [{ name: 'Mamburao' }, { name: 'Sablayan' }]);
    if (u.startsWith('/rest/v1/store_members')) {
      return send(200, role === 'owner' ? [{ role: 'owner', stores: { id: STOCK_STORE, slug: 'stock-shop', name: 'Stock Shop', plan: 'premium' } }] : []);
    }
    if (u.startsWith('/rest/v1/store_payout')) return send(200, [{ paypal_email: 'shop@pay.test', notify_email: null }]);
    if (u.startsWith('/rest/v1/rpc/store_fee_summary')) return send(200, { accrued: 200, settled: 0, outstanding: 200 });
    if (u.startsWith('/rest/v1/orders')) {
      const wanted = u.match(/[?&]id=eq\.([0-9a-f-]+)/)?.[1];
      const mine = orders.filter(o => (role === 'buyer' ? true : role === 'owner' ? o.store_id === STOCK_STORE : false))
        .filter(o => !wanted || o.id === wanted);
      return send(200, mine.map(o => ({ ...o,
        stores: { name: o.store_id === STOCK_STORE ? 'Stock Shop' : 'Maker Shop', slug: 'x', address: 'Mamburao', contact_number: '0917' },
        payments: recorded.filter(r => r.p_order === o.id && r.p_secret === SECRET && !r.duplicate)
          .map(r => ({ stage: r.p_stage, amount: r.p_amount, capture_id: r.p_capture, captured_at: new Date().toISOString(),
                       applied: true, provider: r.p_provider || 'paypal' })) })));
    }
    if (u.startsWith('/rest/v1/rpc/update_delivery_status')) {
      const order = orders.find(o => o.id === body.p_order);
      order.delivery_status = body.p_status;
      if (body.p_status === 'delivered') order.status = 'fulfilled';
      return send(200, { order_id: order.id, delivery_status: body.p_status });
    }
    if (u.startsWith('/rest/v1/rpc/create_stock_order')) {
      if (role !== 'buyer') return send(403, { code: '42501', message: 'Only a shopper account can place orders.' });
      const qty = body.p_quantity;
      const lamp = body.p_product === LAMP;
      const order = { id: `0000000${orders.length + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, reference: `REF${orders.length + 1}`,
        kind: 'stock', status: 'pending_payment', store_id: lamp ? MAYA_STORE : STOCK_STORE, product_id: lamp ? LAMP : CHAIR,
        product_name: lamp ? 'Billing Check Lamp' : 'Billing Check Chair',
        quantity: qty, subtotal: 1000 * qty, platform_fee: 100 * qty, total: 1100 * qty, amount_paid: 0,
        created_at: new Date().toISOString(), hold_expires_at: new Date(Date.now() + 1800e3).toISOString(),
        buyer_name: 'Ana Reyes', buyer_email: 'buyer@test.ph',
        fulfilment_method: body.p_method, delivery_address: body.p_address, delivery_municipality: body.p_municipality,
        delivery_phone: body.p_phone, delivery_notes: body.p_notes };
      delivered.push({ ...body });
      orders.push(order);
      return send(200, { order_id: order.id, reference: order.reference });
    }
    if (u.startsWith('/rest/v1/rpc/begin_payment')) {
      const order = orders.find(o => o.id === body.p_order);
      if (!order) return send(403, { code: '42501', message: 'That order is not yours.' });
      const due = dueFor(order, body.p_provider || 'paypal');
      return due ? send(200, due) : send(400, { code: 'P0001', message: 'This shop cannot take that payment method.' });
    }
    if (u.startsWith('/rest/v1/rpc/record_capture')) {
      if (recorded.some(r => r.p_capture === body.p_capture)) {
        recorded.push({ ...body, duplicate: true });
        const order = orders.find(o => o.id === body.p_order);
        return send(200, { order_id: order.id, status: order.status, applied: true, duplicate: true });
      }
      recorded.push(body);
      const attempt = attempts.get(body.p_provider_order);
      if (!attempt || attempt.payee_merchant_id !== body.p_payee_merchant || attempt.provider !== (body.p_provider || 'paypal')) {
        return send(400, { code: 'P0001', message: 'The payment went to the wrong account.' });
      }
      if (body.p_secret !== SECRET) return send(403, { code: '42501', message: 'Payments are recorded by the server only.' });
      const order = orders.find(o => o.id === body.p_order);
      order.status = 'paid';
      order.amount_paid = body.p_amount;
      order.delivery_status = 'preparing';
      order.estimated_arrival = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
      return send(200, { order_id: order.id, status: 'paid', applied: true, duplicate: false, platform_fee: order.platform_fee,
                         fee_mode: attempt.fee_mode, provider: attempt.provider });
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
const referrals = [];
const verifyOrders = [];
const paypal = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'pp', expires_in: 3600 });
    if (req.url === '/v2/customer/partner-referrals' && req.method === 'POST') {
      const body = JSON.parse(raw);
      referrals.push(body);
      // The seller would sign in on PayPal here; the stand-in sends them back.
      return send(201, { links: [{ rel: 'action_url', href: body.partner_config_override.return_url }] });
    }
    if (req.url.startsWith('/v1/customer/partners/PARTNER1/merchant-integrations?tracking_id=')) {
      return send(200, { merchant_id: 'STOCKMERCHANT1', tracking_id: decodeURIComponent(req.url.split('=')[1]) });
    }
    if (req.url === '/v1/customer/partners/PARTNER1/merchant-integrations/STOCKMERCHANT1') {
      return send(200, { merchant_id: 'STOCKMERCHANT1', payments_receivable: true, primary_email_confirmed: true,
        oauth_integrations: [{ integration_type: 'OAUTH_THIRD_PARTY', oauth_third_party: [{ scopes: ['https://uri.paypal.com/services/payments/realtimepayment'] }] }] });
    }
    if (req.url === '/v2/checkout/orders' && req.method === 'POST') {
      const body = JSON.parse(raw);
      // The Merchant-ID check: PayPal refuses an order to a payee it doesn't know.
      if (!body.payment_source) {
        verifyOrders.push(body);
        return body.purchase_units[0].payee.merchant_id === 'BADMERCHANT1'
          ? send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYEE_ACCOUNT_INVALID' }] })
          : send(201, { id: `CHECK${verifyOrders.length}`, status: 'CREATED' });
      }
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

/* A stand-in Maya: the checkout is paid at once and the buyer sent to the
   success URL, as Maya does after they pay. Payments are read back by reference. */
const basicUser = header => Buffer.from(String(header || '').replace(/^Basic /, ''), 'base64').toString().replace(/:$/, '');
const mayaServer = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const key = basicUser(req.headers.authorization);
    if (req.url === '/checkout/v1/checkouts' && req.method === 'POST') {
      const body = JSON.parse(raw);
      mayaCheckouts.push({ body, key });
      if (key !== 'pk-check-public') return send(401, { code: 'K004' });
      const id = `MAYACHK${mayaCheckouts.length}`;
      mayaPayments.set(body.requestReferenceNumber, [{ id: `MAYAPAY${mayaCheckouts.length}`, status: 'PAYMENT_SUCCESS', isPaid: true,
        amount: String(body.totalAmount.value), currency: body.totalAmount.currency, requestReferenceNumber: body.requestReferenceNumber,
        receiptNumber: 'R1', buyer: { contact: { email: 'payer@maya.test' } } }]);
      return send(200, { checkoutId: id, redirectUrl: body.redirectUrl.success });
    }
    const match = req.url.match(/^\/payments\/v1\/payment-rrns\/(.+)$/);
    if (match) {
      mayaReads.push({ ref: decodeURIComponent(match[1]), key });
      if (key !== 'sk-check-secret') return send(401, { code: 'K004' });
      const list = mayaPayments.get(decodeURIComponent(match[1]));
      return list ? send(200, list) : send(404, { code: 'PY0009' });
    }
    send(404, {});
  });
});

await new Promise(resolve => supabase.listen(SB_PORT, '127.0.0.1', resolve));
await new Promise(resolve => mayaServer.listen(MY_PORT, '127.0.0.1', resolve));
await new Promise(resolve => paypal.listen(PP_PORT, '127.0.0.1', resolve));
try { execSync(`fuser -k ${APP_PORT}/tcp`, { stdio: 'ignore' }); } catch {}
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  stdio: 'ignore', detached: true,
  env: {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_billingcheck0000',
    PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_API_BASE: `http://127.0.0.1:${PP_PORT}`,
    PAYMENT_RECORDER_SECRET: SECRET, FURNISHAR_JWT_SECRET: 'billing-check', SITE_URL: APP,
    PAYPAL_PARTNER_MERCHANT_ID: 'PARTNER1', PAYPAL_ENV: '', PAYPAL_FEE_MODE: '', PAYPAL_WEBHOOK_ID: '',
    MAYA_PUBLIC_KEY: 'pk-check-public', MAYA_SECRET_KEY: 'sk-check-secret', MAYA_API_BASE: `http://127.0.0.1:${MY_PORT}`,
    MAYA_ENV: '', MAYA_PAYFAC_ENABLED: '', MAYA_FEE_MODE: '', MAYA_WEBHOOK_ALLOWED_IPS: ''
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
  check('PayPal is sandbox by default, and the fee mode is accrual', config.sandbox === true && config.environment === 'sandbox' && config.feeMode === 'accrual');
  const adminConfig = await fetch(`${APP}/api/sb/payments/admin`, { headers: { Authorization: 'Bearer tok-buyer' } });
  check('the PayPal configuration report is for admins only', adminConfig.status === 403, String(adminConfig.status));

  console.log('--- a shop that has not connected PayPal offers no checkout ---');
  const early = await page(null);
  await early.goto(`${APP}/furniture/billing-check-stool`);
  await early.locator('.purchase-panel').waitFor({ timeout: 15000 }).catch(() => {});
  check('it says the shop is finishing its payment setup', /finishing its payment setup/.test(await early.locator('.purchase-panel').innerText().catch(() => '')));
  check('and there is no Buy button', await early.getByRole('button', { name: 'Buy with PayPal' }).count() === 0);

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
  const checkout = buyer.locator('dialog.request-dialog[open]');
  await checkout.waitFor({ timeout: 10000 });
  check('checkout asks how the buyer gets it', await checkout.getByText('Free delivery').first().isVisible());
  await checkout.locator('input[name="address"]').fill('Purok 3, Brgy. Poblacion');
  await checkout.locator('select[name="municipality"]').selectOption('Mamburao');
  await checkout.locator('input[name="phone"]').fill('0917 123 4567');
  await shot(buyer, 'checkout-dialog');
  check('checkout says who is signed in', /Signed in as tok-buyer@test\.ph/.test(await checkout.innerText()));
  check('checkout carries the sandbox marker', /PayPal Sandbox/i.test(await checkout.innerText()));
  await checkout.getByRole('button', { name: 'Continue to PayPal' }).click();
  await buyer.waitForURL(/\/account/, { timeout: 20000 }).catch(async () => {
    console.log('  (still on', buyer.url(), '—', (await buyer.locator('[role="alert"], [role="status"]').allInnerTexts()).join(' | '), ')');
  });
  await buyer.locator('.order-status', { hasText: 'Paid' }).first().waitFor({ timeout: 20000 }).catch(() => {});
  const created = paypalCreated[0]?.purchase_units?.[0];
  check('PayPal was asked for the database amount', created?.amount?.value === '2200.00', created?.amount?.value);
  check('payable to the shop\'s connected merchant id, not FurnishAR', created?.payee?.merchant_id === 'STOCKMERCHANT1', JSON.stringify(created?.payee));
  check('no platform split is claimed in accrual mode', created?.payment_instruction === undefined);
  check('the attempt was recorded with the server secret before PayPal', serverCalls.some(c => c.fn === 'server_record_payment_attempt' && c.body.p_secret === SECRET));
  check('the capture was recorded with the server secret', recorded.at(-1)?.p_secret === SECRET);
  await shot(buyer, 'account-orders');
  check('the order shows as paid', await buyer.locator('.order-status', { hasText: 'Paid' }).first().isVisible());
  check('the return address was cleaned', !buyer.url().includes('token='), buyer.url());
  check('the delivery details reached the order', delivered[0]?.p_method === 'delivery'
    && delivered[0]?.p_municipality === 'Mamburao' && delivered[0]?.p_phone === '0917 123 4567', JSON.stringify(delivered[0]));
  check('the order shows its arrival date', /arrives by/.test(await buyer.locator('.order-card').first().innerText()));

  console.log('--- the receipt ---');
  await buyer.getByRole('link', { name: 'View receipt' }).first().click();
  await buyer.locator('.receipt').waitFor({ timeout: 15000 }).catch(() => {});
  const receiptText = await buyer.locator('.receipt').innerText().catch(() => '');
  await shot(buyer, 'receipt');
  check('the receipt itemises price, fee, total and payment',
    /2,000\.00/.test(receiptText) && /200\.00/.test(receiptText) && /2,200\.00/.test(receiptText) && /CAPPPORDER/.test(receiptText),
    receiptText.replace(/\s+/g, ' ').slice(0, 160));
  check('the receipt says where and when', /Purok 3, Brgy\. Poblacion/.test(receiptText) && /Estimated arrival/i.test(receiptText));

  console.log('--- a buyer pays a Maya-only shop through Maya (0015) ---');
  await buyer.goto(`${APP}/furniture/billing-check-lamp`);
  const buyMaya = buyer.getByRole('button', { name: 'Buy with Maya' });
  await buyMaya.waitFor({ timeout: 15000 }).catch(() => {});
  check('a Maya-only shop offers Maya, and not PayPal', await buyMaya.count() === 1
    && await buyer.getByRole('button', { name: /PayPal/ }).count() === 0);
  check('it says FurnishAR receives a Maya payment and pays the shop',
    /FurnishAR receives the payment and pays Maya Shop its share/.test(await buyer.locator('.purchase-panel').innerText().catch(() => '')));
  await buyMaya.click();
  const mayaCheckout = buyer.locator('dialog.request-dialog[open]');
  await mayaCheckout.getByText('Store pickup').click();
  await mayaCheckout.locator('input[name="phone"]').fill('0917 123 4567');
  check('the dialog names Maya and its sandbox', /Maya Sandbox/i.test(await mayaCheckout.innerText()));
  await shot(buyer, 'checkout-maya');
  await mayaCheckout.getByRole('button', { name: 'Continue to Maya' }).click();
  await buyer.waitForURL(/\/account\/payment\/return/, { timeout: 20000 }).catch(() => {});
  await buyer.locator('h1', { hasText: /Payment received|couldn|Nothing|Sign in/ }).waitFor({ timeout: 20000 }).catch(() => {});
  const mayaCreated = mayaCheckouts.at(-1);
  check('Maya was asked with the PUBLIC key for the database amount', mayaCreated?.key === 'pk-check-public'
    && mayaCreated?.body?.totalAmount?.value === 1100, JSON.stringify(mayaCreated?.body?.totalAmount));
  const mayaAttempt = [...attempts.values()].find(a => a.provider === 'maya');
  check('the attempt pays FurnishAR\'s own Maya account, platform collect', mayaAttempt?.payee_merchant_id === 'furnishar-platform'
    && mayaAttempt?.fee_mode === 'platform_collect' && mayaAttempt?.provider_reference === mayaCreated?.body?.requestReferenceNumber,
    JSON.stringify(mayaAttempt));
  check('the return was confirmed by re-reading the payment with the SECRET key',
    mayaReads.length > 0 && mayaReads.every(r => r.key === 'sk-check-secret'));
  const mayaRecord = recorded.filter(r => r.p_provider === 'maya' && !r.duplicate);
  check('the payment was recorded once, as Maya, with the server secret', mayaRecord.length === 1
    && mayaRecord[0].p_secret === SECRET && mayaRecord[0].p_capture === 'MAYAPAY1' && mayaRecord[0].p_amount === 1100,
    JSON.stringify(mayaRecord.map(r => ({ c: r.p_capture, a: r.p_amount }))));
  check('the return page says the payment was received', await buyer.locator('h1', { hasText: 'Payment received' }).count() === 1,
    await buyer.locator('h1').first().innerText().catch(() => ''));
  check('the reference is cleaned from the address', !/ref=/.test(buyer.url()), buyer.url());
  await shot(buyer, 'payment-return-maya');
  await buyer.getByRole('link', { name: 'View receipt' }).click();
  await buyer.locator('.receipt').waitFor({ timeout: 15000 }).catch(() => {});
  const mayaReceipt = await buyer.locator('.receipt').innerText().catch(() => '');
  check('the receipt says Paid via Maya and who received it', /Paid via Maya/.test(mayaReceipt)
    && /Maya payments are received by FurnishAR/.test(mayaReceipt), mayaReceipt.replace(/\s+/g, ' ').slice(0, 200));

  const webhook = body => fetch(`${APP}/api/maya/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const reference = mayaCreated?.body?.requestReferenceNumber;
  const hooked = await webhook({ id: 'MAYAPAY1', status: 'PAYMENT_SUCCESS', requestReferenceNumber: reference });
  const hookedAgain = await webhook({ id: 'MAYAPAY1', status: 'PAYMENT_SUCCESS', requestReferenceNumber: reference });
  check('Maya\'s webhook after the return changes nothing, and a redelivery is a no-op',
    hooked.status === 200 && (await hookedAgain.json()).duplicate === true
    && recorded.filter(r => r.p_provider === 'maya' && !r.duplicate).length === 1);
  const forged = await webhook({ id: 'X', status: 'PAYMENT_SUCCESS', requestReferenceNumber: 'FA-NOT-OURS-1' });
  check('a webhook for a reference FurnishAR never made is ignored', forged.status === 200
    && recorded.filter(r => r.p_provider === 'maya' && !r.duplicate).length === 1);

  await buyer.goto(`${APP}/account/payment/return?provider=maya&ref=REF9-Fdeadbeef&result=cancel`);
  await buyer.locator('h1', { hasText: /cancelled|couldn|Nothing/ }).waitFor({ timeout: 15000 }).catch(() => {});
  check('a cancelled Maya checkout says nothing was charged', /Payment cancelled/.test(await buyer.locator('h1').first().innerText().catch(() => ''))
    && /Nothing was charged/.test(await buyer.locator('.payment-return').innerText().catch(() => '')));

  console.log('--- a buyer requests a custom build ---');
  await buyer.goto(`${APP}/furniture/billing-check-table`);
  check('made-to-order is said, not a stock count', /Made to order/.test(await buyer.locator('.detail-availability').innerText()));
  await buyer.getByRole('button', { name: 'Request a custom build' }).click();
  await buyer.locator('dialog.request-dialog textarea[name="notes"]').fill('Narra, 6 seats');
  await buyer.locator('dialog.request-dialog').getByText('Store pickup').click();
  await buyer.locator('dialog.request-dialog input[name="phone"]').fill('0917 123 4567');
  await shot(buyer, 'custom-request');
  await buyer.getByRole('button', { name: 'Send request' }).click();
  await buyer.locator('text=/Request REQ\\d+ sent/').first().waitFor({ timeout: 10000 }).catch(() => {});
  check('the request is confirmed', await buyer.locator('text=/Request REQ\\d+ sent/').first().isVisible());

  console.log('--- the shop sees it and quotes ---');
  const owner = await page('tok-owner');
  owner.on('pageerror', e => console.log('  (owner pageerror', e.message, ')'));
  owner.on('response', async r => { if (r.url().includes('/api/sb/') && !r.ok()) console.log('  (owner', r.status(), r.url(), ')'); });
  await owner.goto(`${APP}/portal`);
  await owner.locator('#billing-title').waitFor({ timeout: 20000 }).catch(() => {});
  check('billing settings are in the portal', await owner.locator('#billing-title').isVisible());
  check('the fee owed is shown', /200\.00/.test(await owner.locator('.billing-summary').innerText().catch(() => '')));
  const card = owner.locator('.paypal-card');
  check('the PayPal card says not connected', /Not connected/i.test(await card.innerText().catch(() => '')));
  check('the one payment-setup reminder shows', await owner.locator('.payment-reminder').count() === 1);
  await shot(owner, 'portal-paypal-not-connected');
  const merchantField = card.locator('input[name="merchantId"]');
  await merchantField.fill('BADMERCHANT1');
  await card.getByRole('button', { name: 'Verify & Connect' }).click();
  await owner.locator('text=/does not recognise that Merchant ID/').first().waitFor({ timeout: 15000 }).catch(() => {});
  check('an id PayPal refuses is not connected, and the owner is told why',
    await owner.locator('text=/does not recognise that Merchant ID/').first().isVisible()
    && !/Open — buyers can pay you/.test(await card.innerText()));
  await card.locator('.paypal-help summary').click();
  check('the help explains how to get a Merchant ID', /Sign Up[\s\S]*Business account[\s\S]*Merchant ID/i.test(await card.locator('.paypal-help').innerText()));
  if (process.env.SHOTS) await card.screenshot({ path: `${process.env.SHOTS}/paypal-card-refused.png` });
  await merchantField.fill('stockmerchant1');
  await card.getByRole('button', { name: 'Verify & Connect' }).click();
  await owner.locator('.paypal-card .status-chip.is-success').waitFor({ timeout: 20000 }).catch(() => {});
  const connectedText = await owner.locator('.paypal-card').innerText().catch(() => '');
  check('PayPal was asked to accept the Merchant ID as a payee, for ₱1.00',
    verifyOrders.at(-1)?.purchase_units?.[0]?.payee?.merchant_id === 'STOCKMERCHANT1'
    && verifyOrders.at(-1)?.purchase_units?.[0]?.amount?.value === '1.00', JSON.stringify(verifyOrders.at(-1)?.purchase_units?.[0]?.payee));
  check('the owner was checked by the database before PayPal', serverCalls.some(c => c.fn === 'server_payment_onboarding_started'));
  check('after PayPal accepted it, the store is Connected', /connected/i.test(connectedText) && !/not connected/i.test(connectedText), connectedText.replace(/\s+/g, ' ').slice(0, 160));
  check('the merchant id is masked', /•+ANT1/.test(connectedText) && !connectedText.includes('STOCKMERCHANT1'));
  check('checkout is shown as open', /Open — buyers can pay you/.test(connectedText));
  check('the reminder is gone once connected', await owner.locator('.payment-reminder').count() === 0);
  if (process.env.SHOTS) await owner.locator('.paypal-card').screenshot({ path: `${process.env.SHOTS}/paypal-card-connected.png` });
  await owner.goto(`${APP}/portal`);
  await owner.locator('#billing-title').waitFor({ timeout: 20000 }).catch(() => {});
  await shot(owner, 'portal-orders');
  await owner.getByRole('button', { name: 'Send quote' }).first().click();
  await owner.locator('.order-quote input[name="price"]').fill('5000');
  await owner.locator('.order-quote input[name="leadDays"]').fill('14');
  await shot(owner, 'portal-quote');
  await owner.locator('.order-quote button[type="submit"]').click();
  await owner.locator('.order-status', { hasText: 'Quote ready' }).first().waitFor({ timeout: 10000 }).catch(() => {});
  check('the quote is sent', await owner.locator('.order-status', { hasText: 'Quote ready' }).first().isVisible());

  console.log('--- the shop sends it out ---');
  await owner.getByRole('button', { name: 'Out for delivery' }).first().click();
  await owner.locator('.order-status', { hasText: 'Out for delivery' }).first().waitFor({ timeout: 10000 }).catch(() => {});
  check('the order is out for delivery', await owner.locator('.order-status', { hasText: 'Out for delivery' }).first().isVisible());
  await owner.getByRole('button', { name: 'Mark delivered' }).first().click();
  // A delivered order is closed, so it moves under "Past orders", folded
  // away below the open ones; open that to find it.
  await owner.locator('details.orders-past > summary').waitFor({ timeout: 10000 }).catch(() => {});
  check('a delivered order moves to Past orders', await owner.locator('details.orders-past > summary').isVisible());
  await owner.locator('details.orders-past > summary').click().catch(() => {});
  await owner.locator('.orders-past .order-status', { hasText: 'Delivered' }).first().waitFor({ timeout: 10000 }).catch(() => {});
  check('and then delivered', await owner.locator('.orders-past .order-status', { hasText: 'Delivered' }).first().isVisible());

  console.log('--- a new Google account signs in and becomes a buyer ---');
  const newbie = await page(null);
  newbie.on('response', async r => { if (r.url().includes('/api/sb/') && !r.ok()) console.log('  (newbie', r.status(), r.url(), await r.text().catch(() => ''), ')'); });
  newbie.on('pageerror', e => console.log('  (newbie pageerror', e.message, ')'));
  await newbie.goto(`${APP}/login?as=buyer&next=${encodeURIComponent('/furniture/billing-check-chair')}`);
  await newbie.getByRole('link', { name: 'Continue with Google' }).click();
  await newbie.waitForURL(/\/onboarding/, { timeout: 20000 }).catch(() => {});
  check('a first Google sign-in lands on onboarding', /\/onboarding\?as=buyer/.test(newbie.url()), newbie.url());
  const stored = await newbie.evaluate(() => sessionStorage.getItem('furnishar-sb-session') || '');
  check('Google\'s own token never reaches the browser', stored.includes('tok-newbie') && !stored.includes('GOOGLE-SECRET-TOKEN'));
  await newbie.locator('select[name="municipality"]').waitFor({ timeout: 10000 }).catch(() => {});
  check('only the municipality is asked; the name comes from Google', /Nina Gomez/.test(await newbie.locator('.login-form').innerText().catch(() => ''))
    && await newbie.locator('input[name="password"]').count() === 0);
  await shot(newbie, 'onboarding-buyer');
  await newbie.locator('select[name="municipality"]').selectOption('Sablayan');
  await newbie.getByRole('button', { name: 'Start shopping' }).click();
  await newbie.waitForURL(/\/furniture\/billing-check-chair$/, { timeout: 20000 }).catch(async () => {
    console.log('  (onboarding stayed:', (await newbie.locator('.login-form').innerText().catch(() => '')).replace(/\s+/g, ' '), ')');
  });
  check('and returns to the piece they were looking at', /\/furniture\/billing-check-chair/.test(newbie.url()), newbie.url());
  const replay = await fetch(`${APP}/api/sb/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'google-code-12345' }) });
  check('the code cannot be exchanged without the flow cookie', replay.status === 400 && (await replay.json()).code === 'state_missing');

  console.log('--- the admin sees the fee mode truthfully ---');
  const admin = await page('tok-admin');
  await admin.goto(`${APP}/admin/billing`);
  await admin.locator('.fee-mode h2', { hasText: /Accrual|Platform split|Could not/ }).waitFor({ timeout: 20000 }).catch(() => {});
  await admin.locator('tbody tr', { hasText: 'Unconnected Shop' }).waitFor({ timeout: 20000 }).catch(() => {});
  const adminText = await admin.locator('body').innerText().catch(() => '');
  check('admin billing names accrual as the mode in force', /Accrual — shops settle the fee/.test(adminText));
  check('and never calls an accrued fee collected', /\bCollected\s*₱0\.00/i.test(adminText));
  check('the PayPal sandbox marker is visible to the admin', /PayPal Sandbox/i.test(adminText));
  check('each shop\'s PayPal status is listed', /Not connected/i.test(adminText) && /(^|[^t] )connected/im.test(adminText));
  check('Maya\'s configuration is stated: FurnishAR collects, sandbox, no PayFac claimed',
    /Configured · FurnishAR collects/i.test(adminText) && /Maya Sandbox/i.test(adminText) && /Payment Facilitator is not enabled/.test(adminText),
    adminText.match(/Maya[^\n]*\n[^\n]*\n[^\n]*/)?.[0]?.replace(/\s+/g, ' '));
  check('the table can be filtered by payment method', await admin.locator('.mode-switch button').count() === 3);
  await admin.getByRole('button', { name: 'Maya', exact: true }).click();
  check('filtering to Maya shows no PayPal-only shop', await admin.locator('tbody tr', { hasText: 'Stock Shop' }).count() === 0);
  check('an admin can open Maya setup for a store', await admin.getByRole('button', { name: 'All Stores' }).click().then(
    () => admin.getByRole('button', { name: /Maya setup for Stock Shop/ }).count()) === 1);
  await shot(admin, 'admin-billing');
} finally {
  await browser.close();
  try { process.kill(-app.pid); } catch {}
  supabase.close();
  paypal.close();
  mayaServer.close();
}

console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall billing checks passed');
process.exit(problems.length ? 1 : 0);
