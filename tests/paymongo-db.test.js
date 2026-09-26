/**
 * GCash via PayMongo as FurnishAR's second payment provider — migration 0016.
 *
 * Same throwaway-Postgres approach as tests/billing.test.js. What this pins
 * down:
 *   - only an admin enables GCash for a store (no self-service onboarding);
 *   - a PayMongo attempt's payee and fee mode must match the store's setup;
 *   - a PayPal capture can never satisfy a PayMongo attempt, nor the reverse;
 *   - the fee is never recorded as "collected" on PayMongo's say-so: it is
 *     held (platform settlement) or expected via split;
 *   - PayMongo's processing fee is recorded as reported;
 *   - one order is paid once when a buyer switches between PayPal and GCash;
 *   - custom-order deposit and balance carry exactly the one 10% fee;
 *   - no trace of Maya is left in the schema.
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
const DB = 'furnishar_paymongo_test';
const SECRET = 'test-payment-recorder-secret';
const PLATFORM = 'furnishar-paymongo';

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
  ids.otherBuyer = user('ben@buyer.ph', '{"role":"buyer","full_name":"Ben Reyes","municipality":"Sablayan"}');
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
  // The brief's money example: a ₱10,000 piece.
  ids.product = psql(`insert into public.products (store_id, slug, name, category, price_php, stock,
                        width_cm, height_cm, depth_cm, status)
                      values ('${ids.storeA}', 'gcash-sofa', 'GCash Sofa', 'Sofa', 10000, 5, 200, 85, 90, 'published')
                      returning id`);
  as(ids.ownerB, `select public.save_store_billing('${ids.storeB}', 'custom', null, 'orders-b@shop.ph', 3, 1)`);
});

test.after(() => {
  if (available) psql(`drop database if exists ${DB}`, 'postgres');
});

/* The server's two PayMongo steps: record the checkout session it created,
   then the payment PayMongo confirmed (signed webhook / secret-key read). */
const attempt = (userId, order, stage, amount, { payee = PLATFORM, feeMode = 'platform_held', ref }) => {
  const fee = psql(`select public.stage_platform_fee('${order}', '${stage}')`);
  return as(userId, `select public.server_record_payment_attempt('${SECRET}', '${order}', '${stage}', 'sandbox',
    'cs_${ref}', ${amount}, ${fee}, '${feeMode}', '${payee}', 'paymongo', '${ref}')::text`);
};
const record = (userId, order, stage, amount, { ref, payment, payee = PLATFORM, provider = 'paymongo', currency = 'PHP', processingFee = 'null' }) =>
  as(userId, `select public.record_capture('${SECRET}', '${order}', '${stage}', 'cs_${ref}', '${payment}', ${amount},
    '${currency}', null, 'payer@gcash.ph', '${payee}', 'accrual', null, 'sandbox', '${provider}', ${processingFee})::text`);

it('no trace of Maya is left in the schema', () => {
  assert.equal(psql(`select count(*) from pg_proc where proname ilike '%maya%'`), '0');
  assert.equal(psql(`select count(*) from information_schema.columns where table_schema = 'public' and column_name ilike '%maya%'`), '0');
  assert.match(refused(ids.admin, `insert into public.store_payment_accounts (store_id, environment, provider)
    values ('${ids.storeA}', 'sandbox', 'maya')`), /permission denied|check constraint/);
  assert.equal(psql(`select count(*) from information_schema.columns where table_name = 'store_payment_accounts' and column_name = 'provider_profile'`), '0');
});

