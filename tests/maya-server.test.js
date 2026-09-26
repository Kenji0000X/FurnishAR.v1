/**
 * Maya on the server — lib/maya.js, lib/providers, lib/orders.js (verify)
 * and lib/maya-webhook.js — against a fake Supabase and a fake Maya.
 *
 * The rules pinned down: the browser names a payment method, never a price
 * or a payee; the checkout is created with the PUBLIC key and read back with
 * the SECRET key; neither the return URL nor an (unsigned) webhook body is
 * believed — only the payment re-read from Maya is recorded; a webhook is
 * processed once; PayPal keeps working unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test000000000000000';
process.env.PAYPAL_CLIENT_ID = 'client-id';
process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
process.env.PAYMENT_RECORDER_SECRET = 'x'.repeat(40);
process.env.MAYA_PUBLIC_KEY = 'pk-test-public';
process.env.MAYA_SECRET_KEY = 'sk-test-secret';
for (const name of ['PAYPAL_ENV', 'PAYPAL_FEE_MODE', 'MAYA_ENV', 'MAYA_PAYFAC_ENABLED', 'MAYA_FEE_MODE',
  'MAYA_WEBHOOK_ALLOWED_IPS', 'RESEND_API_KEY', 'GMAIL_USER']) delete process.env[name];

const { handleOrders, billingConfig } = require('../lib/orders.js');
const { handleMayaWebhook, referenceOf } = require('../lib/maya-webhook.js');
const maya = require('../lib/maya.js');
const providers = require('../lib/providers/index.js');
const { messagesFor } = require('../lib/notify.js');

const ORDER = '11111111-2222-4333-8444-555555555555';
const PRODUCT = '99999999-2222-4333-8444-555555555555';
const STORE = '77777777-2222-4333-8444-555555555555';
const req = { method: 'POST', headers: { authorization: 'Bearer user-jwt' } };
const SITE = 'https://furnishar.test';
const basic = key => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;

let calls;
let due;
let attempt;
let mayaPayments;
let owns;
let claimed;
let storeProviders;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const find = part => calls.find(c => c.url.includes(part));
const all = part => calls.filter(c => c.url.includes(part));

test.beforeEach(() => {
  calls = [];
  owns = true;
  claimed = true;
  storeProviders = ['paypal', 'maya'];
  due = { order_id: ORDER, reference: 'ABC123', stage: 'full', amount: 2200, currency: 'PHP', platform_fee: 200,
          provider: 'maya', settlement_mode: 'platform_collect', provider_account_ref: null, provider_profile: null,
          merchant_id: null, store_name: 'Shop', product_name: 'Chair' };
  attempt = { order_id: ORDER, stage: 'full', amount: 2200, currency: 'PHP', platform_fee: 200, fee_mode: 'platform_collect',
              payee_merchant_id: 'furnishar-platform', environment: 'sandbox', provider: 'maya',
              provider_order_id: 'CHECKOUT-1', provider_reference: 'ABC123-Fdeadbeef' };
  mayaPayments = [{ id: 'PAY-1', status: 'PAYMENT_SUCCESS', isPaid: true, amount: '2200.00', currency: 'PHP',
                    requestReferenceNumber: 'ABC123-Fdeadbeef', buyer: { contact: { email: 'payer@maya.ph' } } }];
  global.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' && options.body.startsWith('{') ? JSON.parse(options.body) : options.body;
    calls.push({ url: String(url), method: options.method || 'GET', body, headers: options.headers || {} });
    const u = String(url);
    if (u.endsWith('/auth/v1/user')) return reply(200, { id: 'user-1', email: 'buyer@x.ph' });
    if (u.includes('/rest/v1/rpc/begin_payment')) return reply(200, due);
    if (u.includes('/rest/v1/rpc/create_stock_order')) return reply(200, { order_id: ORDER, reference: 'ABC123' });
    if (u.includes('/rest/v1/rpc/cancel_order')) return reply(200, { status: 'cancelled' });
    if (u.includes('/rest/v1/rpc/server_record_payment_attempt')) return reply(200, { ok: true });
    if (u.includes('/rest/v1/rpc/server_payment_attempt_by_reference')) return reply(200, attempt);
    if (u.includes('/rest/v1/rpc/server_update_payment_attempt')) return reply(200, { ok: true });
    if (u.includes('/rest/v1/rpc/server_claim_webhook_event')) return reply(200, claimed);
    if (u.includes('/rest/v1/rpc/server_finish_webhook_event')) return reply(200, null);
    if (u.includes('/rest/v1/rpc/server_admin_emails')) return reply(200, ['admin@furnishar.ph']);
    if (u.includes('/rest/v1/rpc/store_payment_providers')) return reply(200, storeProviders);
    if (u.includes('/rest/v1/rpc/record_capture')) {
      const applied = Number(body.p_amount) === 2200;
      return reply(200, { order_id: ORDER, status: applied ? 'paid' : 'pending_payment', applied, duplicate: false,
                          platform_fee: applied ? 200 : 0, fee_mode: 'platform_collect', provider: 'maya' });
    }
    if (u.includes('/rest/v1/rpc/order_contacts') || u.includes('/rest/v1/rpc/server_order_contacts')) {
      return reply(200, { reference: 'ABC123', buyer_email: 'b@x.ph', store_emails: ['s@x.ph'], payments: [] });
    }
    if (u.includes('/rest/v1/orders?id=eq.')) return reply(200, owns ? [{ id: ORDER }] : []);
    if (u === 'https://pg-sandbox.paymaya.com/checkout/v1/checkouts') {
      return reply(200, { checkoutId: 'CHECKOUT-1', redirectUrl: 'https://payments-web-sandbox.paymaya.com/v2/checkout?id=CHECKOUT-1' });
    }
    if (u.startsWith('https://pg-sandbox.paymaya.com/payments/v1/payment-rrns/')) {
      return mayaPayments.length ? reply(200, mayaPayments) : reply(404, { code: 'PY0009' });
    }
    return reply(404, {});
  };
});

test('the Maya client creates a checkout with the PUBLIC key and the database\'s amounts', async () => {
  const created = await maya.createCheckout({
    reference: 'ABC123-F1', amount: 2200, platformFee: 200, description: 'Chair — Shop (full)',
    buyer: { email: 'buyer@x.ph' },
    returnUrls: { success: `${SITE}/ok`, failure: `${SITE}/fail`, cancel: `${SITE}/cancel` }
  });
  assert.equal(created.checkoutId, 'CHECKOUT-1');
  const call = find('/checkout/v1/checkouts');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, basic('pk-test-public'));
  assert.deepEqual(call.body.totalAmount, { value: 2200, currency: 'PHP', details: { subtotal: 2000, serviceCharge: 200 } });
  assert.equal(call.body.requestReferenceNumber, 'ABC123-F1');
  assert.deepEqual(call.body.redirectUrl, { success: `${SITE}/ok`, failure: `${SITE}/fail`, cancel: `${SITE}/cancel` });
  assert.deepEqual(call.body.metadata, { source: 'furnishar' });   // no PayFac claim unless PayFac
  // Payments are read with the SECRET key.
  await maya.paymentsForReference('ABC123-F1');
  assert.equal(find('/payment-rrns/').headers.Authorization, basic('sk-test-secret'));
});

test('Maya configuration problems are named, never the keys', () => {
  process.env.MAYA_PUBLIC_KEY = 'sk-oops';
  process.env.MAYA_ENV = 'prod';
  const config = maya.validateConfig();
  assert.ok(config.problems.some(p => /looks like a secret key/.test(p)));
  assert.ok(config.problems.some(p => /MAYA_ENV/.test(p)));
  assert.equal(config.env, 'sandbox');
  assert.ok(!JSON.stringify(config).includes('sk-oops'));
  assert.ok(!JSON.stringify(config).includes('sk-test-secret'));
  process.env.MAYA_PUBLIC_KEY = 'pk-test-public';
  delete process.env.MAYA_ENV;
});

test('checkout with Maya: the payee and fee mode come from the store\'s setup, not the browser', async () => {
  const result = await handleOrders(req, 'checkout', {
    productId: PRODUCT, quantity: 2, provider: 'maya', price: 1, payee: 'EVIL', feeMode: 'accrual'
  }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.provider, 'maya');
  assert.match(result.body.approveUrl, /paymaya\.com/);
  assert.equal(find('begin_payment').body.p_provider, 'maya');
  const checkout = find('/checkout/v1/checkouts').body;
  assert.equal(checkout.totalAmount.value, 2200);
  assert.match(checkout.requestReferenceNumber, /^ABC123-F[0-9a-f]{8}$/);
  assert.match(checkout.redirectUrl.success,
    new RegExp(`^${SITE}/account/payment/return\\?provider=maya&ref=${checkout.requestReferenceNumber}&result=success$`));
  const recorded = find('server_record_payment_attempt').body;
  assert.equal(recorded.p_provider, 'maya');
  assert.equal(recorded.p_merchant, 'furnishar-platform');
  assert.equal(recorded.p_fee_mode, 'platform_collect');
  assert.equal(recorded.p_provider_order, 'CHECKOUT-1');
  assert.equal(recorded.p_reference, checkout.requestReferenceNumber);
  assert.equal(recorded.p_amount, 2200);
});

test('an unknown payment method is refused before any order is created', async () => {
  const result = await handleOrders(req, 'checkout', { productId: PRODUCT, provider: 'gcash' }, SITE);
  assert.equal(result.status, 400);
  assert.ok(!find('create_stock_order'));
});

test('a PayFac store is refused while Maya has not enabled PayFac, and the stock is released', async () => {
  due.settlement_mode = 'payfac';
  due.provider_account_ref = 'SM-1';
  const result = await handleOrders(req, 'checkout', { productId: PRODUCT, provider: 'maya' }, SITE);
  assert.equal(result.status, 409);
  assert.ok(find('cancel_order'));
  assert.ok(!find('/checkout/v1/checkouts'));
});

test('PayFac, once enabled, names the sub-merchant and the fee mode the server is set to', async () => {
  process.env.MAYA_PAYFAC_ENABLED = 'true';
  process.env.MAYA_FEE_MODE = 'provider_settlement';
  due.settlement_mode = 'payfac';
  due.provider_account_ref = 'SM-1';
  due.provider_profile = { city: 'Mamburao', postal: '5106', country: 'PHL' };
  const result = await handleOrders(req, 'pay', { orderId: ORDER, provider: 'maya' }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const metadata = find('/checkout/v1/checkouts').body.metadata;
  assert.equal(metadata.pf.smi, 'SM-1');
  assert.equal(metadata.pf.mci, 'Mamburao');
  assert.equal(metadata.pf.mpc, '5106');
  const recorded = find('server_record_payment_attempt').body;
  assert.equal(recorded.p_merchant, 'SM-1');
  assert.equal(recorded.p_fee_mode, 'provider_settlement');
  delete process.env.MAYA_PAYFAC_ENABLED;
  delete process.env.MAYA_FEE_MODE;
});

test('the buyer\'s return is verified from Maya, with the secret key, and recorded once as Maya', async () => {
  const result = await handleOrders(req, 'verify', { provider: 'maya', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, 'paid');
  assert.equal(result.body.status, 'paid');
  const capture = find('record_capture').body;
  assert.equal(capture.p_provider, 'maya');
  assert.equal(capture.p_capture, 'PAY-1');
  assert.equal(capture.p_provider_order, 'CHECKOUT-1');
  assert.equal(capture.p_amount, 2200);                       // Maya's figure, not the browser's
  assert.equal(capture.p_payee_merchant, 'furnishar-platform');
  assert.equal(capture.p_secret, 'x'.repeat(40));
  assert.equal(find('/payment-rrns/').headers.Authorization, basic('sk-test-secret'));
});

test('someone else\'s reference is not answered', async () => {
  owns = false;
  const result = await handleOrders(req, 'verify', { provider: 'maya', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.status, 404);
  assert.ok(!find('record_capture'));
  assert.ok(!find('/payment-rrns/'));
});

test('a failed or cancelled Maya payment is never recorded as paid', async () => {
  mayaPayments[0].status = 'PAYMENT_FAILED';
  mayaPayments[0].isPaid = false;
  let result = await handleOrders(req, 'verify', { provider: 'maya', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'failed');
  assert.ok(!find('record_capture'));
  assert.equal(find('server_update_payment_attempt').body.p_status, 'DECLINED');

  calls = [];
  mayaPayments = [];
  result = await handleOrders(req, 'verify', { provider: 'maya', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'cancelled');
  assert.ok(!find('record_capture'));
  assert.equal(find('server_update_payment_attempt').body.p_status, 'CANCELLED');
});

test('a Maya payment for another amount is recorded as Maya reports it, and not applied', async () => {
  mayaPayments[0].amount = '100.00';
  const result = await handleOrders(req, 'verify', { provider: 'maya', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(result.body.state, 'unapplied');
  assert.equal(find('record_capture').body.p_amount, 100);
});

test('a malformed or unknown reference is refused without asking Maya', async () => {
  for (const reference of ['', '../x', 'a'.repeat(80)]) {
    const result = await handleOrders(req, 'verify', { provider: 'maya', reference }, SITE);
    assert.equal(result.status, 400, reference);
  }
  const paypal = await handleOrders(req, 'verify', { provider: 'paypal', reference: 'ABC123-Fdeadbeef' }, SITE);
  assert.equal(paypal.status, 400);
  assert.ok(!find('/payment-rrns/'));
});

test('a webhook is only a prompt: the payment is re-read, and a body claiming success is not believed', async () => {
  mayaPayments[0].status = 'PAYMENT_FAILED';
  mayaPayments[0].isPaid = false;
  const body = JSON.stringify({ id: 'PAY-1', status: 'PAYMENT_SUCCESS', isPaid: true, amount: 2200,
                                requestReferenceNumber: 'ABC123-Fdeadbeef' });
  const result = await handleMayaWebhook({}, body, SITE);
  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, 'failed');
  assert.ok(!find('record_capture'));
  assert.equal(find('server_claim_webhook_event').body.p_event_id, 'maya:PAY-1:PAYMENT_FAILED');
});

test('a successful webhook records once; a redelivery is a no-op', async () => {
  const body = JSON.stringify({ id: 'PAY-1', status: 'PAYMENT_SUCCESS', requestReferenceNumber: 'ABC123-Fdeadbeef' });
  const first = await handleMayaWebhook({}, body, SITE);
  assert.equal(first.status, 200);
  assert.match(first.body.outcome, /recorded \(paid\)/);
  assert.equal(all('record_capture').length, 1);
  assert.equal(find('record_capture').headers.Authorization, undefined);   // no user token on a webhook

  calls = [];
  claimed = false;
  const again = await handleMayaWebhook({}, body, SITE);
  assert.deepEqual(again.body, { duplicate: true });
  assert.ok(!find('record_capture'));
});

test('webhooks from outside the allowed addresses, or naming no FurnishAR payment, do nothing', async () => {
  process.env.MAYA_WEBHOOK_ALLOWED_IPS = '203.0.113.10, 203.0.113.11';
  const body = JSON.stringify({ requestReferenceNumber: 'ABC123-Fdeadbeef' });
  const refused = await handleMayaWebhook({ 'x-forwarded-for': '198.51.100.7' }, body, SITE);
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 0);
  const allowed = await handleMayaWebhook({ 'x-forwarded-for': '203.0.113.11, 10.0.0.1' }, body, SITE);
  assert.equal(allowed.status, 200);
  delete process.env.MAYA_WEBHOOK_ALLOWED_IPS;

  calls = [];
  attempt = null;
  const unknown = await handleMayaWebhook({}, body, SITE);
  assert.equal(unknown.status, 200);
  assert.ok(!find('/payment-rrns/'));
  assert.equal((await handleMayaWebhook({}, 'not json', SITE)).status, 400);
  assert.equal(referenceOf({ requestReferenceNumber: "x'; drop" }), null);
});

test('a shop is offered only the methods it takes AND this server has switched on', async () => {
  const both = await handleOrders({ method: 'GET', headers: {} }, 'providers', null, SITE, new URLSearchParams({ store: STORE }));
  assert.deepEqual(both.body.providers, ['paypal', 'maya']);
  const call = find('store_payment_providers');
  assert.deepEqual(call.body, { p_store: STORE, p_paypal_env: 'sandbox', p_maya_env: 'sandbox' });
  assert.equal(call.headers.Authorization, undefined);

  process.env.MAYA_SECRET_KEY = '';
  const paypalOnly = await handleOrders({ method: 'GET', headers: {} }, 'providers', null, SITE, new URLSearchParams({ store: STORE }));
  assert.deepEqual(paypalOnly.body.providers, ['paypal']);
  assert.deepEqual(billingConfig().providers.map(p => p.id), ['paypal']);
  process.env.MAYA_SECRET_KEY = 'sk-test-secret';

  const bad = await handleOrders({ method: 'GET', headers: {} }, 'providers', null, SITE, new URLSearchParams({ store: 'x' }));
  assert.equal(bad.status, 400);
  assert.deepEqual(billingConfig().providers.map(p => p.id), ['paypal', 'maya']);
  assert.ok(!JSON.stringify(billingConfig({ admin: true })).includes('sk-test-secret'));
});

test('the provider boundary describes each provider truthfully', () => {
  const { paypal: pp, maya: my } = providers.PROVIDERS;
  assert.equal(pp.capabilities.settlesTo, 'store');
  assert.equal(my.capabilities.settlesTo, 'platform');
  assert.equal(my.capabilities.webhooks, 'unsigned-refetch');
  assert.equal(my.capabilities.storeOnboarding, 'admin');
  assert.throws(() => providers.get('gcash'), /Unknown payment method/);
});

test('emails say which provider was used and, for Maya, who holds the money', () => {
  const base = {
    order_id: ORDER, reference: 'ABC123', kind: 'stock', product_name: 'Chair', quantity: 1, unit_price: 2000,
    subtotal: 2000, platform_fee: 200, total: 2200, amount_paid: 2200, created_at: '2026-09-24T02:00:00Z',
    buyer_name: 'Ana', buyer_email: 'ana@gmail.com', store_name: 'Shop', store_emails: ['shop@gmail.com'],
    fulfilment_method: 'pickup', estimated_arrival: '2026-09-27'
  };
  const mayaPaid = { ...base, payments: [{ stage: 'full', amount: 2200, platform_fee: 200, capture_id: 'PAY-1',
    captured_at: '2026-09-24T02:05:00Z', applied: true, provider: 'maya', fee_mode: 'platform_collect' }] };
  const [toBuyer, toShop] = messagesFor('paid', mayaPaid, SITE);
  assert.ok(toBuyer.rows.some(r => /^Paid via Maya \(in full\) · PAY-1$/.test(r.label || '')));
  assert.match(toShop.lines[0], /confirmed through Maya/);
  assert.match(toShop.lines[0], /your share of ₱2,000\.00 is owed to you/);
  assert.doesNotMatch(toShop.lines[0], /PayPal/);

  const paypalPaid = { ...base, payments: [{ ...mayaPaid.payments[0], provider: 'paypal', fee_mode: 'accrual' }] };
  const [ppBuyer, ppShop] = messagesFor('paid', paypalPaid, SITE);
  assert.ok(ppBuyer.rows.some(r => /^Paid via PayPal/.test(r.label || '')));
  assert.match(ppShop.lines[0], /The money is in your PayPal account/);

  assert.match(messagesFor('payment_failed', { ...base, provider: 'maya' }, SITE)[0].lines[0], /^Maya did not complete/);
  assert.match(messagesFor('payment_failed', base, SITE)[0].lines[0], /^PayPal did not complete/);
  const unapplied = messagesFor('unapplied', { ...base, provider: 'maya' }, SITE)[0];
  assert.match(unapplied.lines.join(' '), /FurnishAR received it through Maya and will refund/);
  const fee = messagesFor('platform_fee_recorded',
    { admin_emails: ['a@x'], amount: 2200, platform_fee: 200, stage: 'full', fee_mode: 'platform_collect', provider: 'maya', sandbox: true }, SITE)[0];
  assert.match(fee.lines[0], /FurnishAR's Maya account received/);
  assert.match(fee.lines.join(' '), /Maya sandbox/);
  const expected = messagesFor('platform_fee_recorded',
    { admin_emails: ['a@x'], amount: 2750, platform_fee: 250, stage: 'deposit', fee_mode: 'provider_settlement', provider: 'maya' }, SITE)[0];
  assert.match(expected.lines[0], /not collected until reconciled/);
});
