/**
 * Schema and row-level-security tests for supabase/migrations/0001_init.sql.
 *
 * These run against a throwaway local Postgres, not against Supabase. The
 * migration under test is the exact file that ships; tests/supabase-local.sql
 * only supplies the platform pieces Supabase would provide (the auth schema,
 * auth.uid(), the anon/authenticated/service_role roles, and storage).
 *
 * Each case connects the way the real client does: assume a role, set the JWT
 * claims for a user, and let RLS decide. If a policy is wrong, these fail.
 *
 * Skipped automatically when no local Postgres is reachable, so `npm test`
 * still passes on a machine without one. Point them somewhere else with
 * FURNISHAR_TEST_PG (a libpq connection string).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONN = process.env.FURNISHAR_TEST_PG || 'postgresql://postgres@localhost:55432/postgres?host=/tmp';
const DB = 'furnishar_rls_test';

function psql(sql, { db = DB, quiet = true } = {}) {
  const url = CONN.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
  return execFileSync('psql', [url, '-X', '-A', '-t', quiet ? '-q' : '-e', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function psqlFile(file, db = DB) {
  const url = CONN.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
  return execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, file)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** Runs sql as `role`, acting as `userId`, the way PostgREST does per request. */
function asUser(role, userId, sql) {
  const claims = userId ? `'{"sub":"${userId}","role":"${role}"}'` : `'{"role":"${role}"}'`;
  return psql(`begin;
    set local role ${role};
    set local request.jwt.claims = ${claims};
    ${sql};
  commit;`);
}

function expectFailure(role, userId, sql) {
  try {
    asUser(role, userId, sql);
    return null;
  } catch (error) {
    return String(error.stderr || error.message);
  }
}

let available = true;
let scVarietyId, tiampionId, ownerA, ownerB, armchairId;

test.before(() => {
  try {
    psql('select 1', { db: 'postgres' });
  } catch {
    available = false;
    return;
  }
  psql(`drop database if exists ${DB}`, { db: 'postgres' });
  psql(`create database ${DB}`, { db: 'postgres' });
  psqlFile('tests/supabase-local.sql');
  psqlFile('supabase/migrations/0001_init.sql');
  psqlFile('supabase/seed.sql');

  // Two shop owners, each linked to their own store — the admin step from seed.sql.
  ownerA = psql(`insert into auth.users (email) values ('owner@furnishar.ph') returning id`);
  ownerB = psql(`insert into auth.users (email) values ('tiampion@furnishar.ph') returning id`);
  scVarietyId = psql(`select id from public.stores where slug = 'sc-variety'`);
  tiampionId = psql(`select id from public.stores where slug = 'tiampion'`);
  psql(`insert into public.store_members (store_id, user_id, role) values
          ('${scVarietyId}', '${ownerA}', 'owner'),
          ('${tiampionId}', '${ownerB}', 'owner')`);
  armchairId = psql(`select id from public.products where slug = 'cane-back-armchair'`);
});

test.after(() => { if (available) psql(`drop database if exists ${DB}`, { db: 'postgres' }); });

const db = (name, fn) => test(name, { skip: !available && 'no local Postgres on ' + CONN }, fn);

db('a shopper sees published furniture and never a draft', () => {
  psql(`insert into public.products (store_id, slug, name, price_php, stock, width_cm, height_cm, depth_cm)
        values ('${scVarietyId}', 'hidden-draft', 'Unfinished Bench', 100, 1, 50, 50, 50)`);

  const published = asUser('anon', null, `select count(*) from public.products`);
  const catalog = asUser('anon', null, `select name from public.catalog`);
  assert.equal(published, '1', 'anon should see exactly the one published product');
  assert.equal(catalog, 'Cane Back Armchair');
});

db('an owner sees their own drafts but nothing from another store', () => {
  const mine = asUser('authenticated', ownerA, `select count(*) from public.products where store_id = '${scVarietyId}'`);
  assert.equal(mine, '2', 'owner A sees their published product and their draft');

  const theirs = asUser('authenticated', ownerB, `select count(*) from public.products where store_id = '${scVarietyId}'`);
  assert.equal(theirs, '1', 'owner B only ever sees store A\'s published row, not the draft');
});

db('furniture is separated per store: one owner cannot write into another store', () => {
  const error = expectFailure('authenticated', ownerB,
    `insert into public.products (store_id, slug, name, price_php, stock, width_cm, height_cm, depth_cm)
     values ('${scVarietyId}', 'sneaky', 'Not Mine', 100, 1, 50, 50, 50)`);
  assert.match(error || '', /row-level security/i);
});

db('an owner cannot edit or delete another store\'s furniture', () => {
  // RLS filters the row out rather than erroring, so nothing is updated.
  asUser('authenticated', ownerB, `update public.products set price_php = 1 where id = '${armchairId}'`);
  const price = psql(`select price_php from public.products where id = '${armchairId}'`);
  assert.equal(price, '9850.00', 'price is untouched by the other store');

  asUser('authenticated', ownerB, `delete from public.products where id = '${armchairId}'`);
  assert.equal(psql(`select count(*) from public.products where id = '${armchairId}'`), '1');
});

db('an owner can add furniture to their own store', () => {
  asUser('authenticated', ownerA,
    `insert into public.products (store_id, slug, name, price_php, stock, width_cm, height_cm, depth_cm, status)
     values ('${scVarietyId}', 'oak-stool', 'Oak Stool', 1500, 4, 35, 45, 35, 'published')`);
  assert.equal(psql(`select count(*) from public.products where slug = 'oak-stool'`), '1');
  assert.ok(psql(`select published_at from public.products where slug = 'oak-stool'`), 'published_at is stamped by the trigger');
});

