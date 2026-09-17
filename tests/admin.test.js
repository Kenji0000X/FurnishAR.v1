/**
 * The security layer for the two portals, tested against a real Postgres.
 *
 * These are the tests that matter for this feature. The portals are just
 * pages; what actually stops a store owner reading the sign-up queue, or a
 * stranger approving themselves, is row level security. A test that drove the
 * UI would prove only that the UI hides things.
 *
 * Every case below connects AS a role — anon, a store owner, a second store
 * owner, a superadmin — by setting the JWT claims Supabase would set, and then
 * tries to do something it should not be able to do.
 *
 * Skips itself when no Postgres is reachable, so `npm test` passes without one.
 *   npm run test:db     (or point FURNISHAR_TEST_PG at a server)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Same default as tests/db.test.js, so one FURNISHAR_TEST_PG points both suites
// at the same server. Skips itself when nothing is listening.
const CONN = process.env.FURNISHAR_TEST_PG
  || 'postgresql://postgres@localhost:55432/postgres?host=/tmp';

function psql(sql, { role = null, user = null } = {}) {
  // Supabase sets request.jwt.claims; auth.uid() and the policies read it.
  // A bare `select set_config(...)` would print a row and land in the output
  // being asserted on, so it goes inside a DO block that returns nothing.
  const claims = user
    ? `do $claims$ begin perform set_config('request.jwt.claims',
         '{"sub":"${user}","role":"${role || 'authenticated'}"}', true); end $claims$;`
    : '';
  const asRole = role ? `set local role ${role};` : '';
  const script = `begin; ${claims} ${asRole} ${sql} commit;`;
  const out = execFileSync('psql', [CONN, '-v', 'ON_ERROR_STOP=1', '-tAc', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // psql prints a command tag per statement (BEGIN, DO, SET, COMMIT …); the
  // value being asserted on is the last line that is not one of those.
  const tags = /^(BEGIN|COMMIT|DO|SET|INSERT|UPDATE|DELETE|SELECT)\b/;
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  const values = lines.filter(l => !tags.test(l));
  return values.length ? values[values.length - 1] : '';
}

/** Reads as a role that may be refused outright; denial counts as "no rows". */
function readOrDenied(sql, identity) {
  try {
    return psql(sql, identity);
  } catch (error) {
    if (/permission denied|row-level security/i.test(String(error.stderr || error.message))) {
      return 'denied';
    }
    throw error;
  }
}

let available = true;
try {
  execFileSync('psql', [CONN, '-tAc', 'select 1'], { stdio: 'ignore' });
  // The suite approves an application, which cannot be undone by rolling back
  // — so it resets its own fixtures rather than depending on a fresh database.
  execFileSync('psql', [CONN, '-q', '-v', 'ON_ERROR_STOP=1',
    '-f', path.join(ROOT, 'tests', 'admin-fixtures.sql')], { stdio: 'ignore' });
} catch {
  available = false;
}

const describe = available ? test : test.skip;

/* Identities created by scripts/setup-admin-test.sql:
   - OWNER_A  owns sc-variety
   - OWNER_B  owns tiampion
   - ADMIN    is in platform_admins
   - OUTSIDER is signed in but owns nothing          */
const IDS = available
  ? JSON.parse(execFileSync('psql', [CONN, '-tAc',
      `select json_build_object(
         'ownerA', (select id from auth.users where email = 'owner-a@test.ph'),
         'ownerB', (select id from auth.users where email = 'owner-b@test.ph'),
         'admin',  (select id from auth.users where email = 'admin@test.ph'),
         'outsider', (select id from auth.users where email = 'outsider@test.ph'),
         'pending', (select id from public.store_applications where contact_email = 'applicant@test.ph'),
         'unconfirmed', (select id from public.store_applications where contact_email = 'unconfirmed@test.ph')
       )`], { encoding: 'utf8' }).trim())
  : {};

/* ------------------------------------------------- the queue is not public -- */

describe('the sign-up queue is invisible to the public', () => {
  // anon has no SELECT grant at all, so it is refused before RLS is consulted.
  // That is stronger than "returns no rows", and either answer passes: what
  // matters is that no applicant's email or phone number comes back.
  const rows = readOrDenied('select count(*) from public.store_applications;', { role: 'anon' });
  assert.ok(rows === 'denied' || rows === '0', `anon read applications: ${rows}`);
});

describe('a store owner cannot read the sign-up queue', () => {
  // This is the one people get wrong: an owner is authenticated, so a naive
  // "logged in?" check would let them read every applicant's email and phone.
  const rows = readOrDenied('select count(*) from public.store_applications;',
    { role: 'authenticated', user: IDS.ownerA });
  assert.ok(rows === 'denied' || rows === '0', `an owner saw applications: ${rows}`);
});

describe('a superadmin can read the sign-up queue', () => {
  const rows = psql("select count(*) from public.store_applications where status = 'pending';",
    { role: 'authenticated', user: IDS.admin });
  assert.ok(Number(rows) >= 1, 'the admin should see the pending application');
});

