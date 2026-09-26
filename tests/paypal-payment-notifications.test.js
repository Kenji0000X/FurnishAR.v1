/**
 * PayPal payment → split recorded → Gmail notifications, end to end on the
 * server (lib/orders.js, lib/payments.js, lib/payment-notifications.js,
 * lib/notify.js) against a fake Supabase that keeps 0017's rules in memory,
 * a fake PayPal and a fake mail provider.
 *
 * The brief's case: a ₱10,000 piece, 10% fee → the buyer pays ₱11,000; the
 * shop's portion is ₱10,000 and FurnishAR's ₱1,000. A verified capture gives
 * ONE payment and ONE buyer, ONE store and ONE superadmin email — and a page
 * refresh, a capture retry, the webhook (either order) or a redelivered
 * webhook adds none. Declined, pending, mismatched and wrong-currency
 * payments send no "payment received" email. A mail outage never undoes a
 * payment; the email is retried and then sent once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test000000000000000';
process.env.PAYPAL_CLIENT_ID = 'client-id';
process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST';
process.env.PAYMENT_RECORDER_SECRET = 'x'.repeat(40);
process.env.RESEND_API_KEY = 're_test';                   // mail goes through the fake provider below
process.env.EMAIL_FROM = 'FurnishAR <orders@furnishar.test>';
for (const name of ['PAYPAL_ENV', 'PAYPAL_FEE_MODE', 'PAYPAL_PARTNER_MERCHANT_ID', 'PAYPAL_PARTNER_ATTRIBUTION_ID',
  'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'PAYMONGO_SECRET_KEY']) delete process.env[name];

const { handleOrders } = require('../lib/orders.js');
const payments = require('../lib/payments.js');
const { dispatchPaymentNotifications } = require('../lib/payment-notifications.js');

const ORDER = '11111111-2222-4333-8444-555555555555';
const req = { method: 'POST', headers: { authorization: 'Bearer buyer-jwt' } };
const SITE = 'https://furnishar.test';
const SIGNED = {
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert.pem',
  'paypal-transmission-id': 't-1', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-09-26T00:00:00Z'
};

let db;            // the fake database's state
let paypalOrder;   // what PayPal says about the order
let captureMode;   // 'completed' | 'pending' | 'declined'
let mailDown;      // the mail provider refuses everything
let ledger;        // 0017 applied?
let splitReported; // PayPal's capture breakdown reports the platform fee
let emails;        // every email the provider accepted
let rpcCalls;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const pgrst202 = () => reply(404, { code: 'PGRST202', message: 'Could not find the function' });
const money = v => Math.round(Number(v) * 100) / 100;

function feeStatus(p) {
  if (!p.applied || p.platform_fee <= 0) return 'none';
  if (p.refunded_platform_fee >= p.platform_fee) return 'refunded';
  return p.fee_mode === 'platform_split' ? 'collected' : 'accrued';
}

/* record_capture, as 0011/0016 + 0017's trigger decide it. */
function recordCapture(b) {
  const existing = db.payments.find(p => p.capture_id === b.p_capture);
  if (existing) return { body: { order_id: ORDER, status: db.order.status, applied: existing.applied, duplicate: true } };
  if (b.p_currency !== 'PHP') return { error: reply(400, { code: 'P0001', message: 'Unexpected payment.' }) };
  if (!ledger && 'p_processing_fee' in b) return { error: pgrst202() };
  const applied = db.order.status === 'pending_payment' && money(b.p_amount) === money(db.order.total);
  const fee = applied ? db.order.platform_fee : 0;
  const mode = applied && b.p_fee_mode === 'platform_split' && b.p_fee_collected != null && money(b.p_fee_collected) === fee
    ? 'platform_split' : 'accrual';
  const payment = { stage: b.p_stage, amount: money(b.p_amount), platform_fee: fee, applied, fee_mode: mode,
    platform_fee_collected: b.p_fee_collected, capture_id: b.p_capture, provider: 'paypal', payment_method: 'paypal',
    processing_fee: b.p_processing_fee ?? null, refunded_platform_fee: 0, refunded_amount: 0,
    captured_at: '2026-09-26T02:00:00Z', environment: 'sandbox' };
  db.payments.push(payment);
  if (applied) {
    db.order.status = 'paid';
    db.order.amount_paid = payment.amount;
  }
  if (ledger) {
    for (const audience of applied ? ['buyer', 'store', 'admin'] : ['store']) {
      db.notifications.push({ id: db.notifications.length + 1, capture_id: b.p_capture, order_id: ORDER, audience,
        event: applied ? 'paid' : 'unapplied', status: 'pending', attempts: 0 });
    }
  }
  return { body: { order_id: ORDER, status: db.order.status, applied, duplicate: false, platform_fee: fee, fee_mode: mode } };
}