it('only an administrator can set up GCash for a store', () => {
  assert.equal(psql(`select public.store_accepts_provider('${ids.storeA}', 'paymongo', 'sandbox')`), 'f');
  assert.match(refused(ids.ownerA, `select public.admin_set_paymongo_account('${ids.storeA}', 'sandbox', true, 'platform')`),
    /platform administrator/);
  assert.match(refused(ids.ownerA, `insert into public.store_payment_accounts (store_id, environment, provider, onboarding_status)
    values ('${ids.storeA}', 'sandbox', 'paymongo', 'CONNECTED')`), /permission denied/);
  assert.match(refused(ids.admin, `select public.admin_set_paymongo_account('${ids.storeB}', 'sandbox', true, 'split')`),
    /child-merchant ID/);
  assert.match(refused(ids.admin, `select public.admin_set_paymongo_account('${ids.storeA}', 'sandbox', true, 'anything')`),
    /Choose how the store is paid/);

  as(ids.admin, `select public.admin_set_paymongo_account('${ids.storeA}', 'sandbox', true, 'platform')`);
  assert.equal(psql(`select public.store_accepts_provider('${ids.storeA}', 'paymongo', 'sandbox')`), 't');
  assert.equal(psql(`select public.store_accepts_provider('${ids.storeA}', 'paymongo', 'live')`), 'f');
  assert.equal(as(null, `select public.store_payment_providers('${ids.storeA}', 'sandbox', 'sandbox')::text`), '{paymongo}');
  assert.equal(as(ids.admin, `select count(*) from public.admin_audit where action = 'paymongo.enabled'`), '1');
  assert.equal(as(ids.ownerA, `select settlement_mode from public.store_payment_accounts where provider = 'paymongo'`), 'platform');
  assert.equal(as(ids.ownerB, `select count(*) from public.store_payment_accounts where provider = 'paymongo'`), '0');
});

it('₱10,000 piece: the database says ₱10,000 + ₱1,000 fee = ₱11,000, payable to FurnishAR\'s PayMongo account', () => {
  ids.order = JSON.parse(as(ids.buyer, `select public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)::text`)).order_id;
  const order = JSON.parse(psql(`select row_to_json(o) from public.orders o where id = '${ids.order}'`));
  assert.equal(Number(order.subtotal), 10000);
  assert.equal(Number(order.platform_fee), 1000);
  assert.equal(Number(order.total), 11000);
  const due = JSON.parse(as(ids.buyer, `select public.begin_payment('${ids.order}', 'sandbox', 'paymongo')::text`));
  assert.equal(due.stage, 'full');
  assert.equal(Number(due.amount), 11000);
  assert.equal(Number(due.platform_fee), 1000);
  assert.equal(due.provider, 'paymongo');
  assert.equal(due.settlement_mode, 'platform');
  assert.match(refused(ids.buyer, `select public.begin_payment('${ids.order}', 'sandbox', 'maya')`), /Unknown payment method/);
  assert.match(refused(ids.otherBuyer, `select public.begin_payment('${ids.order}', 'sandbox', 'paymongo')`), /not yours/);
});

