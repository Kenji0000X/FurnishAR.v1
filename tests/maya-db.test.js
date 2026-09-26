/**
 * Maya as a second payment provider — supabase/migrations/0015.
 *
 * Same throwaway-Postgres approach as tests/billing.test.js. What this pins
 * down: only an admin enables Maya; the payee and the fee mode of a Maya
 * attempt must be what the store's Maya setup says; a PayPal capture can
 * never satisfy a Maya attempt (nor the other way round); platform collect
 * records the fee as collected and the store's share as OWED to the store;
 * PayFac with provider settlement never records anything as collected.
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
const DB = 'furnishar_maya_test';
const SECRET = 'test-payment-recorder-secret';
const PLATFORM = 'furnishar-platform';

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
  ids.product = psql(`insert into public.products (store_id, slug, name, category, price_php, stock,
                        width_cm, height_cm, depth_cm, status)
                      values ('${ids.storeA}', 'maya-bench', 'Maya Bench', 'Bench', 1000, 5, 120, 45, 40, 'published')
                      returning id`);
  as(ids.ownerB, `select public.save_store_billing('${ids.storeB}', 'custom', null, 'orders-b@shop.ph', 3, 1)`);
});

test.after(() => {
  if (available) psql(`drop database if exists ${DB}`, 'postgres');
});

/* The server's Maya steps: record the checkout it created, then the payment
   Maya confirmed (re-read with the secret key). */
const attempt = (userId, order, stage, amount, { payee = PLATFORM, feeMode = 'platform_collect', ref }) => {
  const fee = psql(`select public.stage_platform_fee('${order}', '${stage}')`);
  return as(userId, `select public.server_record_payment_attempt('${SECRET}', '${order}', '${stage}', 'sandbox',
    'CHK-${ref}', ${amount}, ${fee}, '${feeMode}', '${payee}', 'maya', '${ref}')::text`);
};
const record = (userId, order, stage, amount, { ref, payment, payee = PLATFORM, provider = 'maya', currency = 'PHP' }) =>
  as(userId, `select public.record_capture('${SECRET}', '${order}', '${stage}', 'CHK-${ref}', '${payment}', ${amount},
    '${currency}', null, 'payer@maya.ph', '${payee}', 'accrual', null, 'sandbox', '${provider}')::text`);

it('only an administrator can set up Maya for a store', () => {
  assert.equal(psql(`select public.store_accepts_provider('${ids.storeA}', 'maya', 'sandbox')`), 'f');
  assert.match(refused(ids.ownerA, `select public.admin_set_maya_account('${ids.storeA}', 'sandbox', true, 'platform_collect')`),
    /platform administrator/);
  assert.match(refused(ids.ownerA, `insert into public.store_payment_accounts (store_id, environment, provider, onboarding_status)
    values ('${ids.storeA}', 'sandbox', 'maya', 'CONNECTED')`), /permission denied/);
  // PayFac needs the sub-merchant and its registered city and postal code.
  assert.match(refused(ids.admin, `select public.admin_set_maya_account('${ids.storeB}', 'sandbox', true, 'payfac')`),
    /sub-merchant ID/);
  assert.match(refused(ids.admin, `select public.admin_set_maya_account('${ids.storeB}', 'sandbox', true, 'payfac', 'SM-B-001', 'Mamburao', '51')`),
    /4-digit postal code/);
  assert.match(refused(ids.admin, `select public.admin_set_maya_account('${ids.storeA}', 'sandbox', true, 'free_money')`),
    /Choose how the store is paid/);

  as(ids.admin, `select public.admin_set_maya_account('${ids.storeA}', 'sandbox', true, 'platform_collect')`);
  assert.equal(psql(`select public.store_accepts_provider('${ids.storeA}', 'maya', 'sandbox')`), 't');
  assert.equal(psql(`select public.store_accepts_provider('${ids.storeA}', 'maya', 'live')`), 'f');
  assert.equal(psql(`select public.store_accepts_provider('${ids.storeA}', 'paypal', 'sandbox')`), 'f');
  assert.equal(as(null, `select public.store_payment_providers('${ids.storeA}', 'sandbox', 'sandbox')::text`), '{maya}');
  assert.equal(as(ids.admin, `select count(*) from public.admin_audit where action = 'maya.enabled'`), '1');
  // The store sees its own Maya row; another store does not.
  assert.equal(as(ids.ownerA, `select settlement_mode from public.store_payment_accounts where provider = 'maya'`), 'platform_collect');
  assert.equal(as(ids.ownerB, `select count(*) from public.store_payment_accounts where provider = 'maya'`), '0');
});

