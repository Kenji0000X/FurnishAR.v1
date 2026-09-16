-- ============================================================================
-- LOCAL TEST SCAFFOLDING ONLY — do not run this against Supabase.
--
-- Supabase's platform provides the `auth` schema, `auth.uid()`, the anon /
-- authenticated / service_role database roles, and the `storage` schema. A
-- plain Postgres has none of them, so this file creates just enough of each
-- for tests/db.test.js to exercise the real migration and its RLS policies.
--
-- The stubs mirror Supabase's own definitions: auth.uid() reads the `sub`
-- claim out of the `request.jwt.claims` setting, exactly as it does in
-- production, so the policies under test are the shipped ones.
-- ============================================================================

create schema if not exists auth;
create schema if not exists storage;

-- Enough of Supabase's auth.users to test against: the columns the policies and
-- the approval function actually read. Approval refuses an unconfirmed or
-- disabled account, so those columns have to exist here or the test would pass
-- for the wrong reason.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  banned_until       timestamptz
);
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists last_sign_in_at    timestamptz;
alter table auth.users add column if not exists banned_until       timestamptz;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  )
$$;

-- storage.buckets / storage.objects, trimmed to the columns the policies touch.
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets (id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- Supabase's helper: splits an object path into its folder segments.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end $$;

-- The three roles Supabase connects as.
do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;

grant usage on schema auth, storage to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
grant all on storage.buckets, storage.objects to service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.objects to anon;
