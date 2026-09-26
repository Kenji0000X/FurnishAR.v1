/**
 * PayPal payment split and "payment received" notifications — migration 0017.
 *
 * Same throwaway-Postgres approach as tests/marketplace.test.js. Pinned down:
 *   - the brief's example: a ₱10,000 piece → subtotal 10000, fee 1000 (10% of
 *     the subtotal, never of the total), total 11000;
 *   - each payment row proves the split: store_portion 10000, platform_fee
 *     1000, fee_status "collected" only when PayPal reported the fee;
 *   - one verified payment queues exactly one buyer, one store and one admin
 *     notification, written with the payment; a duplicate capture, webhook or
 *     refresh never queues a second set;
 *   - each notification is claimed by one caller only; a failure is retried,
 *     a success never is;
 *   - declined / mismatched / wrong-currency payments queue no
 *     "payment received" email;
 *   - a custom order's deposit and balance fees add up to the one order fee;
 *   - a refund returns PayPal's collected fee only when PayPal says so.
 *
 * Skipped when no local Postgres is reachable (see tests/db.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONN = process.env.FURNISHAR_TEST_PG || 'postgresql://postgres@localhost:55432/postgres?host=/tmp';
const DB = 'furnishar_paypal_notify_test';
const SECRET = 'test-payment-recorder-secret';

const dbUrl = db => CONN.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);

function psql(sql, db = DB) {
  return execFileSync('psql', [dbUrl(db), '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function as(userId, sql) {
  const role = userId ? 'authenticated' : 'anon';
  const claims = userId ? `{"sub":"${userId}","role":"authenticated"}` : '{"role":"anon"}';
  const out = psql(`begin; set local role ${role}; set local request.jwt.claims = '${claims}'; ${sql}; commit;`);
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

function refused(userId, sql) {
  try {
    as(userId, sql);
    return null;
  } catch (error) {
    return String(error.stderr || error.message);
  }
}

const json = (userId, sql) => JSON.parse(as(userId, `select (${sql})::text`));

let available = true;
try {
  psql('select 1', 'postgres');
} catch {
  available = false;
}
const it = available ? test : test.skip;
const ids = {};

test.before(() => {
  if (!available) return;
  psql(`drop database if exists ${DB}`, 'postgres');
  psql(`create database ${DB}`, 'postgres');
  const files = ['tests/supabase-local.sql',
    ...fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
      .map(f => `supabase/migrations/${f}`),
    'supabase/seed.sql'];
  for (const file of files) {
    execFileSync('psql', [dbUrl(DB), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, file)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const user = (email, meta = '{}') =>
    psql(`insert into auth.users (email, raw_user_meta_data) values ('${email}', '${meta}') returning id`);
  ids.buyer = user('ana@buyer.ph', '{"role":"buyer","full_name":"Ana Cruz","municipality":"Mamburao"}');
  ids.ownerA = user('owner-a@shop.ph');
  ids.ownerB = user('owner-b@shop.ph');
  ids.admin = user('admin@furnishar.ph');
  ids.storeA = psql(`select id from public.stores where slug = 'sc-variety'`);
  ids.storeB = psql(`select id from public.stores where slug = 'tiampion'`);
  psql(`insert into public.store_members (store_id, user_id) values
        ('${ids.storeA}', '${ids.ownerA}'), ('${ids.storeB}', '${ids.ownerB}')`);
  psql(`insert into public.platform_admins (user_id, email) values ('${ids.admin}', 'admin@furnishar.ph')`);
  psql(`insert into billing_private.secrets (name, sha256_hex)
        values ('payment_recorder', encode(sha256(convert_to('${SECRET}', 'UTF8')), 'hex'))`);
  ids.product = psql(`insert into public.products (store_id, slug, name, category, price_php, stock,
                        width_cm, height_cm, depth_cm, status)
                      values ('${ids.storeA}', 'paypal-sofa', 'PayPal Sofa', 'Sofa', 10000, 20, 200, 85, 90, 'published')
                      returning id`);
  as(ids.ownerB, `select public.save_store_billing('${ids.storeB}', 'custom', null, 'orders-b@shop.ph', 3, 1)`);
  const connect = (store, merchant) => as(null, `select public.server_record_payment_account('${SECRET}',
    'sandbox', '${store}', null, '${merchant}', 'CONNECTED', true, true, true, null)::text`);
  connect(ids.storeA, 'MERCHANTA1');
  connect(ids.storeB, 'MERCHANTB1');
});

test.after(() => {
  if (available) psql(`drop database if exists ${DB}`, 'postgres');
});

const newOrder = () => json(ids.buyer,
  `public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)`).order_id;

/* The server's two PayPal steps: the attempt before the buyer leaves, then
   the capture PayPal confirmed. */
