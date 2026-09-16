-- Identities for tests/admin.test.js.
--
-- Four accounts, because the interesting failures are between roles that are
-- all legitimately signed in: an owner reading another owner's data, an owner
-- reading the sign-up queue, a stranger approving themselves.

-- Reset to a known state first. These tests approve an application, which is
-- a permanent change; without this, a second run finds nothing pending and
-- fails for the wrong reason.
delete from public.admin_audit
 where subject in (select id from public.store_applications
                    where contact_email = 'applicant@test.ph');
delete from public.store_members
 where store_id in (select id from public.stores where slug = 'test-approved-shop');
delete from public.stores where slug = 'test-approved-shop';
delete from public.store_applications
 where contact_email in ('applicant@test.ph', 'unconfirmed@test.ph');
delete from public.product_assets
 where object_path like '%/test-fixture-model.glb';
delete from public.products where slug = 'test-fixture-draft';

insert into auth.users (id, email, email_confirmed_at) values
  (gen_random_uuid(), 'owner-a@test.ph', now()),
  (gen_random_uuid(), 'owner-b@test.ph', now()),
  (gen_random_uuid(), 'admin@test.ph', now()),
  (gen_random_uuid(), 'outsider@test.ph', now()),
  (gen_random_uuid(), 'applicant@test.ph', now()),
  -- Signed up but never clicked the confirmation link: nothing proves this
  -- address belongs to them, so approving their shop must be refused.
  (gen_random_uuid(), 'unconfirmed@test.ph', null)
on conflict (email) do update set email_confirmed_at = excluded.email_confirmed_at;

-- Owner A runs S&C, owner B runs Tiampion. Both stores come from seed.sql.
insert into public.store_members (store_id, user_id, role)
select s.id, u.id, 'owner'
  from public.stores s, auth.users u
 where s.slug = 'sc-variety' and u.email = 'owner-a@test.ph'
on conflict do nothing;

insert into public.store_members (store_id, user_id, role)
select s.id, u.id, 'owner'
  from public.stores s, auth.users u
 where s.slug = 'tiampion' and u.email = 'owner-b@test.ph'
on conflict do nothing;

-- The superadmin. In production this row is added by hand in the SQL editor;
-- that is the whole point of there being no insert policy on the table.
insert into public.platform_admins (user_id, email, note)
select id, email, 'test fixture' from auth.users where email = 'admin@test.ph'
on conflict (user_id) do nothing;

-- One application waiting to be reviewed, from an account that already exists
-- (so approval can link it).
insert into public.store_applications (store_name, contact_email, contact_phone, message)
values ('Test Approved Shop', 'applicant@test.ph', '+63431112222', 'Fixture application')
on conflict do nothing;

-- A second application whose applicant has not confirmed their email.
insert into public.store_applications (store_name, contact_email, contact_phone, message)
values ('Test Unconfirmed Shop', 'unconfirmed@test.ph', '+63431113333', 'Fixture application')
on conflict do nothing;

-- A draft product with a model attached, in owner A's store. Draft on purpose:
-- the public read policy would never show this to anyone outside the store,
-- so it is what proves the admin-visibility policies (0004) actually reach
-- past status and store membership, not just past the public/member split
-- 0001 already covered.
insert into public.products (
  id, store_id, slug, name, price_php, stock, width_cm, height_cm, depth_cm, status
)
select gen_random_uuid(), s.id, 'test-fixture-draft', 'Fixture Draft Bench',
       1500, 2, 100, 45, 40, 'draft'
  from public.stores s where s.slug = 'sc-variety'
on conflict (store_id, slug) do nothing;

insert into public.product_assets (product_id, store_id, kind, object_path, byte_size, mime_type)
select p.id, p.store_id, 'glb', p.store_id::text || '/' || p.id::text || '/test-fixture-model.glb',
       2400000, 'model/gltf-binary'
  from public.products p where p.slug = 'test-fixture-draft'
on conflict (product_id, kind) do nothing;
