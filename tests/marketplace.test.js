/**
 * supabase/migrations/0011 — Google onboarding, PayPal seller connection,
 * fee allocation and modes, refunds, webhook idempotency and reminders.
 *
 * Same harness as tests/billing.test.js: every migration against a
 * throwaway local Postgres, then connecting the way PostgREST does and
 * trying to break the rules. Skipped when no local Postgres is reachable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONN = process.env.FURNISHAR_TEST_PG || 'postgresql://postgres@localhost:55432/postgres?host=/tmp';
const DB = 'furnishar_marketplace_test';
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
  // A Google account: confirmed email, a name from Google, no FurnishAR role.
  const google = (email, name) => psql(`insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
    values ('${email}', now(), '{"full_name":"${name}","iss":"https://accounts.google.com"}') returning id`);
  ids.gBuyer = google('maria.santos@gmail.com', 'Maria Santos');
  ids.gSeller = google('juan.shop@gmail.com', 'Juan Dela Cruz');
  ids.gAdmin = google('operator@gmail.com', 'Operator');
  ids.unconfirmed = psql(`insert into auth.users (email) values ('late@gmail.com') returning id`);
  psql(`insert into public.platform_admins (user_id, email) values ('${ids.gAdmin}', 'operator@gmail.com')`);
  ids.buyer = psql(`insert into auth.users (email, raw_user_meta_data) values ('ana@buyer.ph',
    '{"role":"buyer","full_name":"Ana Cruz","municipality":"Mamburao"}') returning id`);
  ids.storeA = psql(`select id from public.stores where slug = 'sc-variety'`);
  ids.storeB = psql(`select id from public.stores where slug = 'tiampion'`);
  ids.ownerA = psql(`insert into auth.users (email, email_confirmed_at) values ('owner-a@shop.ph', now()) returning id`);
  ids.ownerB = psql(`insert into auth.users (email, email_confirmed_at) values ('owner-b@shop.ph', now()) returning id`);
  psql(`insert into public.store_members (store_id, user_id) values
        ('${ids.storeA}', '${ids.ownerA}'), ('${ids.storeB}', '${ids.ownerB}')`);
  psql(`insert into billing_private.secrets (name, sha256_hex)
        values ('payment_recorder', encode(sha256(convert_to('${SECRET}', 'UTF8')), 'hex'))`);
  ids.product = psql(`update public.products set price_php = 10000, stock = 10, status = 'published'
                      where id = (select id from public.products where store_id = '${ids.storeA}' limit 1)
                      returning id`);
  as(ids.ownerB, `select public.save_store_billing('${ids.storeB}', 'custom', null, null, 3, 1)`);
});

test.after(() => {
  if (available) psql(`drop database if exists ${DB}`, 'postgres');
});

const connect = (store, merchant, extra = {}) => json(null, `public.server_record_payment_account('${SECRET}',
  '${extra.env || 'sandbox'}', '${store}', null, '${merchant}', '${extra.status || 'CONNECTED'}',
  ${extra.receivable ?? true}, ${extra.email ?? true}, ${extra.partnerFee ?? false}, null)`);

function pay(userId, order, stage, amount, { merchant, mode = 'accrual', collected = 'null', captureId }) {
  const fee = psql(`select public.stage_platform_fee('${order}', '${stage}')`);
  const providerOrder = `PP${captureId}`;
  as(userId, `select public.server_record_payment_attempt('${SECRET}', '${order}', '${stage}', 'sandbox',
    '${providerOrder}', ${amount}, ${fee}, '${mode}', '${merchant}')`);
  return json(userId, `public.record_capture('${SECRET}', '${order}', '${stage}', '${providerOrder}', '${captureId}',
    ${amount}, 'PHP', null, 'payer@example.ph', '${merchant}', '${mode}', ${collected}, 'sandbox')`);
}

/* ----------------------------------------------------------- onboarding */