/* ------------------------------------------------ the applicant is checked -- */

describe('an applicant who never confirmed their email cannot be approved', () => {
  // The point of the queue is vetting. An address nobody has proved they own
  // is not a business you can approve, however convincing the form was.
  assert.throws(
    () => psql(`select public.approve_store_application('${IDS.unconfirmed}', 'unconfirmed-shop');`,
      { role: 'authenticated', user: IDS.admin }),
    /has not confirmed their email/,
    'an unconfirmed applicant must be refused even for an admin'
  );
  const stores = psql("select count(*) from public.stores where slug = 'unconfirmed-shop';");
  assert.equal(stores, '0', 'the refused approval must not have created a store');
});

describe('an admin can see whether the applicant confirmed their address', () => {
  const account = JSON.parse(psql(`select public.applicant_account('${IDS.pending}');`,
    { role: 'authenticated', user: IDS.admin }));
  assert.equal(account.found, true);
  assert.equal(account.confirmed, true);
});

describe('applicant_account never becomes a way to read auth.users', () => {
  // It is security definer, so without its own check it would hand any signed-in
  // account the applicant's details.
  assert.throws(
    () => psql(`select public.applicant_account('${IDS.pending}');`,
      { role: 'authenticated', user: IDS.ownerA }),
    /Only a platform administrator/
  );
  assert.throws(
    () => psql(`select public.applicant_account('${IDS.pending}');`, { role: 'anon' }),
    /Only a platform administrator|permission denied/
  );
});

/* ------------------------------------------------------- deciding is gated -- */

describe('a store owner cannot approve an application', () => {
  assert.throws(
    () => psql(`select public.approve_store_application('${IDS.pending}');`,
      { role: 'authenticated', user: IDS.ownerA }),
    /Only a platform administrator/,
    'approval must be refused for a non-admin'
  );
});

describe('a signed-in stranger cannot approve an application', () => {
  assert.throws(
    () => psql(`select public.approve_store_application('${IDS.pending}');`,
      { role: 'authenticated', user: IDS.outsider }),
    /Only a platform administrator/
  );
});

describe('anon cannot approve an application', () => {
  assert.throws(
    () => psql(`select public.approve_store_application('${IDS.pending}');`, { role: 'anon' }),
    /Only a platform administrator|permission denied/
  );
});

describe('a store owner cannot promote themselves to superadmin', () => {
  assert.throws(
    () => psql(
      `insert into public.platform_admins (user_id, email) values ('${IDS.ownerA}', 'owner-a@test.ph');`,
      { role: 'authenticated', user: IDS.ownerA }),
    /permission denied|row-level security/,
    'there must be no path from store owner to superadmin through the API'
  );
});

describe('the admin roster is invisible to a store owner', () => {
  const rows = readOrDenied('select count(*) from public.platform_admins;',
    { role: 'authenticated', user: IDS.ownerA });
  assert.ok(rows === 'denied' || rows === '0', `an owner enumerated admins: ${rows}`);
});

/* --------------------------------------------- seeing what has been uploaded -- */
// 0004: the superadmin can see every store's products and models, including
// drafts a non-member would never be shown — so they can spot an oversized
// file or a listing with no model attached without going shop by shop with
// database credentials. It is still read-only: 0001's write policies, scoped
// to store membership, are untouched.

describe('an admin can see a draft product in a store they do not belong to', () => {
  const rows = psql(
    "select count(*) from public.products where slug = 'test-fixture-draft';",
    { role: 'authenticated', user: IDS.admin }
  );
  assert.equal(rows, '1', 'the admin should see the draft product across stores');
});

describe('an admin can see the model file attached to it', () => {
  const path = psql(
    `select object_path from public.product_assets pa
       join public.products p on p.id = pa.product_id
      where p.slug = 'test-fixture-draft';`,
    { role: 'authenticated', user: IDS.admin }
  );
  assert.match(path, /test-fixture-model\.glb$/);
});

describe('a store owner who is not a member still cannot see that draft or its model', () => {
  const products = readOrDenied(
    "select count(*) from public.products where slug = 'test-fixture-draft';",
    { role: 'authenticated', user: IDS.ownerB }
  );
  assert.ok(products === 'denied' || products === '0', `owner B saw the draft: ${products}`);

  const assets = readOrDenied(
    `select count(*) from public.product_assets pa
       join public.products p on p.id = pa.product_id
      where p.slug = 'test-fixture-draft';`,
    { role: 'authenticated', user: IDS.ownerB }
  );
  assert.ok(assets === 'denied' || assets === '0', `owner B saw the model asset: ${assets}`);
});

describe('a signed-in stranger cannot see it either', () => {
  const rows = readOrDenied(
    "select count(*) from public.products where slug = 'test-fixture-draft';",
    { role: 'authenticated', user: IDS.outsider }
  );
  assert.ok(rows === 'denied' || rows === '0', `outsider saw the draft: ${rows}`);
});

