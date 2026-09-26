/**
 * 0012: catalogue posters and the 365-day model lifecycle, against a real
 * Postgres built from every migration.
 *
 * Needs a local Postgres (see tests/db.test.js); skips itself without one.
 *   FURNISHAR_TEST_PG=postgresql://postgres@localhost:55432/postgres?host=/tmp
 *
 * Storage is the local stub from tests/supabase-local.sql. The Storage API
 * deletes an object by running DELETE on storage.objects as the caller, under
 * the bucket's policies — so a DELETE as the admin here is what the API does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CONN = process.env.FURNISHAR_TEST_PG || 'postgresql://postgres@localhost:55432/postgres?host=/tmp';
const DB = 'furnishar_lifecycle_test';
const url = db => CONN.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);

function psql(sql, db = DB) {
  return execFileSync('psql', [url(db), '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/** As a signed-in user (or anon), the way PostgREST runs a request. */
function as(userId, sql, role = 'authenticated') {
  const claims = userId ? `{"sub":"${userId}","role":"${role}"}` : `{"role":"${role}"}`;
  const out = psql(`begin; set local role ${role}; set local request.jwt.claims = '${claims}'; ${sql}; commit;`);
  return out.split('\n').filter(Boolean).pop() || '';
}

function refused(userId, sql, role) {
  try { as(userId, sql, role); return null; } catch (error) { return String(error.stderr || error.message); }
}

let available = true;
const ids = {};