it('a PayMongo attempt must pay FurnishAR\'s account, as GCash, with the held fee mode', () => {
  const bad = (payee, feeMode, ref, method = 'null') => `select public.server_record_payment_attempt('${SECRET}', '${ids.order}', 'full', 'sandbox',
    'cs_${ref || 'none'}', 11000, 1000, '${feeMode}', '${payee}', 'paymongo', ${ref ? `'${ref}'` : 'null'}, ${method})`;
  assert.match(refused(ids.buyer, bad('SHOP', 'platform_held', 'FA-X1')), /wrong account/);
  assert.match(refused(ids.buyer, bad(PLATFORM, 'accrual', 'FA-X2')), /wrong account/);
  assert.match(refused(ids.buyer, bad(PLATFORM, 'platform_split', 'FA-X3')), /wrong account/);
  assert.match(refused(ids.buyer, bad(PLATFORM, 'platform_held', null)), /wrong account/);
  assert.match(refused(ids.buyer, bad(PLATFORM, 'platform_held', 'FA-X4', `'paypal'`)), /wrong account/);
  assert.match(refused(ids.otherBuyer, bad(PLATFORM, 'platform_held', 'FA-X5')), /not yours/);
  // The fee is the database's, never the caller's.
  assert.match(refused(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${ids.order}', 'full', 'sandbox',
    'cs_FA-X6', 11000, 1, 'platform_held', '${PLATFORM}', 'paymongo', 'FA-X6')`), /Unexpected fee/);

  attempt(ids.buyer, ids.order, 'full', 11000, { ref: 'FA-A-F1' });
  const found = JSON.parse(as(null, `select public.server_payment_attempt_by_reference('${SECRET}', 'paymongo', 'FA-A-F1')::text`));
  assert.equal(found.order_id, ids.order);
  assert.equal(found.provider, 'paymongo');
  assert.equal(found.payment_method, 'gcash');
  assert.equal(found.fee_mode, 'platform_held');
  assert.equal(found.payee_merchant_id, PLATFORM);
});

it('a PayPal capture cannot satisfy a PayMongo attempt; a PayMongo payment needs its attempt', () => {
  assert.match(refused(null, `select public.record_capture('${SECRET}', '${ids.order}', 'full', 'cs_FA-A-F1', 'pay_PP', 11000,
    'PHP', null, null, '${PLATFORM}', 'accrual', null, 'sandbox', 'paypal')`), /wrong account/);
  assert.match(refused(null, `select public.record_capture('${SECRET}', '${ids.order}', 'full', 'cs_NOPE', 'pay_N', 11000,
    'PHP', null, null, '${PLATFORM}', 'accrual', null, 'sandbox', 'paymongo')`), /Unknown PayMongo payment/);
  assert.throws(() => record(null, ids.order, 'full', 11000, { ref: 'FA-A-F1', payment: 'pay_X', payee: 'SHOP' }));
  assert.throws(() => record(null, ids.order, 'full', 11000, { ref: 'FA-A-F1', payment: 'pay_USD', currency: 'USD' }));
  assert.equal(psql(`select status from public.orders where id = '${ids.order}'`), 'pending_payment');
});

it('a GCash payment for the wrong amount is recorded but never applied', () => {
  const short = JSON.parse(record(null, ids.order, 'full', 100, { ref: 'FA-A-F1', payment: 'pay_SHORT' }));
  assert.equal(short.applied, false);
  assert.equal(psql(`select status from public.orders where id = '${ids.order}'`), 'pending_payment');
});

it('a verified GCash payment pays the order once; the fee is held, never "collected"', () => {
  const paid = JSON.parse(record(null, ids.order, 'full', 11000, { ref: 'FA-A-F1', payment: 'pay_OK', processingFee: 275 }));
  assert.equal(paid.applied, true);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.fee_mode, 'platform_held');
  const row = JSON.parse(psql(`select row_to_json(p) from public.payments p where capture_id = 'pay_OK'`));
  assert.equal(row.provider, 'paymongo');
  assert.equal(row.payment_method, 'gcash');
  assert.equal(row.platform_fee_collected, null);
  assert.equal(Number(row.processing_fee), 275);
  // Stock was held at order creation and is not taken again.
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '4');

  const again = JSON.parse(record(null, ids.order, 'full', 11000, { ref: 'FA-A-F1', payment: 'pay_OK', processingFee: 275 }));
  assert.equal(again.duplicate, true);
  assert.equal(psql(`select amount_paid from public.orders where id = '${ids.order}'`), '11000.00');
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '4');
  assert.match(refused(null, `select public.record_capture('${SECRET}', '${ids.order}', 'full', 'cs_FA-A-F1', 'pay_OK', 11000,
    'PHP', null, null, '${PLATFORM}', 'accrual', null, 'sandbox', 'paypal')`), /another payment method/);

  const summary = JSON.parse(as(ids.ownerA, `select public.store_fee_summary('${ids.storeA}')::text`));
  assert.equal(Number(summary.accrued), 0);
  assert.equal(Number(summary.collected), 0);       // not collected…
  assert.equal(Number(summary.held), 1000);         // …accrued and held in FurnishAR's PayMongo balance
  assert.equal(Number(summary.owed_to_store), 10000);
  assert.equal(Number(summary.processing_fees), 275); // reported, not netted away silently

  const contacts = JSON.parse(psql(`select public.order_contacts_for('${ids.order}')::text`));
  assert.ok(contacts.payments.some(p => p.provider === 'paymongo' && p.payment_method === 'gcash' && p.applied));
});

it('switching methods: PayPal abandoned, GCash paid — one order, paid once; a late second success is never applied', () => {
  // A fresh order; the store also takes PayPal.
  psql(`select public.server_record_payment_account('${SECRET}', 'sandbox', '${ids.storeA}', null, 'MERCHANTA1',
    'CONNECTED', true, true, false, null)`);
  const order = JSON.parse(as(ids.buyer, `select public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)::text`)).order_id;
  const fee = psql(`select public.stage_platform_fee('${order}', 'full')`);
  as(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order}', 'full', 'sandbox',
    'PP-ABANDONED', 11000, ${fee}, 'accrual', 'MERCHANTA1')`);
  attempt(ids.buyer, order, 'full', 11000, { ref: 'FA-SW-F1' });
  assert.equal(JSON.parse(record(null, order, 'full', 11000, { ref: 'FA-SW-F1', payment: 'pay_SW' })).status, 'paid');
  // The buyer also completes the abandoned PayPal payment later: recorded, not applied.
  const late = JSON.parse(as(null, `select public.record_capture('${SECRET}', '${order}', 'full', 'PP-ABANDONED', 'CAP-LATE', 11000,
    'PHP', null, null, 'MERCHANTA1', 'accrual', null, 'sandbox', 'paypal')::text`));
  assert.equal(late.applied, false);
  assert.equal(psql(`select amount_paid from public.orders where id = '${order}'`), '11000.00');
  assert.equal(psql(`select count(*) from public.payments where order_id = '${order}' and applied`), '1');
  assert.equal(psql(`select count(*) from public.orders where buyer_id = '${ids.buyer}'`), '2');

  // …and the other way round: GCash pending, PayPal succeeds, GCash lands late.
  const order2 = JSON.parse(as(ids.buyer, `select public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)::text`)).order_id;
  attempt(ids.buyer, order2, 'full', 11000, { ref: 'FA-SW-F2' });
  as(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order2}', 'full', 'sandbox',
    'PP-WINS', 11000, ${fee}, 'accrual', 'MERCHANTA1')`);
  assert.equal(JSON.parse(as(null, `select public.record_capture('${SECRET}', '${order2}', 'full', 'PP-WINS', 'CAP-WINS', 11000,
    'PHP', null, null, 'MERCHANTA1', 'accrual', null, 'sandbox', 'paypal')::text`)).applied, true);
  assert.equal(JSON.parse(record(null, order2, 'full', 11000, { ref: 'FA-SW-F2', payment: 'pay_LATE' })).applied, false);
  assert.equal(psql(`select count(*) from public.payments where order_id = '${order2}' and applied`), '1');
});

it('only an admin records a payout to a shop, and it reduces what is owed', () => {
  assert.match(refused(ids.ownerA, `select public.record_store_remittance('${ids.storeA}', 6000, 'BDO 123', null)`),
    /platform administrator/);
  as(ids.admin, `select public.record_store_remittance('${ids.storeA}', 6000, 'BDO 123', 'September')`);
  const summary = JSON.parse(as(ids.ownerA, `select public.store_fee_summary('${ids.storeA}')::text`));
  // Two GCash sales held (the first order and the switched one): 2 × ₱10,000 share, less the payout.
  assert.equal(Number(summary.owed_to_store), 14000);
  const overview = JSON.parse(as(ids.admin, `select json_agg(f)::text from public.fee_overview() f where store_id = '${ids.storeA}'`))[0];
  assert.equal(Number(overview.gcash_sales), 22000);
  assert.equal(Number(overview.paypal_sales), 11000);
  assert.equal(Number(overview.held), 2000);
  assert.equal(Number(overview.owed_to_store), 14000);
  assert.equal(Number(overview.processing_fees), 275);
  assert.equal(overview.paymongo_status, 'CONNECTED');
  assert.equal(overview.paymongo_settlement, 'platform');
});

it('a GCash refund is recorded once, with its fee portion', () => {
  const first = JSON.parse(psql(`select public.server_record_refund('${SECRET}', 'pay_OK', 'ref_1', 11000, 'PHP', null, 'COMPLETED')::text`));
  assert.equal(first.completed, true);
  assert.equal(Number(first.platform_fee_refunded), 1000);
  assert.equal(JSON.parse(psql(`select public.server_record_refund('${SECRET}', 'pay_OK', 'ref_1', 11000, 'PHP', null, 'COMPLETED')::text`)).duplicate, true);
  assert.equal(psql(`select refund_status from public.orders where id = '${ids.order}'`), 'full');
});

it('custom build by GCash split: deposit and balance carry the one 10% fee, expected via split, never collected', () => {
  as(ids.admin, `select public.admin_set_paymongo_account('${ids.storeB}', 'sandbox', true, 'split', 'org_child_b')`);
  const order = JSON.parse(as(ids.buyer, `select public.create_custom_request('${ids.storeB}', null,
    '{"width_cm":"180","notes":"Narra table"}', 'pickup', null, null, '0917 123 4567', null)::text`)).order_id;
  as(ids.ownerB, `select public.quote_custom_order('${order}', 10000, 14, null)`);
  const due = JSON.parse(as(ids.buyer, `select public.begin_payment('${order}', 'sandbox', 'paymongo')::text`));
  assert.equal(due.stage, 'deposit');
  assert.equal(due.settlement_mode, 'split');
  assert.equal(due.provider_account_ref, 'org_child_b');
  const depositFee = Number(due.platform_fee);

  assert.match(refused(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order}', 'deposit', 'sandbox',
    'cs_B-D0', ${due.amount}, ${depositFee}, 'platform_held', '${PLATFORM}', 'paymongo', 'B-D0')`), /wrong account/);
  attempt(ids.buyer, order, 'deposit', due.amount, { ref: 'B-D1', payee: 'org_child_b', feeMode: 'provider_split' });
  assert.equal(JSON.parse(record(null, order, 'deposit', due.amount, { ref: 'B-D1', payment: 'pay_BD', payee: 'org_child_b' })).status, 'deposit_paid');

  as(ids.ownerB, `select public.mark_order_ready('${order}')`);
  const balance = JSON.parse(as(ids.buyer, `select public.begin_payment('${order}', 'sandbox', 'paymongo')::text`));
  attempt(ids.buyer, order, 'balance', balance.amount, { ref: 'B-B1', payee: 'org_child_b', feeMode: 'provider_split' });
  assert.equal(JSON.parse(record(null, order, 'balance', balance.amount, { ref: 'B-B1', payment: 'pay_BB', payee: 'org_child_b' })).status, 'paid');

  assert.equal(depositFee + Number(balance.platform_fee), 1000);   // one fee, split across the stages
  const summary = JSON.parse(as(ids.ownerB, `select public.store_fee_summary('${ids.storeB}')::text`));
  assert.equal(Number(summary.collected), 0);
  assert.equal(Number(summary.held), 0);
  assert.equal(Number(summary.expected_via_split), 1000);
  assert.equal(Number(summary.owed_to_store), 0);   // PayMongo pays the child merchant directly
});

it('turning GCash off closes checkout for a GCash-only store', () => {
  as(ids.admin, `select public.admin_set_paymongo_account('${ids.storeB}', 'sandbox', false, null)`);
  assert.equal(psql(`select public.store_accepts_payments('${ids.storeB}')`), 'f');
  assert.equal(as(ids.admin, `select count(*) from public.admin_audit where action = 'paymongo.disabled'`), '1');
});
