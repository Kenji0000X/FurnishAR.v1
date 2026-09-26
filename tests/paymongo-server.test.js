/**
 * GCash via PayMongo on the server — lib/money.js, lib/paymongo.js,
 * lib/providers, lib/orders.js (checkout / verify / refund) and
 * lib/paymongo-webhook.js — against a fake Supabase and a fake PayMongo.
 *
 * The rules pinned down: the browser names a payment method, never a price
 * or a payee; amounts go to PayMongo in centavos, converted in ONE place; the
 * Checkout Session is created and read back with the SECRET key, which never
 * appears in anything the browser can see; neither the return URL nor a
 * webhook body is believed — only the session re-read from PayMongo is
 * recorded; a webhook is verified (signature, timestamp, mode) and processed
 * once; refunds are admin-only; PayPal keeps working unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test000000000000000';
process.env.PAYPAL_CLIENT_ID = 'client-id';
process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
process.env.PAYMENT_RECORDER_SECRET = 'x'.repeat(40);
const SECRET_KEY = 'sk_test_unitsecret0000000000';
const WEBHOOK_SECRET = 'whsk_unitwebhook000000000000';
function baseEnv() {
  process.env.PAYMONGO_SECRET_KEY = SECRET_KEY;
  process.env.PAYMONGO_PUBLIC_KEY = 'pk_test_unitpublic0000000000';
  process.env.PAYMONGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.PAYMONGO_GCASH_ENABLED = 'true';
  for (const name of ['PAYMONGO_ENV', 'PAYMONGO_SPLIT_MODE', 'PAYMONGO_API_BASE', 'PAYPAL_ENV', 'PAYPAL_FEE_MODE',
    'RESEND_API_KEY', 'GMAIL_USER']) delete process.env[name];
}
baseEnv();

const { handleOrders, billingConfig } = require('../lib/orders.js');
const { handlePaymongoWebhook } = require('../lib/paymongo-webhook.js');
const paymongo = require('../lib/paymongo.js');
const providers = require('../lib/providers/index.js');
const { phpToCentavos, centavosToPhp } = require('../lib/money.js');
const { messagesFor } = require('../lib/notify.js');

const ORDER = '11111111-2222-4333-8444-555555555555';
const PRODUCT = '99999999-2222-4333-8444-555555555555';
const STORE = '77777777-2222-4333-8444-555555555555';
const req = { method: 'POST', headers: { authorization: 'Bearer user-jwt' } };
const SITE = 'https://furnishar.test';
const API = 'https://api.paymongo.com';
const basic = key => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;

let calls;
let due;
let attempt;
let session;
let owns;
let claimed;
let admin;
let storeProviders;
let schema0016;
let refundStatus;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const find = part => calls.find(c => c.url.includes(part));
const all = part => calls.filter(c => c.url.includes(part));

function paidSession(overrides = {}) {
  return {
    id: 'cs_unit000001', type: 'checkout_session',
    attributes: {
      reference_number: 'ABC123-Fdeadbeef', status: 'active', metadata: { reference: 'ABC123-Fdeadbeef' },
      payments: [{ id: 'pay_unit000001', type: 'payment', attributes: {
        amount: 1100000, fee: 27500, net_amount: 1072500, currency: 'PHP', status: 'paid', livemode: false,
        source: { type: 'gcash' }, billing: { email: 'payer@gcash.ph' }, ...overrides } }]
    }
  };
}

test.beforeEach(() => {
  baseEnv();
  calls = [];
  owns = true;
  claimed = true;
  admin = false;
  refundStatus = 'succeeded';
  storeProviders = ['paypal', 'paymongo'];
  schema0016 = true;
  // ₱10,000 piece + ₱1,000 fee = ₱11,000, as begin_payment says.
  due = { order_id: ORDER, reference: 'ABC123', stage: 'full', amount: 11000, currency: 'PHP', platform_fee: 1000,
          provider: 'paymongo', settlement_mode: 'platform', provider_account_ref: null,
          merchant_id: null, store_name: 'Shop', product_name: 'Sofa' };
  attempt = { order_id: ORDER, stage: 'full', amount: 11000, currency: 'PHP', platform_fee: 1000, fee_mode: 'platform_held',
              payee_merchant_id: 'furnishar-paymongo', environment: 'sandbox', provider: 'paymongo',
              provider_order_id: 'cs_unit000001', provider_reference: 'ABC123-Fdeadbeef', payment_method: 'gcash' };
  session = paidSession();
  global.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' && options.body.startsWith('{') ? JSON.parse(options.body) : options.body;
    calls.push({ url: String(url), method: options.method || 'GET', body, headers: options.headers || {} });
    const u = String(url);
    if (u.endsWith('/auth/v1/user')) return reply(200, { id: 'user-1', email: 'buyer@x.ph' });
    if (u.includes('/rest/v1/rpc/is_platform_admin')) return reply(200, admin);
    if (u.includes('/rest/v1/rpc/begin_payment')) return reply(200, due);
    if (u.includes('/rest/v1/rpc/create_stock_order')) return reply(200, { order_id: ORDER, reference: 'ABC123' });
    if (u.includes('/rest/v1/rpc/cancel_order')) return reply(200, { status: 'cancelled' });
    if (u.includes('/rest/v1/rpc/server_record_payment_attempt')) return reply(200, { ok: true });
    if (u.includes('/rest/v1/rpc/server_payment_attempt_by_reference')) return reply(200, attempt);
    if (u.includes('/rest/v1/rpc/server_payment_attempt')) return reply(200, attempt);
    if (u.includes('/rest/v1/rpc/server_update_payment_attempt')) return reply(200, { ok: true });
    if (u.includes('/rest/v1/rpc/server_claim_webhook_event')) return reply(200, claimed);
    if (u.includes('/rest/v1/rpc/server_finish_webhook_event')) return reply(200, null);
    if (u.includes('/rest/v1/rpc/server_admin_emails')) return reply(200, ['admin@furnishar.ph']);
    if (u.includes('/rest/v1/rpc/server_record_refund')) {
      return reply(200, { completed: true, order_id: ORDER, amount: body.p_amount, platform_fee_refunded: 0 });
    }
    if (u.includes('/rest/v1/rpc/store_payment_providers')) {
      return schema0016 ? reply(200, storeProviders)
        : reply(404, { code: 'PGRST202', message: 'Could not find the function public.store_payment_providers' });
    }
    if (u.includes('/rest/v1/rpc/store_accepts_payments')) return reply(200, true);
    if (u.includes('/v1/oauth2/token')) return reply(200, { access_token: 'pp-token', expires_in: 3600 });
    if (u.endsWith('/v2/checkout/orders') && options.method === 'POST') {
      return reply(201, { id: 'PAYPALORDER123', links: [{ rel: 'payer-action', href: 'https://paypal.test/approve' }] });
    }
    if (u.includes('/rest/v1/rpc/record_capture')) {
      const applied = phpToCentavos(String(body.p_amount)) === 1100000;
      return reply(200, { order_id: ORDER, status: applied ? 'paid' : 'pending_payment', applied, duplicate: false,
                          platform_fee: applied ? 1000 : 0, fee_mode: 'platform_held', provider: 'paymongo' });
    }
    if (u.includes('/rest/v1/rpc/order_contacts') || u.includes('/rest/v1/rpc/server_order_contacts')) {
      return reply(200, { reference: 'ABC123', buyer_email: 'b@x.ph', store_emails: ['s@x.ph'], payments: [] });
    }
    if (u.includes('/rest/v1/orders?id=eq.')) return reply(200, owns ? [{ id: ORDER }] : []);
    if (u.includes('/rest/v1/payments?capture_id=eq.')) {
      return reply(200, admin ? [{ capture_id: 'pay_unit000001', amount: '11000.00', refunded_amount: '0.00', currency: 'PHP', order_id: ORDER }] : []);
    }
    if (u === `${API}/v1/checkout_sessions` && options.method === 'POST') {
      return reply(200, { data: { id: 'cs_unit000001', type: 'checkout_session',
        attributes: { checkout_url: 'https://checkout.paymongo.com/cs_unit000001' } } });
    }
    if (u === `${API}/v1/checkout_sessions/cs_unit000001`) return reply(200, { data: session });
    if (u === `${API}/v1/refunds` && options.method === 'POST') {
      return reply(200, { data: { id: 'ref_unit000001', type: 'refund', attributes: {
        amount: body.data.attributes.amount, payment_id: body.data.attributes.payment_id, currency: 'PHP', status: refundStatus } } });
    }
    return reply(404, {});
  };
});

/* ---------------------------------------------------------------- money --- */