it('a Maya-only store takes orders; what is due and who is paid come from the database', () => {
  ids.order = JSON.parse(as(ids.buyer, `select public.create_stock_order('${ids.product}', 2, 'pickup', null, null, '0917 123 4567', null)::text`)).order_id;
  const due = JSON.parse(as(ids.buyer, `select public.begin_payment('${ids.order}', 'sandbox', 'maya')::text`));
  assert.equal(due.stage, 'full');
  assert.equal(Number(due.amount), 2200);
  assert.equal(Number(due.platform_fee), 200);
  assert.equal(due.provider, 'maya');
  assert.equal(due.settlement_mode, 'platform_collect');
  assert.equal(due.merchant_id, null);
  // Not a PayPal store, and not an unknown method.
  assert.match(refused(ids.buyer, `select public.begin_payment('${ids.order}', 'sandbox', 'paypal')`), /PayPal setup/);
  assert.match(refused(ids.buyer, `select public.begin_payment('${ids.order}', 'sandbox', 'gcash')`), /Unknown payment method/);
  assert.match(refused(ids.otherBuyer, `select public.begin_payment('${ids.order}', 'sandbox', 'maya')`), /not yours/);
});

it('a Maya attempt must pay FurnishAR\'s account with the platform-collect fee mode', () => {
  assert.match(refused(ids.buyer, attemptSql('SHOPMERCHANT', 'platform_collect', 'FA-X-F1')), /wrong account/);
  assert.match(refused(ids.buyer, attemptSql(PLATFORM, 'accrual', 'FA-X-F2')), /wrong account/);
  assert.match(refused(ids.buyer, attemptSql(PLATFORM, 'platform_collect', null)), /wrong account/);
  assert.match(refused(ids.otherBuyer, attemptSql(PLATFORM, 'platform_collect', 'FA-X-F3')), /not yours/);
  assert.match(refused(ids.buyer, `select public.server_record_payment_attempt('guess', '${ids.order}', 'full', 'sandbox',
    'CHK-G', 2200, 200, 'platform_collect', '${PLATFORM}', 'maya', 'FA-G')`), /Only the FurnishAR server/);
  attempt(ids.buyer, ids.order, 'full', 2200, { ref: 'FA-A-F1' });
  const found = JSON.parse(as(null, `select public.server_payment_attempt_by_reference('${SECRET}', 'maya', 'FA-A-F1')::text`));
  assert.equal(found.order_id, ids.order);
  assert.equal(found.provider, 'maya');
  assert.equal(found.fee_mode, 'platform_collect');
  assert.equal(found.payee_merchant_id, PLATFORM);
  assert.equal(as(null, `select public.server_payment_attempt_by_reference('${SECRET}', 'paypal', 'FA-A-F1')::text`), '');
  assert.match(refused(null, `select public.server_payment_attempt_by_reference('guess', 'maya', 'FA-A-F1')`), /Only the FurnishAR server/);
});

function attemptSql(payee, feeMode, ref) {
  return `select public.server_record_payment_attempt('${SECRET}', '${ids.order}', 'full', 'sandbox',
    'CHK-${ref || 'none'}', 2200, 200, '${feeMode}', '${payee}', 'maya', ${ref ? `'${ref}'` : 'null'})`;
}