it('a first Google sign-in has no role until it chooses one', () => {
  assert.equal(as(ids.gBuyer, 'select public.my_role()'), 'onboarding');
  const state = json(ids.gBuyer, 'public.my_account_state()');
  assert.equal(state.role, 'onboarding');
  assert.equal(state.name, 'Maria Santos');
  assert.equal(state.email, 'maria.santos@gmail.com');
  assert.equal(state.buyer, null);
  assert.equal(as(null, 'select public.my_role()'), 'guest');
});

it('buyer onboarding asks only for the municipality, once', () => {
  assert.match(refused(null, `select public.complete_buyer_onboarding(null, 'Mamburao')`), /permission denied/);
  assert.match(refused(ids.gBuyer, `select public.complete_buyer_onboarding(null, 'Manila')`), /Occidental Mindoro/);
  const done = json(ids.gBuyer, `public.complete_buyer_onboarding(null, 'Sablayan')`);
  assert.equal(done.created, true);
  assert.equal(done.full_name, 'Maria Santos');      // from Google, not asked again
  assert.equal(as(ids.gBuyer, 'select public.my_role()'), 'buyer');
  assert.equal(json(ids.gBuyer, `public.complete_buyer_onboarding(null, 'Mamburao')`).created, false);
  assert.equal(psql(`select municipality from public.buyers where user_id = '${ids.gBuyer}'`), 'Sablayan');
  // A buyer cannot then apply to sell with the same account.
  assert.match(refused(ids.gBuyer, `select public.submit_store_application('Shop', '0917 123 4567', null)`),
    /already set up as a shopper/);
});

it('Google sign-in never grants admin; an admin cannot onboard into another role', () => {
  assert.equal(as(ids.gAdmin, 'select public.my_role()'), 'admin');
  assert.match(refused(ids.gAdmin, `select public.complete_buyer_onboarding(null, 'Mamburao')`), /platform account/);
  assert.match(refused(ids.gAdmin, `select public.submit_store_application('X', '0917 123 4567', null)`), /platform account/);
  // Nothing an onboarding account can call writes platform_admins.
  assert.match(refused(ids.gSeller, `insert into public.platform_admins (user_id, email) values ('${ids.gSeller}', 'x')`),
    /permission denied/);
  assert.equal(psql('select count(*) from public.platform_admins'), '1');
});

it('a store application is linked to the account that filed it, then approved by id', () => {
  assert.match(refused(ids.unconfirmed, `select public.submit_store_application('Late Shop', '0917 123 4567', null)`),
    /Confirm your email/);
  assert.match(refused(ids.gSeller, `select public.submit_store_application('Juan Furniture', 'call me', null)`),
    /contact number/);
  const filed = json(ids.gSeller, `public.submit_store_application('Juan Furniture', '0917 555 0101', 'Narra tables')`);
  assert.equal(filed.contact_email, 'juan.shop@gmail.com');
  assert.equal(as(ids.gSeller, 'select public.my_role()'), 'pending');
  assert.match(refused(ids.gSeller, `select public.submit_store_application('Again', '0917 555 0101', null)`),
    /already waiting/);
  assert.equal(psql(`select applicant_user_id from public.store_applications where id = '${filed.application_id}'`), ids.gSeller);

  assert.match(refused(ids.gSeller, `select public.approve_store_application('${filed.application_id}', null)`),
    /platform administrator/);
  // The Google email changes before approval: the id still links the right account.
  psql(`update auth.users set email = 'juan.renamed@gmail.com' where id = '${ids.gSeller}'`);
  const approved = json(ids.gAdmin, `public.approve_store_application('${filed.application_id}', 'juan-furniture')`);
  assert.equal(approved.user_id, ids.gSeller);
  assert.equal(approved.contact_email, 'juan.shop@gmail.com');
  assert.equal(as(ids.gSeller, 'select public.my_role()'), 'owner');
  ids.storeJ = approved.store_id;
});

/* ------------------------------------------------ seller connection ---- */