test('money: ₱10,000 → subtotal 10000.00, fee 1000.00, total 11000.00 → 1100000 centavos', () => {
  const subtotal = phpToCentavos('10000');
  const fee = subtotal / 10;
  assert.equal(centavosToPhp(subtotal), '10000.00');
  assert.equal(centavosToPhp(fee), '1000.00');
  assert.equal(centavosToPhp(subtotal + fee), '11000.00');
  assert.equal(phpToCentavos('11000.00'), 1100000);
  assert.equal(phpToCentavos(11000), 1100000);
});

test('money: exact for awkward values, and refuses what is not an amount', () => {
  assert.equal(phpToCentavos('0.1'), 10);
  assert.equal(phpToCentavos(0.29), 29);            // 0.29 * 100 is 28.999… in floating point
  assert.equal(phpToCentavos(1234.5), 123450);
  assert.equal(phpToCentavos('499.00'), 49900);     // PayMongo's own example
  assert.equal(centavosToPhp(5), '0.05');
  assert.equal(centavosToPhp(-150), '-1.50');
  for (const bad of ['', 'abc', '1.234', '1e3', null, undefined, '₱100']) {
    assert.throws(() => phpToCentavos(bad), TypeError, String(bad));
  }
  assert.throws(() => centavosToPhp(1.5), TypeError);
});