function pay(order, stage, amount, { merchant = 'MERCHANTA1', mode = 'accrual', collected = 'null', captureId, currency = 'PHP' }) {
  const fee = psql(`select public.stage_platform_fee('${order}', '${stage}')`);
  const providerOrder = `PP${captureId}`;
  as(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order}', '${stage}', 'sandbox',
    '${providerOrder}', ${amount}, ${fee}, '${mode}', '${merchant}')`);
  return json(null, `public.record_capture('${SECRET}', '${order}', '${stage}', '${providerOrder}', '${captureId}',
    ${amount}, '${currency}', null, 'payer@example.ph', '${merchant}', '${mode}', ${collected}, 'sandbox')`);
}

const notifications = capture => psql(`select coalesce(string_agg(audience || ':' || event || ':' || status, ',' order by audience), '')
  from public.payment_notifications where capture_id = '${capture}'`);
const claim = (capture = null) => json(null,
  `public.server_claim_payment_notifications('${SECRET}', ${capture ? `'${capture}'` : 'null'}, 25)`);
const finish = (id, status, error = null) => as(null,
  `select public.server_finish_payment_notification('${SECRET}', ${id}, '${status}', ${error ? `'${error}'` : 'null'})`);
const paymentRow = capture => JSON.parse(psql(`select row_to_json(p) from (select amount, platform_fee, store_portion,
  fee_mode, fee_status, platform_fee_collected, refunded_platform_fee from public.payments where capture_id = '${capture}') p`));

it('₱10,000 furniture: fee is 10% of the subtotal, the buyer pays ₱11,000', () => {
  const order = newOrder();
  const row = JSON.parse(psql(`select row_to_json(o) from (select subtotal, platform_fee, total from public.orders where id = '${order}') o`));
  assert.deepEqual([Number(row.subtotal), Number(row.platform_fee), Number(row.total)], [10000, 1000, 11000]);
  ids.order = order;
});

it('a verified payment records the split and queues one buyer, one store and one admin email', () => {
  const recorded = pay(ids.order, 'full', 11000, { captureId: 'CAPACC1' });
  assert.equal(recorded.status, 'paid');
  assert.equal(recorded.duplicate, false);
  const p = paymentRow('CAPACC1');
  assert.deepEqual([Number(p.amount), Number(p.store_portion), Number(p.platform_fee)], [11000, 10000, 1000]);
  assert.equal(p.fee_mode, 'accrual');
  assert.equal(p.fee_status, 'accrued');                      // never "collected" without PayPal saying so
  assert.equal(notifications('CAPACC1'), 'admin:paid:pending,buyer:paid:pending,store:paid:pending');
  // Stock was taken once, when the order was placed, not again by the payment.
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '19');
});

it('a duplicate capture, refresh or webhook records nothing new and queues nothing new', () => {
  const again = pay(ids.order, 'full', 11000, { captureId: 'CAPACC1' });
  assert.equal(again.duplicate, true);
  assert.equal(psql(`select count(*) from public.payments where capture_id = 'CAPACC1'`), '1');
  assert.equal(psql(`select count(*) from public.payment_notifications where capture_id = 'CAPACC1'`), '3');
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '19');
});

it('each notification is handed to exactly one caller; a sent one is never sent again', () => {
  const first = claim('CAPACC1');
  assert.equal(first.length, 3);
  assert.deepEqual(first.map(r => r.audience).sort(), ['admin', 'buyer', 'store']);
  assert.equal(claim('CAPACC1').length, 0);                  // the racing return / webhook gets nothing
  for (const row of first) finish(row.id, 'sent');
  assert.equal(notifications('CAPACC1'), 'admin:paid:sent,buyer:paid:sent,store:paid:sent');
  assert.equal(claim('CAPACC1').length, 0);
  assert.equal(claim().length, 0);                            // nor the scheduled retry
});

it('an email that failed is retried, up to five attempts; one that is stuck mid-send is reclaimed', () => {
  const order = newOrder();
  pay(order, 'full', 11000, { captureId: 'CAPRETRY1' });
  const [buyer] = claim('CAPRETRY1').filter(r => r.audience === 'buyer');
  finish(buyer.id, 'failed', 'gmail');
  const retry = claim('CAPRETRY1');
  assert.deepEqual(retry.map(r => [r.audience, r.attempts]), [['buyer', 2]]);
  for (let i = 0; i < 3; i += 1) {
    finish(retry[0].id, 'failed', 'gmail');
    claim('CAPRETRY1');
  }
  finish(retry[0].id, 'failed', 'gmail');
  assert.equal(psql(`select attempts from public.payment_notifications where id = ${buyer.id}`), '5');
  assert.equal(claim('CAPRETRY1').length, 0);                 // gave up after five; the payment is untouched
  assert.equal(psql(`select status from public.orders where id = '${order}'`), 'paid');

  // A server that died while sending leaves "sending"; ten minutes on, it is claimed again.
  psql(`update public.payment_notifications set claimed_at = now() - interval '11 minutes'
         where capture_id = 'CAPRETRY1' and status = 'sending'`);
  assert.equal(claim('CAPRETRY1').length, 2);
});

it('"collected" only when PayPal reported exactly the fee', () => {
  const split = newOrder();
  pay(split, 'full', 11000, { mode: 'platform_split', collected: 1000, captureId: 'CAPSPLIT1' });
  const p = paymentRow('CAPSPLIT1');
  assert.equal(p.fee_status, 'collected');
  assert.equal(Number(p.platform_fee_collected), 1000);
  assert.equal(Number(p.store_portion), 10000);

  const unreported = newOrder();
  pay(unreported, 'full', 11000, { mode: 'platform_split', collected: 'null', captureId: 'CAPSPLIT2' });
  assert.equal(paymentRow('CAPSPLIT2').fee_status, 'accrued');
  const short = newOrder();
  pay(short, 'full', 11000, { mode: 'platform_split', collected: 500, captureId: 'CAPSPLIT3' });
  assert.equal(paymentRow('CAPSPLIT3').fee_status, 'accrued');
});

it('a capture for the wrong amount is not applied and queues no "payment received" email', () => {
  const order = newOrder();
  const fee = psql(`select public.stage_platform_fee('${order}', 'full')`);
  as(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order}', 'full', 'sandbox',
    'PPCAPSHORT1', 11000, ${fee}, 'accrual', 'MERCHANTA1')`);
  const recorded = json(null, `public.record_capture('${SECRET}', '${order}', 'full', 'PPCAPSHORT1', 'CAPSHORT1',
    100, 'PHP', null, 'payer@example.ph', 'MERCHANTA1', 'accrual', null, 'sandbox')`);
  assert.equal(recorded.applied, false);
  assert.equal(psql(`select status from public.orders where id = '${order}'`), 'pending_payment');
  assert.equal(paymentRow('CAPSHORT1').fee_status, 'none');
  assert.equal(notifications('CAPSHORT1'), 'store:unapplied:pending');   // the shop is asked to refund it
});