it('a PayPal capture cannot satisfy a Maya attempt, nor a Maya payment with no attempt', () => {
  assert.match(refused(null, `select public.record_capture('${SECRET}', '${ids.order}', 'full', 'CHK-FA-A-F1', 'PAY-PP', 2200,
    'PHP', null, null, '${PLATFORM}', 'accrual', null, 'sandbox', 'paypal')`), /wrong account/);
  assert.match(refused(null, `select public.record_capture('${SECRET}', '${ids.order}', 'full', 'CHK-NOPE', 'PAY-N', 2200,
    'PHP', null, null, '${PLATFORM}', 'accrual', null, 'sandbox', 'maya')`), /Unknown Maya payment/);
  assert.throws(() => record(null, ids.order, 'full', 2200, { ref: 'FA-A-F1', payment: 'PAY-X', payee: 'SHOPMERCHANT' }));
  assert.throws(() => record(null, ids.order, 'full', 2200, { ref: 'FA-A-F1', payment: 'PAY-USD', currency: 'USD' }));
  assert.equal(psql(`select status from public.orders where id = '${ids.order}'`), 'pending_payment');
});

it('a Maya payment for the wrong amount is recorded but never applied', () => {
  const short = JSON.parse(record(null, ids.order, 'full', 100, { ref: 'FA-A-F1', payment: 'PAY-SHORT' }));
  assert.equal(short.applied, false);
  assert.equal(psql(`select status from public.orders where id = '${ids.order}'`), 'pending_payment');
  assert.equal(psql(`select platform_fee_collected is null from public.payments where capture_id = 'PAY-SHORT'`), 't');
});

it('a verified Maya payment pays the order once; FurnishAR holds the fee and owes the shop its share', () => {
  const paid = JSON.parse(record(null, ids.order, 'full', 2200, { ref: 'FA-A-F1', payment: 'PAY-OK' }));
  assert.equal(paid.applied, true);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.fee_mode, 'platform_collect');
  assert.equal(paid.provider, 'maya');
  const row = JSON.parse(psql(`select row_to_json(p) from public.payments p where capture_id = 'PAY-OK'`));
  assert.equal(row.provider, 'maya');
  assert.equal(Number(row.platform_fee_collected), 200);
  assert.equal(row.payee_merchant_id, PLATFORM);

  // Maya retries the webhook and the buyer refreshes: nothing is paid twice.
  const again = JSON.parse(record(null, ids.order, 'full', 2200, { ref: 'FA-A-F1', payment: 'PAY-OK' }));
  assert.equal(again.duplicate, true);
  assert.equal(psql(`select amount_paid from public.orders where id = '${ids.order}'`), '2200.00');
  // The same payment id replayed as PayPal is refused, not treated as a duplicate.
  assert.match(refused(null, `select public.record_capture('${SECRET}', '${ids.order}', 'full', 'CHK-FA-A-F1', 'PAY-OK', 2200,
    'PHP', null, null, '${PLATFORM}', 'accrual', null, 'sandbox', 'paypal')`), /another payment method/);

  const summary = JSON.parse(as(ids.ownerA, `select public.store_fee_summary('${ids.storeA}')::text`));
  assert.equal(Number(summary.accrued), 0);          // the shop owes FurnishAR nothing…
  assert.equal(Number(summary.collected), 200);      // …FurnishAR already holds its 10%…
  assert.equal(Number(summary.owed_to_store), 2000); // …and owes the shop the rest
  assert.equal(Number(summary.expected_via_settlement), 0);

  const contacts = JSON.parse(psql(`select public.order_contacts_for('${ids.order}')::text`));
  assert.ok(contacts.payments.every(p => p.provider === 'maya'));
});

it('only an admin records a payout to a shop, and it reduces what is owed', () => {
  assert.match(refused(ids.ownerA, `select public.record_store_remittance('${ids.storeA}', 1500, 'BDO 123', null)`),
    /platform administrator/);
  assert.match(refused(ids.ownerA, `insert into public.store_remittances (store_id, amount) values ('${ids.storeA}', 5000)`),
    /permission denied/);
  assert.match(refused(ids.admin, `select public.record_store_remittance('${ids.storeA}', 0, null, null)`), /between/);
  as(ids.admin, `select public.record_store_remittance('${ids.storeA}', 1500, 'BDO 123', 'September')`);
  const summary = JSON.parse(as(ids.ownerA, `select public.store_fee_summary('${ids.storeA}')::text`));
  assert.equal(Number(summary.owed_to_store), 500);
  assert.equal(Number(summary.remitted), 1500);
  assert.equal(as(ids.ownerA, `select count(*) from public.store_remittances`), '1');
  assert.equal(as(ids.ownerB, `select count(*) from public.store_remittances`), '0');
  assert.equal(as(ids.admin, `select count(*) from public.admin_audit where action = 'store.remittance_recorded'`), '1');

  const overview = JSON.parse(as(ids.admin, `select json_agg(f)::text from public.fee_overview() f where store_id = '${ids.storeA}'`))[0];
  assert.equal(Number(overview.maya_sales), 2200);
  assert.equal(Number(overview.paypal_sales), 0);
  assert.equal(Number(overview.owed_to_store), 500);
  assert.equal(overview.maya_status, 'CONNECTED');
  assert.equal(overview.maya_settlement, 'platform_collect');
});