/* --------------------------------------------------------------- config --- */

test('config: missing keys mean GCash is not offered, and the problems are named', () => {
  delete process.env.PAYMONGO_SECRET_KEY;
  delete process.env.PAYMONGO_WEBHOOK_SECRET;
  const config = paymongo.validateConfig();
  assert.equal(config.configured, false);
  assert.equal(config.gcashEnabled, false);
  assert.ok(config.problems.some(p => /PAYMONGO_SECRET_KEY is not set/.test(p)));
  assert.ok(config.problems.some(p => /PAYMONGO_WEBHOOK_SECRET/.test(p)));
  assert.equal(paymongo.isReady(), false);
  assert.deepEqual(billingConfig().providers.map(p => p.id), ['paypal']);
});

test('config: test mode by default; anything but an explicit "live" stays test', () => {
  let config = paymongo.validateConfig();
  assert.equal(config.mode, 'test');
  assert.equal(config.env, 'sandbox');
  assert.equal(config.sandbox, true);
  assert.equal(config.gcashEnabled, true);
  assert.equal(config.splitMode, 'disabled');
  process.env.PAYMONGO_ENV = 'production';
  config = paymongo.validateConfig();
  assert.equal(config.mode, 'test');
  assert.ok(config.problems.some(p => /PAYMONGO_ENV/.test(p)));
});

test('config: wrong or mismatched keys are refused, and no key is ever echoed', () => {
  process.env.PAYMONGO_SECRET_KEY = 'pk_test_notasecret000000';
  let config = paymongo.validateConfig();
  assert.equal(config.configured, false);
  assert.ok(config.problems.some(p => /holds a public key/.test(p)));

  process.env.PAYMONGO_SECRET_KEY = 'sk_live_fakeunittest0000';   // a live key while in test mode
  config = paymongo.validateConfig();
  assert.equal(config.configured, false);
  assert.ok(config.problems.some(p => /not a test secret key/.test(p)));

  process.env.PAYMONGO_ENV = 'live';                               // test keys in live mode
  process.env.PAYMONGO_SECRET_KEY = SECRET_KEY;
  config = paymongo.validateConfig();
  assert.equal(config.configured, false);
  assert.ok(config.problems.some(p => /not a live secret key/.test(p)));
  const text = JSON.stringify({ config, admin: billingConfig({ admin: true }) });
  for (const secret of [SECRET_KEY, 'sk_live_fakeunittest0000', WEBHOOK_SECRET]) assert.ok(!text.includes(secret));
});

test('config: GCash not activated means not offered; split mode is validated', () => {
  process.env.PAYMONGO_GCASH_ENABLED = 'false';
  assert.equal(paymongo.validateConfig().gcashEnabled, false);
  assert.ok(paymongo.validateConfig().warnings.some(w => /PAYMONGO_GCASH_ENABLED/.test(w)));
  assert.deepEqual(billingConfig().providers.map(p => p.id), ['paypal']);
  process.env.PAYMONGO_GCASH_ENABLED = 'true';
  process.env.PAYMONGO_SPLIT_MODE = 'everything';
  assert.equal(paymongo.validateConfig().splitMode, 'disabled');
  process.env.PAYMONGO_SPLIT_MODE = 'split';
  assert.equal(paymongo.validateConfig().splitEnabled, true);
});