describe('anon cannot see it, and admin visibility grants no write access', () => {
  const rows = readOrDenied(
    "select count(*) from public.products where slug = 'test-fixture-draft';",
    { role: 'anon' }
  );
  assert.ok(rows === 'denied' || rows === '0', `anon saw the draft: ${rows}`);

  // Seeing everything is not the same as owning everything: 0004 only ever
  // adds a SELECT policy, so an admin who is not a store member still has no
  // UPDATE policy that applies to somebody else's product. RLS expresses that
  // as "matched zero rows", not an error — so the assertion is on the price
  // being unchanged, not on an exception being thrown.
  psql(
    `update public.products set price_php = 999999 where slug = 'test-fixture-draft';`,
    { role: 'authenticated', user: IDS.admin }
  );
  const price = psql(
    "select price_php from public.products where slug = 'test-fixture-draft';",
    { role: 'authenticated', user: IDS.admin }
  );
  assert.notEqual(price, '999999.00', 'an admin should not be able to write another store\'s product');
});

/* --------------------------------------------------------- storage totals -- */
// 0005: storage_usage() is what lets the operator watch the real cost of a
// bigger per-file cap without dashboard access — it has to add up bytes across
// every store (which nobody but an admin may otherwise do) while still never
// exposing a row of auth.users or letting anyone but an admin call it at all.

describe('an admin sees the fixture upload counted against its store', () => {
  const rows = JSON.parse(psql(
    "select coalesce(json_agg(row_to_json(t)), '[]') from public.storage_usage() t;",
    { role: 'authenticated', user: IDS.admin }
  ));
  const scVariety = rows.find(r => r.store_slug === 'sc-variety');
  assert.ok(scVariety, 'sc-variety should appear in the usage totals');
  assert.ok(Number(scVariety.total_bytes) >= 2400000,
    `expected the fixture's 2.4 MB model counted, got ${scVariety.total_bytes}`);
  assert.ok(Number(scVariety.file_count) >= 1);
});

describe('a store owner cannot call storage_usage at all', () => {
  assert.throws(
    () => psql('select public.storage_usage();', { role: 'authenticated', user: IDS.ownerA }),
    /Only a platform administrator/
  );
});

describe('anon cannot call it either', () => {
  assert.throws(
    () => psql('select public.storage_usage();', { role: 'anon' }),
    /Only a platform administrator|permission denied/
  );
});

/* ----------------------------------------------------- approval does its job -- */

describe('approving creates the store, links the owner, and logs who did it', () => {
  const result = psql(
    `select public.approve_store_application('${IDS.pending}', 'test-approved-shop');`,
    { role: 'authenticated', user: IDS.admin });
  assert.match(result, /store_id/, 'the function should return the new store');

  const linked = psql(`select count(*) from public.store_members m
      join public.stores s on s.id = m.store_id
     where s.slug = 'test-approved-shop' and m.role = 'owner';`, { role: null });
  assert.equal(linked, '1', 'the applicant’s account must be linked as owner');

  const status = psql(`select status from public.store_applications where id = '${IDS.pending}';`,
    { role: null });
  assert.equal(status, 'approved');

  const audit = psql(`select count(*) from public.admin_audit
     where action = 'application.approved' and subject = '${IDS.pending}';`, { role: null });
  assert.equal(audit, '1', 'the decision must leave an audit row');
});

describe('an application cannot be approved twice', () => {
  assert.throws(
    () => psql(`select public.approve_store_application('${IDS.pending}');`,
      { role: 'authenticated', user: IDS.admin }),
    /already approved/,
    'a second approval would create a duplicate store'
  );
});

describe('the audit trail cannot be forged or erased', () => {
  assert.throws(
    () => psql(`insert into public.admin_audit (action) values ('application.approved');`,
      { role: 'authenticated', user: IDS.admin }),
    /permission denied|row-level security/,
    'even an admin must not be able to write the log by hand'
  );
  assert.throws(
    () => psql("delete from public.admin_audit;", { role: 'authenticated', user: IDS.admin }),
    /permission denied|row-level security/,
    'an admin must not be able to delete their own trail'
  );
});

/* ------------------------------------------- the owner portal stays scoped -- */

describe('an approved owner administers only their own store', () => {
  const own = psql(`select count(*) from public.products p
      join public.stores s on s.id = p.store_id where s.slug = 'sc-variety';`,
    { role: 'authenticated', user: IDS.ownerA });
  assert.ok(Number(own) >= 0);

  // Owner B must not be able to touch Owner A's rows.
  const crossWrite = psql(`
    with target as (select p.id from public.products p
      join public.stores s on s.id = p.store_id where s.slug = 'sc-variety' limit 1)
    update public.products set stock = 999
     where id in (select id from target)
    returning 'CHANGED';`, { role: 'authenticated', user: IDS.ownerB });
  assert.notEqual(crossWrite, 'CHANGED', 'one shop must not be able to edit another’s stock');
});