it('a capture in the wrong currency is refused: no payment, no email', () => {
  const order = newOrder();
  assert.match(refused(null, `select public.record_capture('${SECRET}', '${order}', 'full', 'PPX', 'CAPUSD1',
    11000, 'USD', null, 'payer@example.ph', 'MERCHANTA1', 'accrual', null, 'sandbox')`), /Unexpected payment/);
  assert.equal(psql(`select count(*) from public.payments where capture_id = 'CAPUSD1'`), '0');
  assert.equal(notifications('CAPUSD1'), '');
});

it('a custom order: deposit fee + balance fee is exactly the one order fee, one email set per stage', () => {
  const order = json(ids.buyer, `public.create_custom_request('${ids.storeB}', null, '{"notes":"Dining table"}',
    'pickup', null, null, '0917 123 4567', null)`).order_id;
  as(ids.ownerB, `select public.quote_custom_order('${order}', 10000, 14, null)`);
  const quoted = JSON.parse(psql(`select row_to_json(o) from (select platform_fee, total, deposit_amount from public.orders where id = '${order}') o`));
  assert.equal(Number(quoted.platform_fee), 1000);
  assert.equal(Number(quoted.total), 11000);
  pay(order, 'deposit', Number(quoted.deposit_amount), { merchant: 'MERCHANTB1', captureId: 'CAPDEP1' });
  as(ids.ownerB, `select public.mark_order_ready('${order}')`);
  const balance = 11000 - Number(quoted.deposit_amount);
  pay(order, 'balance', balance, { merchant: 'MERCHANTB1', captureId: 'CAPBAL1' });
  const fees = psql(`select sum(platform_fee) from public.payments where order_id = '${order}' and applied`);
  assert.equal(Number(fees), 1000);                          // never 10% twice
  const portions = psql(`select sum(store_portion) from public.payments where order_id = '${order}' and applied`);
  assert.equal(Number(portions), 10000);
  assert.equal(notifications('CAPDEP1'), 'admin:deposit_paid:pending,buyer:deposit_paid:pending,store:deposit_paid:pending');
  assert.equal(notifications('CAPBAL1'), 'admin:paid:pending,buyer:paid:pending,store:paid:pending');
});