test('config: the API base can only be overridden to a local stand-in', () => {
  process.env.PAYMONGO_API_BASE = 'https://evil.example';
  assert.equal(paymongo.credentials().base, API);
  process.env.PAYMONGO_API_BASE = 'http://127.0.0.1:4799';
  assert.equal(paymongo.credentials().base, 'http://127.0.0.1:4799');
});

test('the browser learns only safe booleans about PayMongo', () => {
  const summary = billingConfig().providers.find(p => p.id === 'paymongo');
  assert.deepEqual(Object.keys(summary).sort(),
    ['environment', 'gcashEnabled', 'id', 'label', 'method', 'sandbox', 'splitEnabled']);
  assert.equal(summary.label, 'GCash');
  assert.equal(summary.method, 'gcash');
  assert.ok(!JSON.stringify(billingConfig()).match(/sk_|whsk_|pk_/));
});

/* ------------------------------------------------------------- checkout --- */

test('checkout with GCash: a Checkout Session for the DATABASE amount in centavos, secret key, gcash only', async () => {
  const result = await handleOrders(req, 'checkout', {
    productId: PRODUCT, quantity: 1, provider: 'paymongo', price: 1, total: 1, amount: 1, payee: 'EVIL', feeMode: 'accrual'
  }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.provider, 'paymongo');
  assert.equal(result.body.approveUrl, 'https://checkout.paymongo.com/cs_unit000001');
  assert.equal(find('begin_payment').body.p_provider, 'paymongo');

  const call = find('/v1/checkout_sessions');
  assert.equal(call.headers.Authorization, basic(SECRET_KEY));
  const a = call.body.data.attributes;
  assert.deepEqual(a.payment_method_types, ['gcash']);
  assert.deepEqual(a.line_items, [
    { name: 'Sofa', amount: 1000000, currency: 'PHP', quantity: 1 },
    { name: 'FurnishAR service fee (10%)', amount: 100000, currency: 'PHP', quantity: 1 }
  ]);
  assert.equal(a.line_items.reduce((sum, line) => sum + line.amount, 0), 1100000);
  assert.match(a.reference_number, /^ABC123-F[0-9a-f]{8}$/);
  assert.equal(a.success_url, `${SITE}/account/payment/return?provider=paymongo&ref=${a.reference_number}&result=success`);
  assert.equal(a.cancel_url, `${SITE}/account/payment/return?provider=paymongo&ref=${a.reference_number}&result=cancel`);
  assert.equal(a.metadata.reference, a.reference_number);
  assert.equal(a.metadata.order_id, ORDER);
  assert.ok(!('split_payment' in a));

  const recorded = find('server_record_payment_attempt').body;
  assert.equal(recorded.p_provider, 'paymongo');
  assert.equal(recorded.p_method, 'gcash');
  assert.equal(recorded.p_merchant, 'furnishar-paymongo');
  assert.equal(recorded.p_fee_mode, 'platform_held');
  assert.equal(recorded.p_provider_order, 'cs_unit000001');
  assert.equal(recorded.p_reference, a.reference_number);
  assert.equal(recorded.p_amount, 11000);
  assert.equal(recorded.p_platform_fee, 1000);
  // Nothing about the browser's figures reached PayMongo or the database.
  assert.ok(!JSON.stringify(calls.map(c => c.body)).includes('EVIL'));
});

test('an unknown payment method (even "gcash" or "maya") is refused before any order is created', async () => {
  for (const provider of ['gcash', 'maya']) {
    calls = [];
    const result = await handleOrders(req, 'checkout', { productId: PRODUCT, provider }, SITE);
    assert.equal(result.status, 400, provider);
    assert.ok(!find('create_stock_order'));
  }
  assert.throws(() => providers.get('maya'), /Unknown payment method/);
});

test('split settlement is refused unless PAYMONGO_SPLIT_MODE=split, and the stock is released', async () => {
  due.settlement_mode = 'split';
  due.provider_account_ref = 'org_child000001';
  const result = await handleOrders(req, 'checkout', { productId: PRODUCT, provider: 'paymongo' }, SITE);
  assert.equal(result.status, 409);
  assert.ok(find('cancel_order'));
  assert.ok(!find('/v1/checkout_sessions'));
});

