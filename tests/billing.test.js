/**
 * Orders, payments and the platform fee — supabase/migrations/0009.
 *
 * Runs every migration in order against a throwaway local Postgres, then
 * connects the way PostgREST does (a role plus JWT claims) and tries to break
 * the money rules: paying without the server's secret, paying the wrong
 * account, reading someone else's order, writing an order directly, and
 * walking both the stocked and the custom-build lifecycles end to end.
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
const DB = 'furnishar_billing_test';
const SECRET = 'test-payment-recorder-secret';

const dbUrl = db => CONN.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);

function psql(sql, db = DB) {
  return execFileSync('psql', [dbUrl(db), '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/** Runs sql as a signed-in user (or anon when userId is null), returns the last value. */
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

  // One priced, stocked piece in store A.
  ids.product = psql(`update public.products set price_php = 1000, stock = 5, status = 'published'
                      where id = (select id from public.products where store_id = '${ids.storeA}' limit 1)
                      returning id`);
  // Store B builds to order.
  as(ids.ownerB, `select public.save_store_billing('${ids.storeB}', 'custom', 'pay-b@shop.ph', 'orders-b@shop.ph')`);
});

test.after(() => {
  if (available) psql(`drop database if exists ${DB}`, 'postgres');
});

const capture = (userId, order, stage, amount, { secret = SECRET, payee = 'pay-a@shop.ph', captureId } = {}) =>
  as(userId, `select public.record_capture('${secret}', '${order}', '${stage}', 'PP-${stage}',
    '${captureId || `CAP-${order}-${stage}`}', ${amount}, 'PHP', '${payee}', 'payer@example.ph')::text`);

it('a shop without a PayPal account cannot take an order', () => {
  const error = refused(ids.buyer, `select public.create_stock_order('${ids.product}', 1)`);
  assert.match(error, /not taking online payments/);
});

it('only the store owner sets where the store is paid', () => {
  assert.match(refused(ids.ownerB, `select public.save_store_billing('${ids.storeA}', 'stocked', 'evil@x.ph', null)`),
    /Only this store's owner/);
  as(ids.ownerA, `select public.save_store_billing('${ids.storeA}', 'stocked', 'Pay-A@Shop.ph', null)`);
  assert.equal(psql(`select paypal_email from public.store_payout where store_id = '${ids.storeA}'`), 'pay-a@shop.ph');
  assert.equal(as(ids.otherBuyer, `select count(*) from public.store_payout`), '0');
});

it('an owner can no longer upgrade their own plan or unsuspend their store', () => {
  assert.match(refused(ids.ownerA, `update public.stores set plan = 'premium' where id = '${ids.storeA}'`),
    /permission denied/);
  assert.match(refused(ids.ownerA, `update public.stores set status = 'active' where id = '${ids.storeA}'`),
    /permission denied/);
  as(ids.ownerA, `update public.stores set hours = '9-5' where id = '${ids.storeA}'`);
});

it('guests and store accounts cannot order; the price is the database\'s', () => {
  assert.match(refused(null, `select public.create_stock_order('${ids.product}', 1)`), /permission denied/);
  assert.match(refused(ids.ownerA, `select public.create_stock_order('${ids.product}', 1)`), /Only a shopper/);
  assert.match(refused(ids.buyer, `select public.create_stock_order('${ids.product}', 99)`), /quantity from 1 to 20/);
  assert.match(refused(ids.buyer, `select public.create_stock_order('${ids.product}', 6)`), /Only 5 left/);

  ids.stockOrder = JSON.parse(as(ids.buyer, `select public.create_stock_order('${ids.product}', 2)::text`)).order_id;
  const row = JSON.parse(psql(`select row_to_json(o) from public.orders o where id = '${ids.stockOrder}'`));
  assert.equal(Number(row.subtotal), 2000);
  assert.equal(Number(row.platform_fee), 200);      // 10% on top
  assert.equal(Number(row.total), 2200);
  assert.equal(row.buyer_email, 'ana@buyer.ph');
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '3');
});