function contacts() {
  return {
    ...db.order,
    payments: db.payments.map(p => ({ ...p, store_portion: money(p.amount - p.platform_fee), fee_status: feeStatus(p) }))
  };
}

function captureBody() {
  const unit = paypalOrder.purchase_units[0];
  const status = captureMode === 'pending' ? 'PENDING' : 'COMPLETED';
  const breakdown = { paypal_fee: { currency_code: 'PHP', value: '459.00' }, net_amount: { currency_code: 'PHP', value: '10541.00' },
    ...(splitReported ? { platform_fees: [{ amount: { currency_code: 'PHP', value: '1000.00' } }] } : {}) };
  return { ...paypalOrder, status: 'COMPLETED', purchase_units: [{ ...unit, payments: { captures: [{
    id: 'CAPTURE1', status, custom_id: unit.custom_id, amount: { ...unit.amount }, seller_receivable_breakdown: breakdown }] } }] };
}

test.beforeEach(() => {
  db = {
    order: { order_id: ORDER, reference: 'FUR-0001', status: 'pending_payment', kind: 'stock', product_name: 'Narra Sofa',
      quantity: 1, subtotal: 10000, platform_fee: 1000, total: 11000, amount_paid: 0, currency: 'PHP',
      buyer_name: 'Ana Cruz', buyer_email: 'ana@gmail.com', store_name: 'SC Variety', store_emails: ['shop@gmail.com'],
      fulfilment_method: 'pickup', estimated_arrival: '2026-09-28', created_at: '2026-09-26T01:00:00Z' },
    payments: [], notifications: [], attemptStatus: null, events: new Set(), refunds: new Set()
  };
  paypalOrder = {
    id: 'PAYPALORDER123', status: 'APPROVED',
    purchase_units: [{ custom_id: `${ORDER}:full`, amount: { currency_code: 'PHP', value: '11000.00' },
                       payee: { merchant_id: 'SHOPMERCHANT1' } }],
    payer: { email_address: 'payer@pp.ph' }
  };
  captureMode = 'completed';
  mailDown = false;
  ledger = true;
  splitReported = false;
  emails = [];
  rpcCalls = [];
  const attempt = () => ({ order_id: ORDER, stage: 'full', amount: 11000, currency: 'PHP', platform_fee: 1000,
    fee_mode: splitReported ? 'platform_split' : 'accrual', payee_merchant_id: 'SHOPMERCHANT1', environment: 'sandbox', provider: 'paypal' });

  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const body = typeof options.body === 'string' && options.body.startsWith('{') ? JSON.parse(options.body) : {};
    if (u === 'https://api.resend.com/emails') {
      if (mailDown) return reply(503, {});
      emails.push(body);
      return reply(200, { id: `mail-${emails.length}` });
    }
    const rpc = u.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc) rpcCalls.push({ fn: rpc, body });
    if (u.endsWith('/auth/v1/user')) return reply(200, { id: 'buyer-1', email: 'ana@gmail.com' });
    if (rpc === 'begin_payment') return reply(200, { order_id: ORDER, reference: 'FUR-0001', stage: 'full', amount: 11000, currency: 'PHP', platform_fee: 1000 });
    if (rpc === 'server_payment_attempt') return reply(200, attempt());
    if (rpc === 'server_update_payment_attempt') { db.attemptStatus = body.p_status; return reply(200, { ok: true }); }
    if (rpc === 'record_capture') {
      const result = recordCapture(body);
      return result.error || reply(200, result.body);
    }
    if (rpc === 'server_claim_payment_notifications') {
      if (!ledger) return pgrst202();
      const due = db.notifications.filter(n => (!body.p_capture || n.capture_id === body.p_capture)
        && (n.status === 'pending' || (n.status === 'failed' && n.attempts < 5)));
      for (const n of due) { n.status = 'sending'; n.attempts += 1; }
      return reply(200, due.map(n => ({ ...n })));
    }
    if (rpc === 'server_finish_payment_notification') {
      const n = db.notifications.find(row => row.id === body.p_id && row.status === 'sending');
      if (n) n.status = body.p_status;
      return reply(200, null);
    }
    if (rpc === 'server_order_contacts' || rpc === 'order_contacts') return reply(200, contacts());
    if (rpc === 'server_admin_emails') return reply(200, ['admin@furnishar.ph']);
    if (rpc === 'server_claim_webhook_event') {
      if (db.events.has(body.p_event_id)) return reply(200, false);
      db.events.add(body.p_event_id);
      return reply(200, true);
    }
    if (rpc === 'server_finish_webhook_event') return reply(200, null);
    if (rpc === 'server_record_refund') {
      if (db.refunds.has(body.p_refund)) return reply(200, { duplicate: true });
      db.refunds.add(body.p_refund);
      const p = db.payments.find(x => x.capture_id === body.p_capture);
      const fee = body.p_fee_refunded ?? (p.fee_mode === 'platform_split' ? 0 : p.platform_fee);
      p.refunded_platform_fee += fee;
      return reply(200, { order_id: ORDER, recorded: true, completed: true, amount: body.p_amount,
        platform_fee_refunded: fee, fee_mode: p.fee_mode, capture_id: body.p_capture });
    }
    if (u.endsWith('/v1/oauth2/token')) return reply(200, { access_token: 'pp-token', expires_in: 3600 });
    if (u.endsWith('/v1/notifications/verify-webhook-signature')) return reply(200, { verification_status: 'SUCCESS' });
    if (u.endsWith('/capture')) {
      if (captureMode === 'declined') return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
      paypalOrder = captureBody();
      return reply(201, paypalOrder);
    }
    if (u.includes('/v2/checkout/orders/')) return reply(200, paypalOrder);
    return reply(404, {});
  };
});