test('split, once activated, sends the child merchant its product share and expects the fee', async () => {
  process.env.PAYMONGO_SPLIT_MODE = 'split';
  due.settlement_mode = 'split';
  due.provider_account_ref = 'org_child000001';
  const result = await handleOrders(req, 'pay', { orderId: ORDER, provider: 'paymongo' }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const split = find('/v1/checkout_sessions').body.data.attributes.split_payment;
  assert.deepEqual(split, { recipients: [{ merchant_id: 'org_child000001', split_type: 'fixed', value: 1000000 }] });
  const recorded = find('server_record_payment_attempt').body;
  assert.equal(recorded.p_merchant, 'org_child000001');
  assert.equal(recorded.p_fee_mode, 'provider_split');
});

test('a custom order\'s deposit and balance are each charged exactly what the database says is due', async () => {
  for (const [stage, amount, fee, code] of [['deposit', 5500, 500, 'D'], ['balance', 5500, 500, 'B']]) {
    calls = [];
    due = { ...due, stage, amount, platform_fee: fee, product_name: 'Custom table' };
    const result = await handleOrders(req, 'pay', { orderId: ORDER, provider: 'paymongo' }, SITE);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const a = find('/v1/checkout_sessions').body.data.attributes;
    assert.equal(a.line_items.reduce((sum, line) => sum + line.amount, 0), phpToCentavos(amount));
    assert.equal(a.line_items[1].amount, phpToCentavos(fee));
    assert.match(a.reference_number, new RegExp(`^ABC123-${code}[0-9a-f]{8}$`));
  }
});

test('a PayMongo outage leaves nothing recorded and says so plainly', async () => {
  const original = global.fetch;
  global.fetch = async (url, options) => (String(url).startsWith(API) ? reply(500, { errors: [{ code: 'server_error' }] }) : original(url, options));
  const result = await handleOrders(req, 'pay', { orderId: ORDER, provider: 'paymongo' }, SITE);
  assert.equal(result.status, 502);
  assert.match(result.body.error, /GCash couldn't start the payment/);
  assert.ok(!find('server_record_payment_attempt'));
});

/* --------------------------------------------------------------- verify --- */

test('the buyer\'s return is verified by re-reading the session with the secret key, and recorded once', async () => {
  const result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, 'paid');
  assert.equal(result.body.method, 'gcash');
  const capture = find('record_capture').body;
  assert.equal(capture.p_provider, 'paymongo');
  assert.equal(capture.p_capture, 'pay_unit000001');
  assert.equal(capture.p_provider_order, 'cs_unit000001');
  assert.equal(capture.p_amount, '11000.00');                 // PayMongo's figure, not the browser's
  assert.equal(capture.p_processing_fee, '275.00');
  assert.equal(capture.p_payee_merchant, 'furnishar-paymongo');
  assert.equal(capture.p_fee_mode, 'platform_held');
  assert.equal(capture.p_secret, 'x'.repeat(40));
  assert.equal(all('record_capture').length, 1);
  assert.equal(find('/v1/checkout_sessions/cs_unit000001').headers.Authorization, basic(SECRET_KEY));
});

test('pending, failed and cancelled GCash payments are never recorded as paid', async () => {
  session = paidSession({ status: 'pending' });
  let result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'pending');
  assert.ok(!find('record_capture'));

  calls = [];
  session = paidSession({ status: 'failed' });
  result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'failed');
  assert.ok(!find('record_capture'));
  assert.equal(find('server_update_payment_attempt').body.p_status, 'DECLINED');

  calls = [];
  session = { ...paidSession(), attributes: { ...paidSession().attributes, status: 'expired', payments: [] } };
  result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'cancelled');
  assert.ok(!find('record_capture'));
  assert.equal(find('server_update_payment_attempt').body.p_status, 'CANCELLED');
});

test('a GCash payment for another amount is recorded as PayMongo reports it, and not applied', async () => {
  session = paidSession({ amount: 10000 });
  const result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'unapplied');
  assert.equal(find('record_capture').body.p_amount, '100.00');
});

test('a paid payment in another currency is not recorded; admins are told', async () => {
  session = paidSession({ currency: 'USD' });
  const result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'mismatch');
  assert.ok(!find('record_capture'));
  assert.ok(find('server_admin_emails'));
});

test('a session that is not the attempt\'s is never believed', async () => {
  session = { ...paidSession(), id: 'cs_someoneelse1' };
  const result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'cancelled');
  assert.ok(!find('record_capture'));
});