it('PayFac with provider settlement: deposit and balance, nothing claimed as collected', () => {
  as(ids.admin, `select public.admin_set_maya_account('${ids.storeB}', 'sandbox', true, 'payfac', 'SM-B-001', 'Mamburao', '5106')`);
  assert.equal(psql(`select public.store_accepts_payments('${ids.storeB}', 'sandbox')`), 't');
  const order = JSON.parse(as(ids.buyer, `select public.create_custom_request('${ids.storeB}', null,
    '{"width_cm":"180","notes":"Narra table"}', 'pickup', null, null, '0917 123 4567', null)::text`)).order_id;
  as(ids.ownerB, `select public.quote_custom_order('${order}', 5000, 14, null)`);
  const due = JSON.parse(as(ids.buyer, `select public.begin_payment('${order}', 'sandbox', 'maya')::text`));
  assert.equal(due.stage, 'deposit');
  assert.equal(due.settlement_mode, 'payfac');
  assert.equal(due.provider_account_ref, 'SM-B-001');
  assert.deepEqual(due.provider_profile, { city: 'Mamburao', postal: '5106', country: 'PHL' });

  // PayFac pays the sub-merchant, never FurnishAR's own account, and never "platform_collect".
  assert.match(refused(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order}', 'deposit', 'sandbox',
    'CHK-B-D0', 2750, 250, 'platform_collect', '${PLATFORM}', 'maya', 'FA-B-D0')`), /wrong account/);
  attempt(ids.buyer, order, 'deposit', 2750, { ref: 'FA-B-D1', payee: 'SM-B-001', feeMode: 'provider_settlement' });
  const deposit = JSON.parse(record(null, order, 'deposit', 2750, { ref: 'FA-B-D1', payment: 'PAY-B-D', payee: 'SM-B-001' }));
  assert.equal(deposit.status, 'deposit_paid');
  assert.equal(deposit.fee_mode, 'provider_settlement');

  as(ids.ownerB, `select public.mark_order_ready('${order}')`);
  attempt(ids.buyer, order, 'balance', 2750, { ref: 'FA-B-B1', payee: 'SM-B-001', feeMode: 'provider_settlement' });
  assert.equal(JSON.parse(record(null, order, 'balance', 2750, { ref: 'FA-B-B1', payment: 'PAY-B-B', payee: 'SM-B-001' })).status, 'paid');

  const summary = JSON.parse(as(ids.ownerB, `select public.store_fee_summary('${ids.storeB}')::text`));
  assert.equal(Number(summary.collected), 0);
  assert.equal(Number(summary.accrued), 0);
  assert.equal(Number(summary.expected_via_settlement), 500);   // 10% of the 5,000 quote, not yet reconciled
  assert.equal(Number(summary.owed_to_store), 0);                // Maya paid the shop directly
});

it('turning Maya off closes checkout for a Maya-only store', () => {
  as(ids.admin, `select public.admin_set_maya_account('${ids.storeA}', 'sandbox', false, null)`);
  assert.equal(psql(`select public.store_accepts_payments('${ids.storeA}')`), 'f');
  assert.match(refused(ids.buyer, `select public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)`),
    /finishing its PayPal setup/);
  assert.equal(as(ids.admin, `select count(*) from public.admin_audit where action = 'maya.disabled'`), '1');
});