it('orders cannot be written or read by anyone but their parties', () => {
  assert.match(refused(ids.buyer, `update public.orders set total = 1 where id = '${ids.stockOrder}'`), /permission denied/);
  assert.match(refused(ids.buyer, `insert into public.orders (kind, status, buyer_id, buyer_name, buyer_email, store_id, product_name, fee_rate)
    values ('stock', 'paid', '${ids.buyer}', 'x', 'x', '${ids.storeA}', 'x', 0)`), /permission denied/);
  assert.equal(as(ids.otherBuyer, `select count(*) from public.orders`), '0');
  assert.equal(as(ids.ownerB, `select count(*) from public.orders`), '0');
  assert.equal(as(ids.ownerA, `select count(*) from public.orders`), '1');
  assert.equal(as(ids.admin, `select count(*) from public.orders`), '1');
  assert.match(refused(ids.otherBuyer, `select public.begin_payment('${ids.stockOrder}')`), /not yours/);
});

it('what is due comes from the database, to the shop\'s own account', () => {
  const due = JSON.parse(as(ids.buyer, `select public.begin_payment('${ids.stockOrder}')::text`));
  assert.equal(due.stage, 'full');
  assert.equal(Number(due.amount), 2200);
  assert.equal(due.payee_email, 'pay-a@shop.ph');
});

it('a payment without the server secret, to the wrong payee, or short is not applied', () => {
  assert.match(refused(ids.buyer, `select public.record_capture('guess', '${ids.stockOrder}', 'full', 'PP', 'CAP-X', 2200, 'PHP', 'pay-a@shop.ph', null)`),
    /recorded by the server only/);
  assert.match(refused(ids.buyer, `select public.record_capture(null, '${ids.stockOrder}', 'full', 'PP', 'CAP-X', 2200, 'PHP', 'pay-a@shop.ph', null)`),
    /recorded by the server only/);
  assert.match(refused(ids.buyer, `select * from billing_private.secrets`), /permission denied/);
  assert.match(refused(ids.buyer, `select public.record_capture('${SECRET}', '${ids.stockOrder}', 'full', 'PP', 'CAP-X', 2200, 'PHP', 'thief@x.ph', null)`),
    /wrong account/);
  assert.match(refused(ids.otherBuyer, `select public.record_capture('${SECRET}', '${ids.stockOrder}', 'full', 'PP', 'CAP-X', 2200, 'PHP', 'pay-a@shop.ph', null)`),
    /not yours/);
  const short = JSON.parse(capture(ids.buyer, ids.stockOrder, 'full', 100, { captureId: 'CAP-SHORT' }));
  assert.equal(short.applied, false);
  assert.equal(psql(`select status from public.orders where id = '${ids.stockOrder}'`), 'pending_payment');
});

it('a verified capture pays the order, once, and accrues the 10%', () => {
  const paid = JSON.parse(capture(ids.buyer, ids.stockOrder, 'full', 2200));
  assert.equal(paid.applied, true);
  assert.equal(paid.status, 'paid');
  const again = JSON.parse(capture(ids.buyer, ids.stockOrder, 'full', 2200));
  assert.equal(again.duplicate, true);
  assert.equal(psql(`select amount_paid from public.orders where id = '${ids.stockOrder}'`), '2200.00');
  const summary = JSON.parse(as(ids.ownerA, `select public.store_fee_summary('${ids.storeA}')::text`));
  assert.equal(Number(summary.accrued), 200);
  assert.match(refused(ids.ownerB, `select public.store_fee_summary('${ids.storeA}')`), /Not your store/);
  assert.match(refused(ids.buyer, `select public.cancel_order('${ids.stockOrder}')`), /paid order cannot be cancelled/);
  as(ids.ownerA, `select public.mark_order_fulfilled('${ids.stockOrder}')`);
  assert.equal(psql(`select status from public.orders where id = '${ids.stockOrder}'`), 'fulfilled');
});