test('someone else\'s reference is not answered, and PayMongo is not asked', async () => {
  owns = false;
  const result = await handleOrders(req, 'verify', { provider: 'paymongo', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.status, 404);
  assert.ok(!find('record_capture'));
  assert.ok(!find('/v1/checkout_sessions'));
});

test('a malformed reference, or verify for PayPal, is refused without asking PayMongo', async () => {
  for (const reference of ['', '../x', 'a'.repeat(80)]) {
    const result = await handleOrders(req, 'verify', { provider: 'paymongo', reference }, SITE);
    assert.equal(result.status, 400, reference);
  }
  const paypal = await handleOrders(req, 'verify', { provider: 'paypal', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(paypal.status, 400);
  assert.ok(!find('/v1/checkout_sessions'));
});

/* -------------------------------------------------------------- webhook --- */

function event(id, type, data, livemode = false) {
  return JSON.stringify({ data: { id, type: 'event', attributes: { type, livemode, data } } });
}
function sign(body, { secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000), live = false } = {}) {
  const sig = crypto.createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return { 'paymongo-signature': live ? `t=${at},te=,li=${sig}` : `t=${at},te=${sig},li=` };
}
const paidEvent = (id = 'evt_unit000001') => event(id, 'checkout_session.payment.paid',
  { id: 'cs_unit000001', type: 'checkout_session', attributes: { reference_number: 'ABC123-Fdeadbeef' } });

test('webhook: a valid signed event is only a prompt — the session is re-read and recorded once', async () => {
  const body = paidEvent();
  const first = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body.outcome, /recorded \(paid\)/);
  assert.equal(all('record_capture').length, 1);
  assert.equal(find('record_capture').headers.Authorization, undefined);   // no user token on a webhook
  assert.equal(find('server_claim_webhook_event').body.p_event_id, 'paymongo:evt_unit000001');
  assert.ok(find('/v1/checkout_sessions/cs_unit000001'));
});

test('webhook: a body claiming payment is not believed when PayMongo says otherwise', async () => {
  session = paidSession({ status: 'failed' });
  const body = paidEvent();
  const result = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, 'failed');
  assert.ok(!find('record_capture'));
});

test('webhook: a redelivery is a no-op', async () => {
  claimed = false;
  const body = paidEvent();
  const again = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.deepEqual(again.body, { duplicate: true });
  assert.ok(!find('record_capture'));
  assert.ok(!find('/v1/checkout_sessions'));
});

test('webhook: a bad, missing, stale or wrong-mode signature is refused before anything is read', async () => {
  const body = paidEvent();
  for (const headers of [
    sign(body, { secret: 'whsk_wrong' }),
    {},
    sign(body, { at: Math.floor(Date.now() / 1000) - 3600 }),
    sign(body, { live: true }),                         // signed only as live, while this server is in test mode
    sign(`${body} `)                                    // the body was altered after signing
  ]) {
    calls = [];
    const result = await handlePaymongoWebhook(headers, body, SITE);
    assert.equal(result.status, 400, JSON.stringify(headers));
    assert.equal(calls.length, 0);
  }
});

test('webhook: a live-mode event never settles a test-mode server', async () => {
  const body = event('evt_live000001', 'checkout_session.payment.paid', { id: 'cs_unit000001', type: 'checkout_session' }, true);
  const result = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.equal(result.status, 200);
  assert.equal(result.body.ignored, 'other mode');
  assert.equal(calls.length, 0);
});

test('webhook: events naming no FurnishAR payment, and non-JSON, do nothing', async () => {
  attempt = null;
  const body = event('evt_unit000009', 'payment.paid', { id: 'pay_x', type: 'payment', attributes: { metadata: {} } });
  const result = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, 'not a FurnishAR payment');
  assert.ok(!find('record_capture'));
  assert.equal((await handlePaymongoWebhook(sign('not json'), 'not json', SITE)).status, 400);
});

test('webhook: a succeeded refund is recorded once, with PayMongo\'s refund id', async () => {
  const body = event('evt_ref000001', 'payment.refund.updated', { id: 'ref_unit000001', type: 'refund',
    attributes: { amount: 1100000, payment_id: 'pay_unit000001', currency: 'PHP', status: 'succeeded' } });
  const result = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.equal(result.status, 200);
  const refund = find('server_record_refund').body;
  assert.equal(refund.p_capture, 'pay_unit000001');
  assert.equal(refund.p_refund, 'ref_unit000001');
  assert.equal(refund.p_amount, 11000);
  assert.equal(refund.p_secret, 'x'.repeat(40));
});

test('webhook: a pending refund is not recorded yet', async () => {
  const body = event('evt_ref000002', 'payment.refund.updated', { id: 'ref_unit000002', type: 'refund',
    attributes: { amount: 1100000, payment_id: 'pay_unit000001', currency: 'PHP', status: 'pending' } });
  const result = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.equal(result.status, 200);
  assert.ok(!find('server_record_refund'));
});

