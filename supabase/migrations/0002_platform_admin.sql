-- ===========================================================================
-- Platform administration: the superadmin who vets store owners.
--
-- Two portals, two roles, one boundary.
--
--   store owner   signs up, waits for approval, then administers their OWN
--                 store: products, models, stock. Enforced by 0001's policies,
--                 which scope every row to a store the caller belongs to.
--
--   superadmin    reviews sign-ups before a store exists at all, and is the
--                 only role that can read the application queue or turn an
--                 application into a store.
--
-- The boundary is here, in the database, not in the interface. A hidden button
-- is not a permission: if the only thing stopping someone reading the queue is
-- that the page did not render a link, then anyone who can call PostgREST can
-- read it. So every rule below is a policy or a security-definer function, and
-- the portals are just views onto what the caller is already allowed to do.
--
-- This is also why the app holds the PUBLISHABLE key and never the secret one.
-- A service_role key bypasses every policy in this file; with it, "superadmin"
-- would mean "whoever obtained the key".
-- ===========================================================================

-- ------------------------------------------------------------- the roster ---
-- Who is a superadmin. Deliberately a table rather than a JWT claim or an
-- email allowlist in the app: it is auditable, revocable in one statement, and
-- it cannot be spoofed by anything a browser sends.

create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  note       text,
  added_at   timestamptz not null default now(),
  added_by   uuid references auth.users (id) on delete set null
);

alter table public.platform_admins enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.platform_admins a where a.user_id = auth.uid()
  );
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to anon, authenticated, service_role;

-- An admin can see who else is an admin. Nobody else can see the table exists.
--
-- There is no insert or delete policy on purpose: promoting an account is done
-- with database credentials, in the SQL editor. An admin who could promote
-- accounts could grant themselves a successor and make removal meaningless,
-- and for a platform with one operator that trade buys nothing.
drop policy if exists platform_admins_admin_read on public.platform_admins;
create policy platform_admins_admin_read on public.platform_admins
  for select using (public.is_platform_admin());

-- --------------------------------------------------------------- the audit --
-- Every decision leaves a row. Written by the functions below, inside the same
-- transaction as the decision itself, so the log cannot disagree with reality.

create table if not exists public.admin_audit (
  id          uuid primary key default gen_random_uuid(),
  actor       uuid references auth.users (id) on delete set null,
  actor_email text,
  action      text not null,
  subject     uuid,
  detail      jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);

create index if not exists admin_audit_at_idx on public.admin_audit (at desc);

alter table public.admin_audit enable row level security;

-- Readable by admins, written only by the security-definer functions. No
-- insert policy, so nothing can forge an entry through PostgREST.
drop policy if exists admin_audit_admin_read on public.admin_audit;
create policy admin_audit_admin_read on public.admin_audit
  for select using (public.is_platform_admin());

-- --------------------------------------------------------- the review queue --
-- 0001 left store_applications deliberately unreadable: the form is open to
-- the public, the queue is not. The superadmin is the exception, and the only
-- one.

drop policy if exists store_applications_admin_read on public.store_applications;
create policy store_applications_admin_read on public.store_applications
  for select using (public.is_platform_admin());

grant select on public.store_applications to authenticated;
grant select on public.platform_admins, public.admin_audit to authenticated;

-- An admin also needs to see every store and every membership to do the job —
-- including suspended stores, which the public policy hides.
drop policy if exists stores_admin_read on public.stores;
create policy stores_admin_read on public.stores
  for select using (public.is_platform_admin());

drop policy if exists store_members_admin_read on public.store_members;
create policy store_members_admin_read on public.store_members
  for select using (public.is_platform_admin());

-- Suspending a shop is an administrative act, not a shop's own.
drop policy if exists stores_admin_write on public.stores;
create policy stores_admin_write on public.stores
  for update using (public.is_platform_admin()) with check (public.is_platform_admin());

-- ------------------------------------------------------------- decisions ----
-- Approval and rejection are functions, not table writes.
--
-- Approving is four changes that must all happen or none: create the store,
-- link the applicant's account to it, close the application, record who did
-- it. A policy allowing an admin to UPDATE store_applications directly would
-- let a half-done approval exist — an application marked approved with no
-- store behind it, and no trace of who did that.

create or replace function public.slugify(value text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(btrim(value)), '[^a-z0-9]+', '-', 'g'));
$$;

create or replace function public.approve_store_application(
  application uuid,
  store_slug  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  app         public.store_applications;
  owner_user  uuid;
  new_slug    text;
  target      uuid;
  actor_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may decide applications'
      using errcode = '42501';
  end if;

  -- for update: two admins pressing approve at the same moment must not both
  -- succeed and create two stores.
  select * into app from public.store_applications where id = application for update;
  if not found then
    raise exception 'No application with id %', application using errcode = 'P0002';
  end if;
  if app.status <> 'pending' then
    raise exception 'That application was already %', app.status using errcode = '22023';
  end if;

  select id into owner_user from auth.users where lower(email) = lower(app.contact_email);
  if owner_user is null then
    raise exception
      'No account exists for % yet. The applicant must confirm their email address before the store can be linked.',
      app.contact_email using errcode = 'P0002';
  end if;

  new_slug := coalesce(nullif(btrim(store_slug), ''), public.slugify(app.store_name));
  if new_slug is null or new_slug = '' then
    raise exception 'Could not derive a store slug from %', app.store_name using errcode = '22023';
  end if;

  insert into public.stores (slug, name, plan, status)
  values (new_slug, app.store_name, 'freemium', 'active')
  on conflict (slug) do update set name = excluded.name
  returning id into target;

  insert into public.store_members (store_id, user_id, role)
  values (target, owner_user, 'owner')
  on conflict do nothing;

  update public.store_applications
     set status = 'approved',
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         approved_store_id = target
   where id = application;

  select email into actor_email from auth.users where id = auth.uid();

  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, 'application.approved', application,
          jsonb_build_object('store_id', target, 'slug', new_slug,
                             'store_name', app.store_name,
                             'contact_email', app.contact_email));

  return jsonb_build_object('store_id', target, 'slug', new_slug, 'user_id', owner_user);
end;
$$;

create or replace function public.reject_store_application(
  application uuid,
  note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  app         public.store_applications;
  actor_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may decide applications'
      using errcode = '42501';
  end if;

  select * into app from public.store_applications where id = application for update;
  if not found then
    raise exception 'No application with id %', application using errcode = 'P0002';
  end if;
  if app.status <> 'pending' then
    raise exception 'That application was already %', app.status using errcode = '22023';
  end if;

  update public.store_applications
     set status = 'rejected',
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_note = note
   where id = application;

  select email into actor_email from auth.users where id = auth.uid();

  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, 'application.rejected', application,
          jsonb_build_object('store_name', app.store_name,
                             'contact_email', app.contact_email,
                             'note', note));

  return jsonb_build_object('status', 'rejected');
end;
$$;

-- The functions check is_platform_admin() themselves, so granting execute to
-- every signed-in account is safe: a non-admin calling them gets 42501.
revoke all on function public.approve_store_application(uuid, text) from public;
revoke all on function public.reject_store_application(uuid, text) from public;
grant execute on function public.approve_store_application(uuid, text) to authenticated, service_role;
grant execute on function public.reject_store_application(uuid, text) to authenticated, service_role;
grant execute on function public.slugify(text) to anon, authenticated, service_role;