test.before(() => {
  try { psql('select 1', 'postgres'); } catch { available = false; return; }
  psql(`drop database if exists ${DB}`, 'postgres');
  psql(`create database ${DB}`, 'postgres');
  const files = ['tests/supabase-local.sql',
    ...fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()
      .map(f => `supabase/migrations/${f}`),
    'supabase/seed.sql'];
  for (const file of files) {
    execFileSync('psql', [url(DB), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, file)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  const user = email => psql(`insert into auth.users (email, email_confirmed_at) values ('${email}', now()) returning id`);
  ids.owner = user('owner@lifecycle.test');
  ids.otherOwner = user('other@lifecycle.test');
  ids.admin = user('admin@lifecycle.test');
  ids.buyer = user('buyer@lifecycle.test');
  ids.store = psql(`select id from public.stores where slug = 'sc-variety'`);
  ids.otherStore = psql(`select id from public.stores where slug = 'tiampion'`);
  psql(`insert into public.store_members (store_id, user_id, role) values
          ('${ids.store}', '${ids.owner}', 'owner'), ('${ids.otherStore}', '${ids.otherOwner}', 'owner')`);
  psql(`insert into public.platform_admins (user_id, email) values ('${ids.admin}', 'admin@lifecycle.test')`);
});

test.after(() => { if (available) psql(`drop database if exists ${DB}`, 'postgres'); });

const db = (name, fn) => test(name, { skip: !available && `no local Postgres on ${CONN}` }, fn);

/** A published product with a model (and optionally a poster), uploaded by its owner. */
function listing(slug, { poster = true, status = 'published' } = {}) {
  const product = psql(`insert into public.products (store_id, slug, name, category, price_php, stock,
      width_cm, height_cm, depth_cm, status)
    values ('${ids.store}', '${slug}', 'Fixture ${slug}', 'Chair', 1000, 2, 70, 88, 78, '${status}') returning id`);
  const glbPath = `${ids.store}/${product}/model.glb`;
  as(ids.owner, `insert into public.product_assets (product_id, store_id, kind, bucket, object_path, byte_size)
    values ('${product}', '${ids.store}', 'glb', 'furniture-models', '${glbPath}', 2048)`);
  psql(`insert into storage.objects (bucket_id, name) values ('furniture-models', '${glbPath}')`);
  let posterPath = null;
  if (poster) {
    posterPath = `${ids.store}/${product}/poster-0123456789abcdef.webp`;
    as(ids.owner, `insert into public.product_assets (product_id, store_id, kind, bucket, object_path, byte_size)
      values ('${product}', '${ids.store}', 'poster', 'product-posters', '${posterPath}', 20000)`);
    psql(`insert into storage.objects (bucket_id, name) values ('product-posters', '${posterPath}')`);
  }
  const asset = psql(`select id from public.product_assets where product_id = '${product}' and kind = 'glb'`);
  return { product, asset, glbPath, posterPath };
}

/**
 * Moves a model's history back in time (only a superuser can: that is the
 * point). `noticed` is how many days ago the owners were emailed (0013); left
 * out, it is what the daily notice job would have done — sent on the day the
 * model reached 335 idle days — and `null` means no notice was ever sent.
 */
function age(asset, { uploaded, accessed, noticed }) {
  const idle = accessed ?? uploaded;
  const notice = noticed !== undefined ? noticed : idle >= 335 ? idle - 335 : null;
  psql(`alter table public.product_assets disable trigger product_assets_lifecycle;
        update public.product_assets set
          created_at = now() - interval '${uploaded} days',
          last_accessed_at = ${accessed == null ? 'null' : `now() - interval '${accessed} days'`},
          expiry_notice_at = ${notice == null ? 'null' : `now() - interval '${notice} days'`}
        where id = '${asset}';
        alter table public.product_assets enable trigger product_assets_lifecycle;`);
}

const lifecycle = asset => JSON.parse(as(ids.admin,
  `select row_to_json(l) from public.admin_model_lifecycle('${asset}') l`));

db('a model uploaded today has never been used and is not eligible', () => {
  const { asset } = listing('fresh');
  const row = lifecycle(asset);
  assert.equal(row.last_accessed_at, null);
  assert.equal(row.idle_days, 0);
  assert.equal(row.eligible, false);
});

db('an owner cannot forge the lifecycle: last access and upload time are the database\'s', () => {
  const { asset } = listing('forged');
  as(ids.owner, `update public.product_assets set last_accessed_at = '2000-01-01', created_at = '2000-01-01',
                  expiry_notice_at = '2000-01-01' where id = '${asset}'`);
  const row = lifecycle(asset);
  assert.equal(row.last_accessed_at, null, 'last access cannot be written by the owner');
  assert.equal(row.eligible, false, 'backdating the upload must not make it deletable');
  assert.equal(row.notice_sent_at, null, 'nor can an owner record a notice');
});

db('a successful, authorised access records the time; a refused one does not', () => {
  const { asset, glbPath } = listing('used');
  assert.equal(as(ids.buyer, `select public.record_model_access('${glbPath}')`), 't');
  assert.notEqual(lifecycle(asset).last_accessed_at, null);
  // Once a day is enough: the second open the same day writes nothing.
  assert.equal(as(ids.buyer, `select public.record_model_access('${glbPath}')`), 'f');

  const draft = listing('draft-model', { status: 'draft' });
  assert.equal(as(ids.buyer, `select public.record_model_access('${draft.glbPath}')`), 'f',
    'a buyer cannot open a draft, so opening it cannot count as use');
  assert.equal(lifecycle(draft.asset).last_accessed_at, null);
  assert.equal(as(ids.buyer, `select public.record_model_access('${ids.store}/nope/model.glb')`), 'f');
  assert.ok(refused(null, `select public.record_model_access('${glbPath}')`, 'anon'),
    'a signed-out caller cannot record anything');
});

db('old is not idle: a two-year-old model opened yesterday is active', () => {
  const { asset } = listing('old-but-used');
  age(asset, { uploaded: 730, accessed: 1 });
  const row = lifecycle(asset);
  assert.equal(row.eligible, false);
  assert.equal(row.idle_days, 1);
});

db('364 days unused is not eligible; 365 is', () => {
  const almost = listing('almost');
  age(almost.asset, { uploaded: 500, accessed: 364 });
  assert.equal(lifecycle(almost.asset).eligible, false);
  assert.match(refused(ids.admin, `select public.admin_delete_stale_model('${almost.asset}')`),
    /used recently/);

  const stale = listing('stale-never-opened');
  age(stale.asset, { uploaded: 400, accessed: null });
  assert.equal(lifecycle(stale.asset).eligible, true, 'never opened since a 400-day-old upload');
});

db('only a platform admin may delete, and only an eligible model file', () => {
  const { asset, glbPath } = listing('guarded');
  age(asset, { uploaded: 800, accessed: 400 });
  assert.match(refused(ids.owner, `select public.admin_delete_stale_model('${asset}')`), /platform administrator/);
  // (The owner may delete their own file through Storage — that is 0001's
  // policy, for replacing or removing a model. Nobody else may.)
  for (const who of [ids.otherOwner, ids.buyer]) {
    assert.match(refused(who, `select public.admin_delete_stale_model('${asset}')`), /platform administrator/);
    assert.equal(as(who, `with d as (delete from storage.objects where bucket_id = 'furniture-models'
                                     and name = '${glbPath}' returning 1) select count(*) from d`),
      '0', 'no one but the model\'s own store may delete its file');
  }
  const recent = listing('recent');
  assert.equal(as(ids.admin, `with d as (delete from storage.objects where bucket_id = 'furniture-models'
                                         and name = '${recent.glbPath}' returning 1) select count(*) from d`),
    '0', 'Storage refuses an admin delete of a model that is not eligible');
  assert.match(refused(ids.admin, `select public.admin_delete_stale_model('${recent.asset}')`), /not eligible for cleanup/);
});

db('a model opened after the page loaded is re-checked and refused at deletion', () => {
  const { asset, glbPath } = listing('race');
  age(asset, { uploaded: 800, accessed: 400 });
  assert.equal(lifecycle(asset).eligible, true, 'the admin sees it as eligible…');
  as(ids.buyer, `select public.record_model_access('${glbPath}')`);   // …a shopper opens it…
  assert.equal(as(ids.admin, `with d as (delete from storage.objects where bucket_id = 'furniture-models'
                                         and name = '${glbPath}' returning 1) select count(*) from d`), '0');
  assert.match(refused(ids.admin, `select public.admin_delete_stale_model('${asset}')`), /not eligible for cleanup/);
  assert.equal(psql(`select count(*) from public.product_assets where id = '${asset}'`), '1');
});

db('cleanup removes the file, its poster and their rows — never the product — and is audited once', () => {
  const { product, asset, glbPath, posterPath } = listing('cleanup');
  age(asset, { uploaded: 900, accessed: 390 });

  // Metadata first is refused while the file is still there.
  assert.match(refused(ids.admin, `select public.admin_delete_stale_model('${asset}')`), /still in storage/);

  // What storage_usage() reports for the store before the cleanup.
  const usage = () => Number(as(ids.admin,
    `select total_bytes from public.storage_usage() where store_id = '${ids.store}'`));
  const bytesBefore = usage();

  // Step a: the Storage API, as the admin.
  assert.equal(as(ids.admin, `with d as (delete from storage.objects where bucket_id = 'furniture-models'
                                         and name = '${glbPath}' returning 1) select count(*) from d`), '1');
  // The poster still exists, so the metadata is still refused…
  assert.match(refused(ids.admin, `select public.admin_delete_stale_model('${asset}')`), /preview image is still in storage/);
  assert.equal(as(ids.admin, `with d as (delete from storage.objects where bucket_id = 'product-posters'
                                         and name = '${posterPath}' returning 1) select count(*) from d`), '1');

  // Step b: the metadata.
  const result = JSON.parse(as(ids.admin, `select public.admin_delete_stale_model('${asset}')`));
  assert.equal(result.status, 'deleted');
  assert.equal(result.poster_removed, true);

  assert.equal(psql(`select count(*) from public.product_assets where product_id = '${product}'`), '0');
  assert.equal(psql(`select count(*) from public.products where id = '${product}'`), '1', 'the product stays');
  assert.equal(usage(), bytesBefore - 2048 - 20000, 'storage usage drops by the model and its poster');
  assert.equal(psql(`select width_cm from public.products where id = '${product}'`), '70.0', 'with its dimensions');
  const card = as(null, `select coalesce(model_glb_path, 'none') || '|' || coalesce(poster_path, 'none')
                          from public.catalog where id = '${product}'`, 'anon');
  assert.equal(card, 'none|none', 'still listed, with no 3D model and no model-derived picture');

  const audit = JSON.parse(psql(`select json_agg(a) from public.admin_audit a where action = 'model.deleted_stale'
                                   and subject = '${asset}'`));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, ids.admin);
  assert.equal(audit[0].detail.product_id, product);
  assert.equal(audit[0].detail.byte_size, 2048);
  assert.ok(audit[0].detail.idle_days >= 390);
  assert.ok(!JSON.stringify(audit[0].detail).includes('token'), 'no signed URL or token is recorded');

  // A retry after success is harmless: nothing left to do, nothing audited twice.
  assert.equal(JSON.parse(as(ids.admin, `select public.admin_delete_stale_model('${asset}')`)).status, 'gone');
  assert.equal(psql(`select count(*) from public.admin_audit where subject = '${asset}'`), '1');
});

db('an interrupted cleanup can be finished: file already gone, row still there', () => {
  const { asset, glbPath, posterPath } = listing('interrupted', { poster: true });
  age(asset, { uploaded: 800, accessed: 500 });
  // The file and poster went, then the connection dropped before step b.
  psql(`delete from storage.objects where name in ('${glbPath}', '${posterPath}')`);
  // Deleting again is a no-op for Storage, and step b completes.
  assert.equal(as(ids.admin, `with d as (delete from storage.objects where name = '${glbPath}' returning 1)
                               select count(*) from d`), '0');
  assert.equal(JSON.parse(as(ids.admin, `select public.admin_delete_stale_model('${asset}')`)).status, 'deleted');
});

db('replacing a model resets its clock: a new file is a new model', () => {
  const { product, asset } = listing('replaced', { poster: false });
  age(asset, { uploaded: 800, accessed: 500 });
  assert.equal(lifecycle(asset).eligible, true);
  // The portal's upload is an upsert of the same row.
  as(ids.owner, `insert into public.product_assets (product_id, store_id, kind, bucket, object_path, byte_size)
    values ('${product}', '${ids.store}', 'glb', 'furniture-models', '${ids.store}/${product}/model.glb', 4096)
    on conflict (product_id, kind) do update set byte_size = excluded.byte_size`);
  assert.equal(lifecycle(asset).eligible, false);
  assert.equal(lifecycle(asset).idle_days, 0);
});

db('posters: public, store-scoped writes, and the catalogue exposes only the poster path', () => {
  const { product, posterPath } = listing('poster-shown');
  assert.equal(psql(`select public from storage.buckets where id = 'product-posters'`), 't');
  assert.equal(psql(`select public from storage.buckets where id = 'furniture-models'`), 'f',
    'models stay private');
  assert.equal(as(null, `select poster_path from public.catalog where id = '${product}'`, 'anon'), posterPath);
  assert.ok(refused(ids.otherOwner,
    `insert into storage.objects (bucket_id, name) values ('product-posters', '${ids.store}/${product}/poster-ffffffffffffffff.webp')`),
    'another shop cannot write into this shop\'s poster folder');
  as(ids.owner, `insert into storage.objects (bucket_id, name) values ('product-posters', '${ids.store}/${product}/poster-aaaaaaaaaaaaaaaa.webp')`);
  // The poster is not a model: holding its path opens nothing.
  assert.equal(as(ids.buyer, `select public.can_view_model('${posterPath}')`), 'f');
});

db('the lifecycle list is for admins only', () => {
  assert.match(refused(ids.owner, 'select count(*) from public.admin_model_lifecycle()'), /platform administrator/);
  assert.match(refused(ids.buyer, 'select count(*) from public.admin_model_lifecycle()'), /platform administrator/);
  assert.ok(Number(as(ids.admin, 'select count(*) from public.admin_model_lifecycle()')) > 0);
});

// ------------------------------------------------ 0013: the owner notice ---

const SECRET = 'lifecycle-test-recorder-secret-0123456789';
function withSecret() {
  // assert_server() compares against the stored secret (0011).
  psql(`insert into billing_private.secrets (name, sha256_hex)
        values ('payment_recorder', encode(sha256(convert_to('${SECRET}', 'UTF8')), 'hex'))
        on conflict do nothing`);
}

db('a year idle is not enough without a notice to the owners', () => {
  const { asset, glbPath } = listing('never-told');
  age(asset, { uploaded: 800, accessed: 400, noticed: null });
  const row = lifecycle(asset);
  assert.equal(row.eligible, false, 'no notice, no deletion');
  assert.equal(row.notice_due, true);
  assert.equal(row.notice_sent_at, null);
  assert.equal(as(ids.admin, `with d as (delete from storage.objects where bucket_id = 'furniture-models'
                                         and name = '${glbPath}' returning 1) select count(*) from d`), '0',
    'Storage refuses too');
  assert.match(refused(ids.admin, `select public.admin_delete_stale_model('${asset}')`), /30 days since being notified/);
});

db('a notice counts only after 30 days, and only for the current idle spell', () => {
  const fresh = listing('told-yesterday');
  age(fresh.asset, { uploaded: 800, accessed: 400, noticed: 1 });
  assert.equal(lifecycle(fresh.asset).eligible, false, 'told yesterday: 29 more days to answer');
  assert.equal(lifecycle(fresh.asset).eligible_on,
    psql(`select (now() + interval '29 days')::date`), 'deletable from 30 days after the notice');

  const told = listing('told-long-ago');
  age(told.asset, { uploaded: 800, accessed: 400, noticed: 31 });
  assert.equal(lifecycle(told.asset).eligible, true);

  // A notice from BEFORE the last use is about an idle spell that ended.
  const stale = listing('old-notice');
  age(stale.asset, { uploaded: 900, accessed: 400, noticed: 500 });
  assert.equal(lifecycle(stale.asset).eligible, false);
  assert.equal(lifecycle(stale.asset).notice_sent_at, null);
  assert.equal(lifecycle(stale.asset).notice_due, true);
});

db('the notice job: due at 335 idle days, recorded once, only with the server secret', () => {
  withSecret();
  const early = listing('not-yet-due');
  age(early.asset, { uploaded: 400, accessed: 334, noticed: null });
  const due = listing('due-now');
  age(due.asset, { uploaded: 400, accessed: 336, noticed: null });

  const list = JSON.parse(psql(`select json_agg(d) from public.server_models_due_notice('${SECRET}') d`));
  const ids_ = list.map(row => row.asset_id);
  assert.ok(ids_.includes(due.asset), 'a model idle 336 days is due');
  assert.ok(!ids_.includes(early.asset), 'a model idle 334 days is not');
  const row = list.find(r => r.asset_id === due.asset);
  assert.equal(row.store_id, ids.store);
  assert.equal(row.deletable_from, psql(`select (now() + interval '30 days')::date`),
    'the email can name the day: 30 days from now, since the year is up sooner');

  assert.ok(refused(null, `select public.server_models_due_notice('wrong-secret-0123456789abcdef0123')`, 'anon'),
    'no secret, no list of shops');
  assert.ok(refused(ids.owner, `select public.server_mark_model_notice('nope', '${due.asset}')`),
    'an owner cannot record a notice');

  assert.equal(as(null, `select public.server_mark_model_notice('${SECRET}', '${due.asset}')`, 'anon'), 't');
  assert.notEqual(lifecycle(due.asset).notice_sent_at, null);
  assert.equal(lifecycle(due.asset).notice_due, false, 'told once per idle spell');
  assert.equal(as(null, `select public.server_mark_model_notice('${SECRET}', '${due.asset}')`, 'anon'), 'f',
    'a second mark changes nothing');
  assert.equal(as(null, `select public.server_mark_model_notice('${SECRET}', '${early.asset}')`, 'anon'), 'f',
    'a model not yet due cannot be marked');
  const after = psql(`select created_at < now() - interval '399 days' from public.product_assets where id = '${due.asset}'`);
  assert.equal(after, 't', 'recording a notice does not look like a re-upload');
});

db('the owner sees where each model stands, and "Keep" resets the clock', () => {
  const { product, asset } = listing('keep-me');
  age(asset, { uploaded: 800, accessed: 400, noticed: 40 });
  assert.equal(lifecycle(asset).eligible, true);

  const mine = JSON.parse(as(ids.owner,
    `select json_agg(l) from public.store_model_lifecycle('${ids.store}') l where l.asset_id = '${asset}'`))[0];
  assert.equal(mine.product_id, product);
  assert.equal(mine.at_risk, true);
  assert.equal(mine.eligible, true);
  assert.notEqual(mine.notice_sent_at, null);

  assert.match(refused(ids.otherOwner, `select count(*) from public.store_model_lifecycle('${ids.store}')`), /members/);
  assert.match(refused(ids.otherOwner, `select public.keep_model('${asset}')`), /members/);
  assert.match(refused(ids.buyer, `select public.keep_model('${asset}')`), /members/);

  const kept = JSON.parse(as(ids.owner, `select public.keep_model('${asset}')`));
  assert.equal(kept.status, 'kept');
  const row = lifecycle(asset);
  assert.equal(row.eligible, false, 'kept: no longer deletable');
  assert.equal(row.idle_days, 0);
  assert.equal(row.notice_sent_at, null, 'the old notice stops counting');
  assert.equal(row.eligible_on, psql(`select (now() + interval '365 days')::date`));
});

db('a re-upload clears the notice with the clock', () => {
  const { product, asset } = listing('reupload-notice', { poster: false });
  age(asset, { uploaded: 800, accessed: 400, noticed: 40 });
  as(ids.owner, `insert into public.product_assets (product_id, store_id, kind, bucket, object_path, byte_size)
    values ('${product}', '${ids.store}', 'glb', 'furniture-models', '${ids.store}/${product}/model.glb', 4096)
    on conflict (product_id, kind) do update set byte_size = excluded.byte_size`);
  assert.equal(psql(`select expiry_notice_at is null from public.product_assets where id = '${asset}'`), 't');
});