it('an unpaid hold expires and the stock goes back on the shelf', () => {
  const order = JSON.parse(as(ids.otherBuyer, `select public.create_stock_order('${ids.product}', 3)::text`)).order_id;
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '0');
  psql(`update public.orders set hold_expires_at = now() - interval '1 minute' where id = '${order}'`);
  assert.equal(JSON.parse(as(ids.otherBuyer, `select public.begin_payment('${order}')::text`)).stage, null);
  assert.equal(psql(`select status from public.orders where id = '${order}'`), 'expired');
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '3');

  const cancelled = JSON.parse(as(ids.otherBuyer, `select public.create_stock_order('${ids.product}', 1)::text`)).order_id;
  as(ids.otherBuyer, `select public.cancel_order('${cancelled}')`);
  assert.equal(psql(`select stock from public.products where id = '${ids.product}'`), '3');
});

it('a custom build: request, quote, deposit, ready, balance, handed over', () => {
  assert.match(refused(ids.buyer, `select public.create_custom_request('${ids.storeA}', null, '{"notes":"x"}')`),
    /sells from stock/);
  assert.match(refused(ids.buyer, `select public.create_custom_request('${ids.storeB}', null, '{}')`),
    /Describe what you want/);
  const order = JSON.parse(as(ids.buyer, `select public.create_custom_request('${ids.storeB}', null,
    '{"width_cm":"180","notes":"Narra dining table","price":"1","evil":"x"}')::text`)).order_id;
  const request = JSON.parse(psql(`select request::text from public.orders where id = '${order}'`));
  assert.deepEqual(Object.keys(request).sort(), ['notes', 'width_cm']);
  assert.equal(JSON.parse(as(ids.buyer, `select public.begin_payment('${order}')::text`)).stage, null);

  assert.match(refused(ids.ownerA, `select public.quote_custom_order('${order}', 5000, 14, null)`), /not one of your store/);
  as(ids.ownerB, `select public.quote_custom_order('${order}', 5000, 14, 'Two weeks')`);
  const quoted = JSON.parse(psql(`select row_to_json(o) from public.orders o where id = '${order}'`));
  assert.equal(Number(quoted.total), 5500);
  assert.equal(Number(quoted.deposit_amount), 2750);

  const due = JSON.parse(as(ids.buyer, `select public.begin_payment('${order}')::text`));
  assert.equal(due.stage, 'deposit');
  assert.equal(Number(due.amount), 2750);
  const deposit = JSON.parse(capture(ids.buyer, order, 'deposit', 2750, { payee: 'pay-b@shop.ph' }));
  assert.equal(deposit.status, 'deposit_paid');
  assert.match(refused(ids.ownerB, `select public.decline_custom_order('${order}', 'no')`), /not been paid/);

  assert.match(refused(ids.buyer, `select public.mark_order_ready('${order}')`), /not one of your store/);
  as(ids.ownerB, `select public.mark_order_ready('${order}')`);
  const balance = JSON.parse(as(ids.buyer, `select public.begin_payment('${order}')::text`));
  assert.equal(balance.stage, 'balance');
  assert.equal(Number(balance.amount), 2750);
  assert.equal(JSON.parse(capture(ids.buyer, order, 'balance', 2750, { payee: 'pay-b@shop.ph' })).status, 'paid');

  const summary = JSON.parse(as(ids.ownerB, `select public.store_fee_summary('${ids.storeB}')::text`));
  assert.equal(Number(summary.accrued), 500);        // 10% of the 5,000 quote
  const contacts = JSON.parse(as(ids.ownerB, `select public.order_contacts('${order}')::text`));
  assert.deepEqual(contacts.store_emails, ['orders-b@shop.ph']);
  assert.match(refused(ids.otherBuyer, `select public.order_contacts('${order}')`), /not yours/);
});

it('only an admin sees every store\'s fees and records a settlement', () => {
  assert.match(refused(ids.ownerA, `select * from public.fee_overview()`), /platform administrator/);
  assert.match(refused(ids.ownerA, `select public.record_fee_settlement('${ids.storeA}', 200, 'GCash 123', null)`),
    /platform administrator/);
  as(ids.admin, `select public.record_fee_settlement('${ids.storeA}', 200, 'GCash 123', null)`);
  const summary = JSON.parse(as(ids.ownerA, `select public.store_fee_summary('${ids.storeA}')::text`));
  assert.equal(Number(summary.outstanding), 0);
  assert.equal(as(ids.admin, `select count(*) from public.admin_audit where action = 'fees.settled'`), '1');
});