test('webhook: nothing works until PayMongo is configured', async () => {
  delete process.env.PAYMONGO_WEBHOOK_SECRET;
  const body = paidEvent();
  const result = await handlePaymongoWebhook(sign(body), body, SITE);
  assert.equal(result.status, 503);
  assert.equal(calls.length, 0);
});

/* --------------------------------------------------------------- refund --- */

test('refund: only a platform admin can refund a GCash payment', async () => {
  admin = false;
  const result = await handleOrders(req, 'refund', { paymentId: 'pay_unit000001', amount: '100' }, SITE);
  assert.equal(result.status, 403);
  assert.ok(!find('/v1/refunds'));
});

test('refund: an admin refund goes to PayMongo in centavos and is recorded when it succeeded', async () => {
  admin = true;
  const result = await handleOrders(req, 'refund', { paymentId: 'pay_unit000001', amount: '1000.50', note: 'damaged' }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { refundId: 'ref_unit000001', status: 'succeeded' });
  const call = find('/v1/refunds');
  assert.equal(call.headers.Authorization, basic(SECRET_KEY));
  assert.deepEqual(call.body.data.attributes,
    { amount: 100050, payment_id: 'pay_unit000001', reason: 'requested_by_customer', notes: 'damaged' });
  assert.equal(find('server_record_refund').body.p_refund, 'ref_unit000001');
});

test('refund: a pending refund is left for the webhook; amounts beyond what is left are refused', async () => {
  admin = true;
  refundStatus = 'pending';
  const pending = await handleOrders(req, 'refund', { paymentId: 'pay_unit000001' }, SITE);
  assert.equal(pending.body.status, 'pending');
  assert.equal(find('/v1/refunds').body.data.attributes.amount, 1100000);   // the whole remaining amount
  assert.ok(!find('server_record_refund'));

  for (const amount of ['11000.01', '0', '-5', 'abc']) {
    calls = [];
    const refused = await handleOrders(req, 'refund', { paymentId: 'pay_unit000001', amount }, SITE);
    assert.equal(refused.status, 400, amount);
    assert.ok(!find('/v1/refunds'));
  }
  const unknown = await handleOrders(req, 'refund', { paymentId: 'not-a-payment' }, SITE);
  assert.equal(unknown.status, 400);
});

/* ------------------------------------------------------- providers/emails --- */

test('a shop is offered only the methods it takes AND this server has switched on', async () => {
  const both = await handleOrders({ method: 'GET', headers: {} }, 'providers', null, SITE, new URLSearchParams({ store: STORE }));
  assert.deepEqual(both.body.providers, ['paypal', 'paymongo']);
  const call = find('store_payment_providers');
  assert.deepEqual(call.body, { p_store: STORE, p_paypal_env: 'sandbox', p_paymongo_env: 'sandbox' });
  assert.equal(call.headers.Authorization, undefined);

  process.env.PAYMONGO_SECRET_KEY = '';
  const paypalOnly = await handleOrders({ method: 'GET', headers: {} }, 'providers', null, SITE, new URLSearchParams({ store: STORE }));
  assert.deepEqual(paypalOnly.body.providers, ['paypal']);
});