const capture = () => handleOrders(req, 'capture', { paypalOrderId: 'PAYPALORDER123' }, SITE);
const webhook = (id = 'WH-EVENT-1') => payments.handleWebhook(SIGNED, JSON.stringify({
  id, event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: 'CAPTURE1', supplementary_data: { related_ids: { order_id: 'PAYPALORDER123' } } }
}), SITE);
const to = who => emails.filter(e => JSON.stringify(e.to).includes(who));
const paymentReceived = () => emails.filter(e => /Payment received|New payment received|platform fee/.test(e.subject));
const recordedPayments = () => rpcCalls.filter(c => c.fn === 'record_capture').length && db.payments.length;

/* -------------------------------------------------------------- success --- */

test('₱10,000 + 10% = ₱11,000: one payment, one buyer, one store and one superadmin email', async () => {
  const result = await capture();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'paid');
  assert.equal(db.payments.length, 1);
  const p = contacts().payments[0];
  assert.deepEqual([p.amount, p.store_portion, p.platform_fee], [11000, 10000, 1000]);
  assert.equal(p.processing_fee, 459);                        // PayPal's own fee, kept apart from the 10%
  assert.equal(emails.length, 3);

  const [buyer] = to('ana@gmail.com');
  assert.equal(buyer.subject, 'Payment received — Order FUR-0001');
  for (const piece of ['SC Variety', 'Narra Sofa', '₱10,000.00', '₱1,000.00', '₱11,000.00', 'PayPal', 'FUR-0001',
    `${SITE}/account/receipt/${ORDER}`]) {
    assert.ok(buyer.text.includes(piece), `buyer email is missing ${piece}`);
  }

  const [store] = to('shop@gmail.com');
  assert.equal(store.subject, 'New payment received — Order FUR-0001');
  for (const piece of ['Ana Cruz', 'Narra Sofa', 'Furniture subtotal: ₱10,000.00', 'Buyer total: ₱11,000.00',
    'Payment method: PayPal', 'Fulfilment: Store pickup', `${SITE}/portal#orders`]) {
    assert.ok(store.text.includes(piece), `store email is missing ${piece}`);
  }
  assert.match(store.text, /PayPal may deduct its own processing fee/);   // no promise of an exact settlement

  const [admin] = to('admin@furnishar.ph');
  assert.equal(admin.subject, 'FurnishAR payment received — ₱1,000.00 platform fee accrued (Order FUR-0001)');
  assert.match(admin.text, /₱1,000.00 FurnishAR service fee was recorded as accrued/);
  assert.match(admin.text, /Fee mode: Accrual/);
  assert.match(admin.text, /Status: Accrued/);
  assert.doesNotMatch(admin.text, /Status: (Collected|Received)|PayPal confirmed FurnishAR/);
  for (const piece of ['Store: SC Variety', 'Furniture subtotal: ₱10,000.00', 'Buyer paid: ₱11,000.00',
    'Store portion: ₱10,000.00', 'FurnishAR service fee: ₱1,000.00', 'Payment provider: PayPal']) {
    assert.ok(admin.text.includes(piece), `admin email is missing ${piece}`);
  }
  assert.ok(db.notifications.every(n => n.status === 'sent'));
});

