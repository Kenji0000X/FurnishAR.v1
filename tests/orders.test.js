/**
 * lib/orders.js against a fake Supabase and a fake PayPal.
 *
 * What these pin down is the server's half of the money rules: it never
 * captures a PayPal payment that does not match what the database says is
 * owed, never forwards a browser's price, and presents the payment-recorder
 * secret from its own environment — not from the request.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test000000000000000';
process.env.PAYPAL_CLIENT_ID = 'client-id';
process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
process.env.PAYMENT_RECORDER_SECRET = 'x'.repeat(40);
delete process.env.RESEND_API_KEY;

const { handleOrders } = require('../lib/orders.js');

const ORDER = '11111111-2222-4333-8444-555555555555';
const PRODUCT = '99999999-2222-4333-8444-555555555555';
const req = { method: 'POST', headers: { authorization: 'Bearer user-jwt' } };
const SITE = 'https://furnishar.test';

let calls;
let paypalOrder;
let due;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test.beforeEach(() => {
  calls = [];
  due = { order_id: ORDER, reference: 'ABC123', stage: 'full', amount: 2200, currency: 'PHP',
          payee_email: 'shop@pay.ph', store_name: 'Shop', product_name: 'Chair' };
  paypalOrder = {
    id: 'PAYPALORDER123', status: 'APPROVED',
    purchase_units: [{ custom_id: `${ORDER}:full`, amount: { currency_code: 'PHP', value: '2200.00' },
                       payee: { email_address: 'shop@pay.ph' } }],
    payer: { email_address: 'buyer@pp.ph' }
  };
  global.fetch = async (url, options = {}) => {
    const body = options.body && typeof options.body === 'string' && options.body.startsWith('{') ? JSON.parse(options.body) : options.body;
    calls.push({ url: String(url), method: options.method || 'GET', body, headers: options.headers });
    const u = String(url);
    if (u.endsWith('/auth/v1/user')) return reply(200, { id: 'user-1', email: 'buyer@x.ph' });
    if (u.includes('/rest/v1/rpc/begin_payment')) return reply(200, due);
    if (u.includes('/rest/v1/rpc/create_stock_order')) return reply(200, { order_id: ORDER, reference: 'ABC123' });
    if (u.includes('/rest/v1/rpc/record_capture')) return reply(200, { order_id: ORDER, status: 'paid', applied: true, duplicate: false });
    if (u.includes('/rest/v1/rpc/order_contacts')) return reply(200, { reference: 'ABC123', buyer_email: 'b@x.ph', store_emails: ['s@x.ph'] });
    if (u.includes('/rest/v1/rpc/cancel_order')) return reply(200, { status: 'cancelled' });
    if (u.endsWith('/v1/oauth2/token')) return reply(200, { access_token: 'pp-token', expires_in: 3600 });
    if (u.endsWith('/v2/checkout/orders') && options.method === 'POST') {
      return reply(201, { id: 'PAYPALORDER123', links: [{ rel: 'payer-action', href: 'https://paypal.test/approve' }] });
    }
    if (u.endsWith('/capture')) {
      return reply(201, { ...paypalOrder, status: 'COMPLETED', purchase_units: [{ ...paypalOrder.purchase_units[0],
        payments: { captures: [{ id: 'CAPTURE1', status: 'COMPLETED', custom_id: `${ORDER}:full`,
                                 amount: { currency_code: 'PHP', value: '2200.00' } }] } }] });
    }
    if (u.includes('/v2/checkout/orders/')) return reply(200, paypalOrder);
    return reply(404, {});
  };
});

test('no session, no order', async () => {
  const result = await handleOrders({ method: 'POST', headers: {} }, 'checkout', { productId: PRODUCT }, SITE);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'auth_required');
  assert.equal(calls.length, 0);
});

test('checkout sends the product and quantity, never a price, and pays the shop', async () => {
  const delivery = { method: 'delivery', address: 'Purok 3, Poblacion', municipality: 'Mamburao', phone: '0917 123 4567', notes: null };
  const result = await handleOrders(req, 'checkout', { productId: PRODUCT, quantity: 2, price: 1, total: 1, delivery }, SITE);
  assert.equal(result.status, 200);
  assert.equal(result.body.approveUrl, 'https://paypal.test/approve');
  const create = calls.find(c => c.url.includes('create_stock_order'));
  assert.deepEqual(create.body, {
    p_product: PRODUCT, p_quantity: 2, p_method: 'delivery', p_address: 'Purok 3, Poblacion',
    p_municipality: 'Mamburao', p_phone: '0917 123 4567', p_notes: null
  });
  const pp = calls.find(c => c.url.endsWith('/v2/checkout/orders'));
  assert.equal(pp.body.purchase_units[0].amount.value, '2200.00');      // from begin_payment
  assert.equal(pp.body.purchase_units[0].payee.email_address, 'shop@pay.ph');
  assert.equal(pp.body.payment_source.paypal.experience_context.return_url, `${SITE}/account?paypal=return`);
});

test('a capture is recorded with the server secret and PayPal\'s own figures', async () => {
  const result = await handleOrders(req, 'capture', { paypalOrderId: 'PAYPALORDER123', amount: 1, secret: 'nope' }, SITE);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'paid');
  const record = calls.find(c => c.url.includes('record_capture'));
  assert.equal(record.body.p_secret, 'x'.repeat(40));
  assert.equal(record.body.p_amount, 2200);
  assert.equal(record.body.p_capture, 'CAPTURE1');
  assert.equal(record.headers.Authorization, 'Bearer user-jwt');       // as the buyer, not a service key
});

test('a PayPal payment that no longer matches what is owed is never captured', async () => {
  paypalOrder.purchase_units[0].amount.value = '100.00';
  let result = await handleOrders(req, 'capture', { paypalOrderId: 'PAYPALORDER123' }, SITE);
  assert.equal(result.status, 409);
  assert.ok(!calls.some(c => c.url.endsWith('/capture')));

  paypalOrder.purchase_units[0].amount.value = '2200.00';
  paypalOrder.purchase_units[0].payee.email_address = 'thief@pay.ph';
  result = await handleOrders(req, 'capture', { paypalOrderId: 'PAYPALORDER123' }, SITE);
  assert.equal(result.status, 409);
  assert.ok(!calls.some(c => c.url.endsWith('/capture')));
});

test('a PayPal order that is not ours is refused', async () => {
  paypalOrder.purchase_units[0].custom_id = 'something-else';
  const result = await handleOrders(req, 'capture', { paypalOrderId: 'PAYPALORDER123' }, SITE);
  assert.equal(result.status, 400);
  assert.ok(!calls.some(c => c.url.includes('record_capture')));
});

test('if PayPal will not start, the held stock is released', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => (String(url).endsWith('/v2/checkout/orders')
    ? reply(500, { name: 'INTERNAL_SERVER_ERROR' }) : realFetch(url, options));
  const result = await handleOrders(req, 'checkout', { productId: PRODUCT }, SITE);
  assert.equal(result.status, 502);
  assert.ok(calls.some(c => c.url.includes('cancel_order')));
});

test('payments stay off until PayPal and the recorder secret are both set', async () => {
  const saved = process.env.PAYMENT_RECORDER_SECRET;
  process.env.PAYMENT_RECORDER_SECRET = 'short';
  const config = await handleOrders({ method: 'GET', headers: {} }, 'config', null, SITE);
  assert.equal(config.body.payments, false);
  const result = await handleOrders(req, 'checkout', { productId: PRODUCT }, SITE);
  assert.equal(result.status, 503);
  process.env.PAYMENT_RECORDER_SECRET = saved;
});

test('unknown actions are not dispatched', async () => {
  for (const action of ['__proto__', 'constructor', 'record_capture', 'toString']) {
    const result = await handleOrders(req, action, {}, SITE);
    assert.equal(result.status, 404, action);
  }
});

test('the receipt email carries the order, the fee, the payment and the arrival date', () => {
  const { messagesFor } = require('../lib/notify.js');
  const contacts = {
    order_id: ORDER, reference: 'ABC123', kind: 'stock', product_name: 'Chair <b>', quantity: 2, unit_price: 1000,
    subtotal: 2000, platform_fee: 200, total: 2200, amount_paid: 2200, created_at: '2026-09-24T02:00:00Z',
    buyer_name: 'Ana', buyer_email: 'ana@gmail.com', store_name: 'Shop', store_address: 'Mamburao', store_contact: '0917',
    store_emails: ['shop@gmail.com'], fulfilment_method: 'delivery', delivery_address: 'Purok 3', delivery_municipality: 'Mamburao',
    delivery_phone: '0917 123 4567', estimated_arrival: '2026-09-27',
    payments: [{ stage: 'full', amount: 2200, capture_id: 'CAP123', captured_at: '2026-09-24T02:05:00Z', applied: true }]
  };
  const [toBuyer, toShop] = messagesFor('paid', contacts, SITE);
  assert.equal(toBuyer.to, 'ana@gmail.com');
  const text = toBuyer.rows.filter(r => !r.rule).map(r => `${r.label}: ${r.value}`).join('\n');
  for (const piece of ['ABC123', '₱2,000.00', '₱200.00', '₱2,200.00', 'CAP123', 'Free delivery to Purok 3, Mamburao', 'September 27, 2026']) {
    assert.ok(text.includes(piece), `receipt is missing ${piece}:\n${text}`);
  }
  assert.equal(toBuyer.action.href, `${SITE}/account/receipt/${ORDER}`);
  assert.deepEqual(toShop.to, ['shop@gmail.com']);
  // Buyer-supplied text is escaped in the HTML.
  const { render } = require('../lib/notify.js');
  assert.ok(!render(toBuyer).html.includes('<b>'));
});