db('the freemium cap holds in the database, not just the UI', () => {
  // Tiampion is freemium: 8 products allowed.
  for (let i = 0; i < 8; i++) {
    asUser('authenticated', ownerB,
      `insert into public.products (store_id, slug, name, price_php, stock, width_cm, height_cm, depth_cm)
       values ('${tiampionId}', 'item-${i}', 'Item ${i}', 100, 1, 50, 50, 50)`);
  }
  const error = expectFailure('authenticated', ownerB,
    `insert into public.products (store_id, slug, name, price_php, stock, width_cm, height_cm, depth_cm)
     values ('${tiampionId}', 'item-9', 'One Too Many', 100, 1, 50, 50, 50)`);
  assert.match(error || '', /Freemium plan limited to 8 products/);
});

db('only premium stores can feature a product', () => {
  const error = expectFailure('authenticated', ownerB,
    `update public.products set featured = true where slug = 'item-0'`);
  assert.match(error || '', /premium plan feature/i);

  asUser('authenticated', ownerA, `update public.products set featured = true where slug = 'oak-stool'`);
  assert.equal(psql(`select featured from public.products where slug = 'oak-stool'`), 't');
});

db('a model file is filed under its own store and inherits it automatically', () => {
  asUser('authenticated', ownerA,
    `insert into public.product_assets (product_id, store_id, kind, object_path, byte_size, mime_type)
     values ('${armchairId}', '${tiampionId}', 'glb', '${scVarietyId}/${armchairId}/model.glb', 1367856, 'model/gltf-binary')`);
  const stored = psql(`select store_id from public.product_assets where product_id = '${armchairId}'`);
  assert.equal(stored, scVarietyId, 'the trigger overrides a wrong store_id with the product\'s real one');

  const error = expectFailure('authenticated', ownerA,
    `insert into public.product_assets (product_id, store_id, kind, object_path)
     values ('${armchairId}', '${scVarietyId}', 'usdz', '${tiampionId}/${armchairId}/model.usdz')`);
  assert.match(error || '', /product_assets_path_scoped/, 'a path outside the store\'s folder is rejected');
});

db('the catalogue view exposes the uploaded model path to shoppers', () => {
  const row = asUser('anon', null, `select model_glb_path from public.catalog where slug = 'cane-back-armchair'`);
  assert.equal(row, `${scVarietyId}/${armchairId}/model.glb`);
});

db('storage: a store can only write under its own folder', () => {
  psql(`insert into storage.buckets (id, name, public) values ('furniture-models','furniture-models',true)
        on conflict (id) do nothing`);

  asUser('authenticated', ownerA,
    `insert into storage.objects (bucket_id, name) values ('furniture-models', '${scVarietyId}/${armchairId}/model.glb')`);
  assert.equal(psql(`select count(*) from storage.objects`), '1');

  const error = expectFailure('authenticated', ownerA,
    `insert into storage.objects (bucket_id, name) values ('furniture-models', '${tiampionId}/x/model.glb')`);
  assert.match(error || '', /row-level security/i, 'uploading into another store\'s folder is refused');
});

db('the sign-up form is open to the public but its queue is not', () => {
  asUser('anon', null,
    `insert into public.store_applications (store_name, contact_email, contact_phone, message)
     values ('New Mamburao Furnishings', 'hello@newstore.ph', '+63 917 000 0000', 'We have 40 pieces to list.')`);
  assert.equal(psql(`select count(*) from public.store_applications`), '1');

  // Reading the queue is refused twice over: no SELECT privilege is granted,
  // and no select policy exists either. The grant denies it first.
  assert.match(expectFailure('anon', null, `select count(*) from public.store_applications`) || '',
    /permission denied for table store_applications/);
  assert.match(expectFailure('authenticated', ownerA, `select count(*) from public.store_applications`) || '',
    /permission denied for table store_applications/);
  assert.equal(psql(`select count(*) from public.store_applications`), '1', 'service_role still sees the queue');
});

db('a malformed or duplicate application is rejected', () => {
  const bad = expectFailure('anon', null,
    `insert into public.store_applications (store_name, contact_email) values ('X Shop', 'not-an-email')`);
  assert.match(bad || '', /contact_email_check|violates check constraint/i);

  const dup = expectFailure('anon', null,
    `insert into public.store_applications (store_name, contact_email) values ('Again', 'hello@newstore.ph')`);
  assert.match(dup || '', /store_applications_one_pending|duplicate key/i);
});

db('an applicant cannot approve their own application', () => {
  const error = expectFailure('anon', null,
    `update public.store_applications set status = 'approved' where contact_email = 'hello@newstore.ph'`);
  // No update policy: the row is invisible to the update, so nothing changes.
  assert.equal(psql(`select status from public.store_applications where contact_email = 'hello@newstore.ph'`), 'pending');
  assert.ok(error === null || /permission|row-level/i.test(error));
});

db('a suspended store disappears from the public catalogue', () => {
  psql(`update public.stores set status = 'suspended' where id = '${scVarietyId}'`);
  assert.equal(asUser('anon', null, `select count(*) from public.catalog where store_slug = 'sc-variety'`), '0');
  // ...but its owner can still see and fix their listings.
  assert.ok(Number(asUser('authenticated', ownerA, `select count(*) from public.products where store_id = '${scVarietyId}'`)) > 0);
  psql(`update public.stores set status = 'active' where id = '${scVarietyId}'`);
});