it('only the server records a PayPal connection, and a merchant pays one store', () => {
  assert.match(refused(null, `select public.server_record_payment_account('guess', 'sandbox', '${ids.storeA}',
    null, 'MERCHANTA1', 'CONNECTED', true, true, false, null)`), /Only the FurnishAR server/);
  assert.match(refused(ids.ownerA, `insert into public.store_payment_accounts (store_id, environment, onboarding_status)
    values ('${ids.storeA}', 'sandbox', 'CONNECTED')`), /permission denied/);

  // Onboarding started, as the store's member only.
  assert.match(refused(ids.ownerB, `select public.server_payment_onboarding_started('${SECRET}', '${ids.storeA}', 'sandbox', 'track-a')`),
    /Only this store's owner/);
  as(ids.ownerA, `select public.server_payment_onboarding_started('${SECRET}', '${ids.storeA}', 'sandbox', 'track-a')`);
  assert.equal(as(ids.ownerA, `select onboarding_status from public.store_payment_accounts where store_id = '${ids.storeA}'`),
    'ONBOARDING_STARTED');
  assert.equal(as(ids.ownerB, `select count(*) from public.store_payment_accounts where store_id = '${ids.storeA}'`), '0');

  // Email not confirmed yet: pending, not ready.
  connect(ids.storeA, 'MERCHANTA1', { status: 'PENDING', email: false });
  assert.equal(as(null, `select public.store_accepts_payments('${ids.storeA}')`), 'f');
  const connected = connect(ids.storeA, 'MERCHANTA1', { partnerFee: true });
  assert.equal(connected.before, 'PENDING');
  assert.equal(connected.status, 'CONNECTED');
  assert.equal(as(null, `select public.store_accepts_payments('${ids.storeA}')`), 't');
  assert.equal(as(null, `select public.store_accepts_payments('${ids.storeA}', 'live')`), 'f');
  assert.equal(as(null, `select bool_and(store_payments_ready) from public.catalog where store_id = '${ids.storeA}'`), 't');

  // The same PayPal account for a second store is refused, not shared.
  const clash = connect(ids.storeB, 'MERCHANTA1');
  assert.equal(clash.conflict, true);
  assert.equal(as(null, `select public.store_accepts_payments('${ids.storeB}')`), 'f');
  connect(ids.storeB, 'MERCHANTB1');
  assert.equal(as(null, `select public.store_accepts_payments('${ids.storeB}')`), 't');

  // Found again later by tracking id (the webhook path).
  const byTracking = json(null, `public.server_record_payment_account('${SECRET}', 'sandbox', null, 'track-a',
    'MERCHANTA1', 'CONNECTED', true, true, true, null)`);
  assert.equal(byTracking.store_id, ids.storeA);
});

/* ------------------------------------------------------------ the fee -- */

it('₱10,000 + 10% = ₱11,000; the fee is FurnishAR\'s and is owed in accrual mode', () => {
  const order = json(ids.buyer, `public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)`).order_id;
  const row = JSON.parse(psql(`select row_to_json(o) from public.orders o where id = '${order}'`));
  assert.equal(Number(row.subtotal), 10000);
  assert.equal(Number(row.platform_fee), 1000);
  assert.equal(Number(row.total), 11000);
  const due = json(ids.buyer, `public.begin_payment('${order}', 'sandbox')`);
  assert.equal(Number(due.amount), 11000);
  assert.equal(Number(due.platform_fee), 1000);
  assert.equal(due.merchant_id, 'MERCHANTA1');
  assert.equal(due.partner_fee_granted, true);

  // The attempt must carry the database's fee, to the connected merchant.
  assert.match(refused(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order}', 'full', 'sandbox',
    'PPBADFEE', 11000, 1, 'accrual', 'MERCHANTA1')`), /Unexpected fee/);
  assert.match(refused(ids.buyer, `select public.server_record_payment_attempt('${SECRET}', '${order}', 'full', 'sandbox',
    'PPBADPAYEE', 11000, 1000, 'accrual', 'MERCHANTB1')`), /wrong account/);

  const paid = pay(ids.buyer, order, 'full', 11000, { merchant: 'MERCHANTA1', captureId: 'CAPACCRUAL1' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.fee_mode, 'accrual');
  assert.equal(Number(paid.platform_fee), 1000);
  const summary = json(ids.ownerA, `public.store_fee_summary('${ids.storeA}')`);
  assert.equal(Number(summary.accrued), 1000);
  assert.equal(Number(summary.collected), 0);
  assert.equal(as(ids.buyer, `select status from public.payment_attempts where provider_order_id = 'PPCAPACCRUAL1'`), 'CAPTURED');
  ids.accrualOrder = order;
});

it('"collected" only when PayPal reported exactly the fee; otherwise it accrues', () => {
  const split = json(ids.buyer, `public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)`).order_id;
  const collected = pay(ids.buyer, split, 'full', 11000,
    { merchant: 'MERCHANTA1', mode: 'platform_split', collected: 1000, captureId: 'CAPSPLIT1' });
  assert.equal(collected.fee_mode, 'platform_split');

  const missing = json(ids.buyer, `public.create_stock_order('${ids.product}', 1, 'pickup', null, null, '0917 123 4567', null)`).order_id;
  const unreported = pay(ids.buyer, missing, 'full', 11000,
    { merchant: 'MERCHANTA1', mode: 'platform_split', collected: 'null', captureId: 'CAPSPLIT2' });
  assert.equal(unreported.fee_mode, 'accrual');      // asked for a split, PayPal did not say it took one

  const summary = json(ids.ownerA, `public.store_fee_summary('${ids.storeA}')`);
  assert.equal(Number(summary.collected), 1000);
  assert.equal(Number(summary.accrued), 2000);
});

it('a custom build\'s fee is computed once and its stages add up to it exactly', () => {
  const order = json(ids.buyer, `public.create_custom_request('${ids.storeB}', null, '{"notes":"Bench"}',
    'pickup', null, null, '0917 123 4567', null)`).order_id;
  as(ids.ownerB, `select public.quote_custom_order('${order}', 333.33, 7, null)`);
  const quoted = JSON.parse(psql(`select row_to_json(o) from public.orders o where id = '${order}'`));
  assert.equal(Number(quoted.platform_fee), 33.33);
  assert.equal(Number(quoted.deposit_fee), 16.67);
  assert.equal(Number(quoted.deposit_amount), 183.34);    // 166.67 + 16.67
  assert.equal(Number(quoted.total), 366.66);

  pay(ids.buyer, order, 'deposit', 183.34, { merchant: 'MERCHANTB1', captureId: 'CAPDEP1' });
  as(ids.ownerB, `select public.mark_order_ready('${order}')`);
  const balance = json(ids.buyer, `public.begin_payment('${order}', 'sandbox')`);
  assert.equal(Number(balance.amount), 183.32);
  assert.equal(Number(balance.platform_fee), 16.66);      // the final stage corrects the rounding
  pay(ids.buyer, order, 'balance', 183.32, { merchant: 'MERCHANTB1', captureId: 'CAPBAL1' });
  assert.equal(psql(`select sum(platform_fee) from public.payments where order_id = '${order}'`), '33.33');
  assert.equal(psql(`select status from public.orders where id = '${order}'`), 'paid');
});

/* ------------------------------------------------------------ refunds -- */

it('refunds are recorded once, split into the seller and platform portions', () => {
  assert.match(refused(null, `select public.server_record_refund('guess', 'CAPACCRUAL1', 'R1', 1100, 'PHP', null, 'COMPLETED', 'refund')`),
    /Only the FurnishAR server/);
  const part = json(null, `public.server_record_refund('${SECRET}', 'CAPACCRUAL1', 'REF1', 1100, 'PHP', null, 'COMPLETED', 'refund')`);
  assert.equal(Number(part.platform_fee_refunded), 100);   // 1,100 of 11,000 → 10% of the fee
  assert.equal(part.payment_status, 'PARTIALLY_REFUNDED');
  assert.equal(json(null, `public.server_record_refund('${SECRET}', 'CAPACCRUAL1', 'REF1', 1100, 'PHP', null, 'COMPLETED', 'refund')`).duplicate, true);
  const rest = json(null, `public.server_record_refund('${SECRET}', 'CAPACCRUAL1', 'REF2', 9900, 'PHP', null, 'COMPLETED', 'refund')`);
  assert.equal(Number(rest.platform_fee_refunded), 900);
  assert.equal(rest.payment_status, 'REFUNDED');
  const order = JSON.parse(psql(`select row_to_json(o) from public.orders o where id = '${ids.accrualOrder}'`));
  assert.equal(order.refund_status, 'full');
  assert.equal(Number(order.refunded_amount), 11000);
  assert.equal(psql(`select sum(seller_amount) from public.payment_refunds where capture_id = 'CAPACCRUAL1'`), '10000.00');   // 11,000 refunded − 1,000 fee
  // The refunded fee is no longer owed.
  assert.equal(Number(json(ids.ownerA, `public.store_fee_summary('${ids.storeA}')`).accrued), 1000);
  // The buyer and the shop see it; another shop does not.
  assert.equal(as(ids.buyer, `select count(*) from public.payment_refunds`), '2');
  assert.equal(as(ids.ownerB, `select count(*) from public.payment_refunds`), '0');
});

/* ------------------------------------------------------------ webhooks - */

it('a webhook event is processed once', () => {
  const claim = () => as(null, `select public.server_claim_webhook_event('${SECRET}', 'WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'CAP', 'sandbox')`);
  assert.equal(claim(), 't');
  assert.equal(claim(), 'f');
  as(null, `select public.server_finish_webhook_event('${SECRET}', 'WH-1', 'recorded')`);
  assert.equal(claim(), 'f');
  // A claim abandoned half way can be retried after ten minutes.
  as(null, `select public.server_claim_webhook_event('${SECRET}', 'WH-2', 'X', null, 'sandbox')`);
  psql(`update public.payment_webhook_events set received_at = now() - interval '11 minutes' where event_id = 'WH-2'`);
  assert.equal(as(null, `select public.server_claim_webhook_event('${SECRET}', 'WH-2', 'X', null, 'sandbox')`), 't');
  assert.equal(as(ids.ownerA, `select count(*) from public.payment_webhook_events`), '0');
  assert.equal(as(ids.gAdmin, `select count(*) from public.payment_webhook_events`), '2');
});

/* ---------------------------------------------------------- reminders -- */

it('payment-setup reminders respect the cooldown and the cap', () => {
  const due = () => as(null, `select coalesce(string_agg(store_id::text, ','), '')
    from public.server_stores_needing_payment_setup('${SECRET}', 'sandbox', 72, 3)`);
  assert.ok(due().includes(ids.storeJ));        // approved, never connected
  assert.ok(!due().includes(ids.storeA));       // connected
  as(null, `select public.server_mark_payment_reminder('${SECRET}', '${ids.storeJ}', 'sandbox')`);
  assert.ok(!due().includes(ids.storeJ));       // inside the cooldown
  psql(`update public.store_payment_accounts set last_paypal_reminder_at = now() - interval '73 hours'
        where store_id = '${ids.storeJ}'`);
  assert.ok(due().includes(ids.storeJ));
  psql(`update public.store_payment_accounts set paypal_reminder_count = 3 where store_id = '${ids.storeJ}'`);
  assert.ok(!due().includes(ids.storeJ));       // capped
  assert.match(refused(null, `select * from public.server_stores_needing_payment_setup('guess', 'sandbox', 72, 3)`),
    /Only the FurnishAR server/);
});

it('fee overview masks the merchant id and names the mode per store', () => {
  const rows = JSON.parse(as(ids.gAdmin, `select jsonb_agg(f)::text from public.fee_overview() f`));
  const a = rows.find(r => r.store_id === ids.storeA);
  assert.equal(a.payment_status, 'CONNECTED');
  assert.match(a.merchant_id_masked, /^•+NTA1$/);
  assert.equal(Number(a.collected), 1000);
  assert.match(refused(ids.ownerA, 'select * from public.fee_overview()'), /platform administrator/);
});