test('platform split: "collected" only because PayPal reported the fee, and the wording says so', async () => {
  splitReported = true;
  paypalOrder.purchase_units[0].payment_instruction = { platform_fees: [{ amount: { currency_code: 'PHP', value: '1000.00' } }] };
  assert.equal((await capture()).status, 200);
  const [admin] = to('admin@furnishar.ph');
  assert.match(admin.subject, /platform fee collected/);
  assert.match(admin.text, /PayPal confirmed FurnishAR's ₱1,000.00 platform fee/);
  assert.match(admin.text, /Fee mode: PayPal platform split/);
  assert.match(admin.text, /Status: Collected/);
  const [store] = to('shop@gmail.com');
  assert.match(store.text, /PayPal confirmed the payment for this order and took FurnishAR's ₱1,000.00 service fee/);
});

/* --------------------------------------------------------- idempotency --- */

test('a page refresh, a capture retry and a redelivered webhook add no payment and no email', async () => {
  await capture();
  assert.equal(emails.length, 3);
  const refresh = await capture();                            // PayPal now says COMPLETED
  assert.equal(refresh.status, 200);
  await capture();
  const late = await webhook('WH-EVENT-1');                   // the webhook after the return
  assert.equal(late.status, 200);
  const again = await webhook('WH-EVENT-1');                  // PayPal redelivers it
  assert.deepEqual(again.body, { duplicate: true });
  assert.equal(db.payments.length, 1);
  assert.equal(emails.length, 3);
});

test('webhook first, return second: the same single payment and the same three emails', async () => {
  paypalOrder = captureBody();                                // PayPal captured; the buyer has not returned yet
  const hook = await webhook('WH-EVENT-2');
  assert.equal(hook.status, 200, JSON.stringify(hook.body));
  assert.match(hook.body.outcome, /recorded \(paid\)/);
  assert.equal(emails.length, 3);
  const back = await capture();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(db.payments.length, 1);
  assert.equal(emails.length, 3);
});

/* ------------------------------------------------------------- failures --- */

test('PayPal declined: no payment, no "payment received" email', async () => {
  captureMode = 'declined';
  const result = await capture();
  assert.equal(result.status, 402);
  assert.equal(db.payments.length, 0);
  assert.equal(db.attemptStatus, 'DECLINED');
  assert.equal(paymentReceived().length, 0);
});

test('PayPal pending: not paid yet, no confirmed-payment email', async () => {
  captureMode = 'pending';
  const result = await capture();
  assert.equal(result.status, 200);
  assert.equal(result.body.pending, true);
  assert.equal(db.payments.length, 0);
  assert.equal(emails.length, 0);
});

test('a captured amount that does not match the order is not applied and not announced', async () => {
  paypalOrder = captureBody();
  paypalOrder.purchase_units[0].amount.value = '100.00';
  paypalOrder.purchase_units[0].payments.captures[0].amount.value = '100.00';
  const result = await capture();
  assert.equal(result.status, 409);
  assert.equal(db.payments.length, 0);
  assert.equal(paymentReceived().length, 0);
  const hook = await webhook('WH-EVENT-3');
  assert.equal(hook.body.outcome, 'does not match the attempt');
  assert.equal(db.payments.length, 0);
  assert.equal(paymentReceived().length, 0);
  assert.equal(to('admin@furnishar.ph').filter(e => /needs attention/.test(e.subject)).length, 1);
});

test('the wrong currency is refused: no payment, no "payment received" email', async () => {
  paypalOrder.purchase_units[0].amount.currency_code = 'USD';
  const result = await capture();
  assert.equal(result.status, 409);
  assert.equal(db.payments.length, 0);
  assert.equal(paymentReceived().length, 0);
});

test('mail down: the payment stays recorded and paid; the emails are retried and sent once', async () => {
  mailDown = true;
  const result = await capture();
  assert.equal(result.status, 200);                           // the buyer's payment is not undone
  assert.equal(result.body.status, 'paid');
  assert.equal(db.order.status, 'paid');
  assert.equal(db.payments.length, 1);
  assert.equal(emails.length, 0);
  assert.ok(db.notifications.every(n => n.status === 'failed' && n.attempts === 1));

  mailDown = false;
  const retried = await dispatchPaymentNotifications({ site: SITE });   // the scheduled retry
  assert.equal(retried.sent, 3);
  assert.equal(emails.length, 3);
  await dispatchPaymentNotifications({ site: SITE });
  await capture();
  assert.equal(emails.length, 3);                             // never twice
});

/* ------------------------------------------------------- compatibility --- */

test('before 0017: the payment is still recorded (no processing fee) and emailed once', async () => {
  ledger = false;
  assert.equal((await capture()).status, 200);
  assert.equal(db.payments.length, 1);
  const records = rpcCalls.filter(c => c.fn === 'record_capture');
  assert.ok('p_processing_fee' in records[0].body);
  assert.ok(!('p_processing_fee' in records[1].body));        // retried without the 0016 argument
  const sent = emails.length;
  assert.ok(sent >= 2);                                       // the previous emails (buyer + shop + admin fee notice)
  await capture();
  assert.equal(emails.length, sent);
  assert.equal(recordedPayments(), 1);
});

/* ---------------------------------------------------------------- refunds --- */

test('a refund tells the superadmin what happened to FurnishAR\'s fee', async () => {
  splitReported = true;
  paypalOrder.purchase_units[0].payment_instruction = { platform_fees: [{ amount: { currency_code: 'PHP', value: '1000.00' } }] };
  await capture();
  emails = [];
  const refund = await payments.handleWebhook(SIGNED, JSON.stringify({
    id: 'WH-REFUND-1', event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'REFUND1', status: 'COMPLETED', amount: { currency_code: 'PHP', value: '11000.00' },
                links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAPTURE1' }] }
  }), SITE);
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const [admin] = to('admin@furnishar.ph');
  assert.match(admin.subject, /PayPal refund recorded/);
  assert.match(admin.text, /did not return FurnishAR's collected platform fee/);
  assert.equal(to('ana@gmail.com').length, 1);                // the buyer's refund email, once
});