it('a refund: PayPal\'s collected fee counts as returned only when PayPal says so', () => {
  const refund = (capture, id, amount, fee) => json(null, `public.server_record_refund('${SECRET}', '${capture}', '${id}',
    ${amount}, 'PHP', ${fee}, 'COMPLETED', 'refund')`);
  const kept = refund('CAPSPLIT1', 'REF1', 11000, 'null');
  assert.equal(Number(kept.platform_fee_refunded), 0);
  assert.equal(paymentRow('CAPSPLIT1').fee_status, 'collected');   // PayPal kept FurnishAR's fee

  refund('CAPSPLIT2', 'REF2', 11000, 'null');                      // accrued: the shop no longer owes it
  assert.equal(paymentRow('CAPSPLIT2').fee_status, 'refunded');

  const order = newOrder();
  pay(order, 'full', 11000, { mode: 'platform_split', collected: 1000, captureId: 'CAPSPLIT4' });
  const returned = refund('CAPSPLIT4', 'REF4', 11000, 1000);
  assert.equal(Number(returned.platform_fee_refunded), 1000);
  assert.equal(paymentRow('CAPSPLIT4').fee_status, 'refunded');
  assert.deepEqual(refund('CAPSPLIT4', 'REF4', 11000, 1000), { duplicate: true });
});

it('only the server can claim notifications, and only admins can read them', () => {
  assert.match(refused(null, `select public.server_claim_payment_notifications('guess', null, 5)`), /secret|Only the FurnishAR server|permission/i);
  assert.match(refused(ids.buyer, `insert into public.payment_notifications (capture_id, order_id, audience, event)
    values ('CAPACC1', '${ids.order}', 'buyer', 'paid')`), /permission denied/);
  assert.equal(as(ids.buyer, 'select count(*) from public.payment_notifications'), '0');
  assert.equal(as(ids.ownerA, 'select count(*) from public.payment_notifications'), '0');
  assert.ok(Number(as(ids.admin, 'select count(*) from public.payment_notifications')) > 0);
});