test('before 0016 is applied, a shop that takes payments is offered PayPal only', async () => {
  schema0016 = false;
  const result = await handleOrders({ method: 'GET', headers: {} }, 'providers', null, SITE, new URLSearchParams({ store: STORE }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.providers, ['paypal']);
  assert.deepEqual(find('store_accepts_payments').body, { p_store: STORE, p_env: 'sandbox' });
});

test('the provider boundary describes each provider truthfully, and Maya is gone', () => {
  const { paypal: pp, paymongo: pm } = providers.PROVIDERS;
  assert.deepEqual(Object.keys(providers.PROVIDERS).sort(), ['paymongo', 'paypal']);
  assert.equal(pp.capabilities.settlesTo, 'store');
  assert.equal(pm.capabilities.settlesTo, 'platform');
  assert.equal(pm.capabilities.webhooks, 'signed');
  assert.equal(pm.capabilities.refunds, 'api');
  assert.deepEqual(pm.capabilities.methods, ['gcash']);
  assert.equal(pm.label, 'GCash');
});

test('emails say GCash via PayMongo, who holds the money, and never promise the exact net', () => {
  const base = {
    order_id: ORDER, reference: 'ABC123', kind: 'stock', product_name: 'Sofa', quantity: 1, unit_price: 10000,
    subtotal: 10000, platform_fee: 1000, total: 11000, amount_paid: 11000, created_at: '2026-09-24T02:00:00Z',
    buyer_name: 'Ana', buyer_email: 'ana@gmail.com', store_name: 'Shop', store_emails: ['shop@gmail.com'],
    fulfilment_method: 'pickup', estimated_arrival: '2026-09-27'
  };
  const gcashPaid = { ...base, payments: [{ stage: 'full', amount: 11000, platform_fee: 1000, capture_id: 'pay_unit000001',
    captured_at: '2026-09-24T02:05:00Z', applied: true, provider: 'paymongo', payment_method: 'gcash', fee_mode: 'platform_held' }] };
  const [toBuyer, toShop] = messagesFor('paid', gcashPaid, SITE);
  assert.ok(toBuyer.rows.some(r => /^Paid via GCash via PayMongo \(in full\) · pay_unit000001$/.test(r.label || '')));
  assert.match(toShop.lines[0], /confirmed through GCash/);
  assert.match(toShop.lines[0], /FurnishAR's PayMongo account/);
  assert.match(toShop.lines[0], /your share of ₱10,000\.00 is owed to you/);
  assert.match(toShop.lines[0], /processing fee is shown separately/);
  assert.doesNotMatch(JSON.stringify([toBuyer, toShop]), /Maya|in your GCash account/);

  const paypalPaid = { ...base, payments: [{ ...gcashPaid.payments[0], provider: 'paypal', payment_method: 'paypal', fee_mode: 'accrual' }] };
  const [ppBuyer, ppShop] = messagesFor('paid', paypalPaid, SITE);
  assert.ok(ppBuyer.rows.some(r => /^Paid via PayPal/.test(r.label || '')));
  assert.match(ppShop.lines[0], /The money is in your PayPal account/);

  assert.match(messagesFor('payment_failed', { ...base, provider: 'paymongo' }, SITE)[0].lines[0], /^GCash did not complete/);
  assert.match(messagesFor('payment_failed', base, SITE)[0].lines[0], /^PayPal did not complete/);
  const unapplied = messagesFor('unapplied', { ...base, provider: 'paymongo' }, SITE)[0];
  assert.match(unapplied.lines.join(' '), /FurnishAR received it through GCash \(PayMongo\) and will refund/);
  const held = messagesFor('platform_fee_recorded',
    { admin_emails: ['a@x'], amount: 11000, platform_fee: 1000, stage: 'full', fee_mode: 'platform_held', provider: 'paymongo', sandbox: true }, SITE)[0];
  assert.match(held.lines.join(' '), /received by FurnishAR's PayMongo account/);
  assert.match(held.lines.join(' '), /PayMongo test mode/);
  assert.match(held.lines.join(' '), /not collected by any split/);
  assert.doesNotMatch(held.lines.join(' '), /(was|were|is) collected/);
  const expected = messagesFor('platform_fee_recorded',
    { admin_emails: ['a@x'], amount: 5500, platform_fee: 500, stage: 'deposit', fee_mode: 'provider_split', provider: 'paymongo' }, SITE)[0];
  assert.match(expected.lines[0], /not collected until reconciled/);
  const refunded = messagesFor('refund_completed', { ...base, provider: 'paymongo', refund_amount: 11000 }, SITE)[0];
  assert.match(refunded.lines.join(' '), /to your GCash, through PayMongo/);
});

/* ---------------------------------------------------------------- PayPal --- */

test('PayPal calls stay exactly as before, so they work before and after 0016', async () => {
  due = { ...due, provider: 'paypal', merchant_id: 'SHOPMERCHANT1', settlement_mode: null, partner_fee_granted: false };
  const result = await handleOrders(req, 'pay', { orderId: ORDER, provider: 'paypal' }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(!('p_provider' in find('begin_payment').body));
  const attemptBody = find('server_record_payment_attempt').body;
  assert.ok(!('p_provider' in attemptBody) && !('p_reference' in attemptBody) && !('p_method' in attemptBody));
  // No method named at all is PayPal, as every caller before 0015.
  calls = [];
  assert.equal((await handleOrders(req, 'pay', { orderId: ORDER }, SITE)).status, 200);
  assert.ok(!('p_provider' in find('begin_payment').body));
  assert.ok(!find('/v1/checkout_sessions'));
});
