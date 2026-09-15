-- ============================================================================
-- FurnishAR — initial schema
--
-- Run this in the Supabase SQL editor, or with the Supabase CLI:
--     supabase db push
--
-- Everything here assumes Supabase's managed pieces already exist:
--   * the `auth` schema, `auth.users`, and `auth.uid()`
--   * the `anon`, `authenticated` and `service_role` database roles
--   * the `storage` schema (for the bucket policies at the bottom)
--
-- Model of the world:
--   stores               one row per shop
--   store_members        which auth users may act for which store
--   products             furniture, always owned by exactly one store
--   product_assets       the uploaded .glb / .usdz / poster files
--   store_applications   the public "bring your store online" sign-up form
--
-- Every table has row level security on. A shop owner can only ever see and
-- change their own store's furniture; shoppers only ever see published rows.
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive email/slug

-- ---------------------------------------------------------------- enums ----

do $$ begin
  create type public.store_plan as enum ('freemium', 'premium');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.store_status as enum ('active', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.member_role as enum ('owner', 'staff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.product_status as enum ('draft', 'published', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.asset_kind as enum ('glb', 'usdz', 'poster');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.application_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------------- stores ----

create table if not exists public.stores (
  id              uuid primary key default gen_random_uuid(),
  slug            citext not null unique,
  name            text not null check (length(btrim(name)) between 2 and 120),
  address         text,
  contact_number  text,
  hours           text,
  plan            public.store_plan not null default 'freemium',
  status          public.store_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.stores is 'One row per shop. Furniture is always scoped to a store.';

-- -------------------------------------------------------- store members ----
-- Who is allowed to act for a store. A store can have several owners, and an
-- owner could hold more than one store, so this is a join table rather than a
-- column on either side.

create table if not exists public.store_members (
  store_id    uuid not null references public.stores (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.member_role not null default 'owner',
  created_at  timestamptz not null default now(),
  primary key (store_id, user_id)
);

create index if not exists store_members_user_idx on public.store_members (user_id);

-- ------------------------------------------------------------- products ----

create table if not exists public.products (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  slug              text not null,
  name              text not null check (length(btrim(name)) between 2 and 90),
  category          text not null default 'Storage',
  style             text not null default 'Modern',
  color             text not null default 'Natural',
  price_php         numeric(12,2) not null check (price_php >= 0),
  stock             integer not null default 0 check (stock >= 0),

  -- Real-world size, always centimetres.
  width_cm          numeric(6,1) not null check (width_cm  > 0 and width_cm  <= 1000),
  height_cm         numeric(6,1) not null check (height_cm > 0 and height_cm <= 1000),
  depth_cm          numeric(6,1) not null check (depth_cm  > 0 and depth_cm  <= 1000),

  -- Size the 3D mesh should be scaled to in AR. Falls back to the dimensions
  -- above when the uploaded model is already true to scale.
  bounds_width_cm   numeric(6,1) check (bounds_width_cm  > 0),
  bounds_height_cm  numeric(6,1) check (bounds_height_cm > 0),
  bounds_depth_cm   numeric(6,1) check (bounds_depth_cm  > 0),

  preview_shape     text not null default 'shelf'
                    check (preview_shape in ('sofa','table','chair','bed','shelf','desk')),
  description       text check (length(description) <= 400),
  ar_ready          boolean not null default true,
  featured          boolean not null default false,
  status            public.product_status not null default 'draft',

  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  published_at      timestamptz,

  unique (store_id, slug)
);

create index if not exists products_store_idx     on public.products (store_id);
create index if not exists products_published_idx on public.products (status, featured desc, updated_at desc);
create index if not exists products_category_idx  on public.products (category);

comment on column public.products.bounds_width_cm is
  'Target AR size for the mesh. Null means use width_cm/height_cm/depth_cm.';

-- -------------------------------------------------------- product assets ----
-- The uploaded files live in Storage; this table is the catalogue of them.
-- store_id is denormalised so both the RLS policies and the storage path
-- checks can work without a join back to products.

create table if not exists public.product_assets (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  kind         public.asset_kind not null,
  bucket       text not null default 'furniture-models',
  object_path  text not null,
  byte_size    bigint check (byte_size >= 0),
  mime_type    text,
  checksum     text,
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (product_id, kind),
  -- Files must live under their own store's folder. This is what keeps one
  -- shop's uploads from ever landing in another shop's space.
  constraint product_assets_path_scoped check (object_path like store_id::text || '/%')
);

create index if not exists product_assets_product_idx on public.product_assets (product_id);

-- --------------------------------------------------- store applications ----
-- The public sign-up form on the store portal. Anyone may submit one; only
-- staff (service_role) may read or decide them.

create table if not exists public.store_applications (
  id              uuid primary key default gen_random_uuid(),
  store_name      text not null check (length(btrim(store_name)) between 2 and 120),
  contact_email   citext not null check (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone   text check (contact_phone is null or length(btrim(contact_phone)) between 5 and 32),
  message         text check (length(message) <= 1000),
  status          public.application_status not null default 'pending',
  review_note     text,
  reviewed_at     timestamptz,
  reviewed_by     uuid references auth.users (id) on delete set null,
  approved_store_id uuid references public.stores (id) on delete set null,
  created_at      timestamptz not null default now()
);

-- One open application per email address, so a double-tap on the form cannot
-- create a queue of duplicates.
create unique index if not exists store_applications_one_pending
  on public.store_applications (contact_email)
  where status = 'pending';

-- ------------------------------------------------------------- helpers ----
-- security definer so the policies can ask "is this user in this store?"
-- without recursively evaluating store_members' own RLS.

create or replace function public.is_store_member(target_store uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.store_members m
    where m.store_id = target_store and m.user_id = auth.uid()
  );
$$;

create or replace function public.current_store_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select store_id from public.store_members where user_id = auth.uid();
$$;

revoke all on function public.is_store_member(uuid) from public;
revoke all on function public.current_store_ids() from public;
grant execute on function public.is_store_member(uuid) to anon, authenticated, service_role;
grant execute on function public.current_store_ids() to anon, authenticated, service_role;

-- ------------------------------------------------------------ triggers ----

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists stores_touch on public.stores;
create trigger stores_touch before update on public.stores
  for each row execute function public.touch_updated_at();

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- Plan rules, enforced in the database so they hold no matter which client
-- writes: freemium stores cap at 8 products, and only premium stores may
-- feature a product.
create or replace function public.enforce_plan_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  store_plan_value public.store_plan;
  product_count integer;
  freemium_limit constant integer := 8;
begin
  select plan into store_plan_value from public.stores where id = new.store_id;
  if store_plan_value is null then
    raise exception 'Store % does not exist', new.store_id using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'INSERT' and store_plan_value = 'freemium' then
    select count(*) into product_count
    from public.products
    where store_id = new.store_id and status <> 'archived';

    if product_count >= freemium_limit then
      raise exception
        'Freemium plan limited to % products. Upgrade to premium to list more.', freemium_limit
        using errcode = 'check_violation';
    end if;
  end if;

  if new.featured and store_plan_value <> 'premium' then
    raise exception 'Featured placement is a premium plan feature.'
      using errcode = 'check_violation';
  end if;

  -- Keep published_at honest without asking the client to set it.
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    new.published_at := now();
  end if;

  return new;
end $$;

drop trigger if exists products_plan_rules on public.products;
create trigger products_plan_rules before insert or update on public.products
  for each row execute function public.enforce_plan_rules();

-- Assets inherit their product's store, so a client cannot mis-file an upload.
create or replace function public.set_asset_store()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select store_id into new.store_id from public.products where id = new.product_id;
  if new.store_id is null then
    raise exception 'Product % does not exist', new.product_id using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;

drop trigger if exists product_assets_store on public.product_assets;
create trigger product_assets_store before insert or update on public.product_assets
  for each row execute function public.set_asset_store();

-- ------------------------------------------------------ row level security --

alter table public.stores             enable row level security;
alter table public.store_members      enable row level security;
alter table public.products           enable row level security;
alter table public.product_assets     enable row level security;
alter table public.store_applications enable row level security;

-- Stores: everyone sees active shops; owners maintain their own.
drop policy if exists stores_public_read on public.stores;
create policy stores_public_read on public.stores
  for select using (status = 'active' or public.is_store_member(id));

drop policy if exists stores_member_update on public.stores;
create policy stores_member_update on public.stores
  for update using (public.is_store_member(id)) with check (public.is_store_member(id));

-- Membership is readable by the people in it. Granting membership is an
-- admin action (service_role), never a client one.
drop policy if exists store_members_self_read on public.store_members;
create policy store_members_self_read on public.store_members
  for select using (user_id = auth.uid() or public.is_store_member(store_id));

-- Products: shoppers see published furniture from active shops. Members see
-- everything belonging to their own store, drafts included, and are the only
-- ones who can write it.
drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products
  for select using (
    (status = 'published' and exists (
      select 1 from public.stores s where s.id = products.store_id and s.status = 'active'
    ))
    or public.is_store_member(store_id)
  );

drop policy if exists products_member_insert on public.products;
create policy products_member_insert on public.products
  for insert with check (public.is_store_member(store_id));

drop policy if exists products_member_update on public.products;
create policy products_member_update on public.products
  for update using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

drop policy if exists products_member_delete on public.products;
create policy products_member_delete on public.products
  for delete using (public.is_store_member(store_id));

-- Assets follow their product's visibility.
drop policy if exists product_assets_public_read on public.product_assets;
create policy product_assets_public_read on public.product_assets
  for select using (
    exists (
      select 1 from public.products p
      join public.stores s on s.id = p.store_id
      where p.id = product_assets.product_id
        and ((p.status = 'published' and s.status = 'active') or public.is_store_member(p.store_id))
    )
  );

drop policy if exists product_assets_member_write on public.product_assets;
create policy product_assets_member_write on public.product_assets
  for insert with check (public.is_store_member(
    (select store_id from public.products where id = product_id)
  ));

drop policy if exists product_assets_member_update on public.product_assets;
create policy product_assets_member_update on public.product_assets
  for update using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

drop policy if exists product_assets_member_delete on public.product_assets;
create policy product_assets_member_delete on public.product_assets
  for delete using (public.is_store_member(store_id));

-- Applications: the form is open to the public, the queue is not.
drop policy if exists store_applications_public_insert on public.store_applications;
create policy store_applications_public_insert on public.store_applications
  for insert with check (status = 'pending');

-- No select/update/delete policy exists on purpose: only service_role (which
-- bypasses RLS) can read or decide applications.

-- ------------------------------------------------------------- catalogue ----
-- The shape the front-end consumes. security_invoker keeps the caller's RLS,
-- so this view can never leak a draft.

create or replace view public.catalog
with (security_invoker = true) as
  select
    p.id,
    p.slug,
    p.name,
    p.store_id,
    s.slug        as store_slug,
    s.name        as store_name,
    s.address     as store_address,
    s.contact_number as store_contact_number,
    s.hours       as store_hours,
    p.category,
    p.style,
    p.color,
    p.price_php,
    p.stock,
    p.width_cm,
    p.height_cm,
    p.depth_cm,
    coalesce(p.bounds_width_cm,  p.width_cm)  as bounds_width_cm,
    coalesce(p.bounds_height_cm, p.height_cm) as bounds_height_cm,
    coalesce(p.bounds_depth_cm,  p.depth_cm)  as bounds_depth_cm,
    p.preview_shape,
    p.description,
    p.ar_ready,
    p.featured,
    p.updated_at,
    (select a.object_path from public.product_assets a
       where a.product_id = p.id and a.kind = 'glb')  as model_glb_path,
    (select a.object_path from public.product_assets a
       where a.product_id = p.id and a.kind = 'usdz') as model_usdz_path
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.status = 'published' and s.status = 'active';

-- ----------------------------------------------------------------- grants ---

grant usage on schema public to anon, authenticated;
grant select on public.stores, public.products, public.product_assets, public.catalog to anon, authenticated;
grant select on public.store_members to authenticated;
grant insert, update, delete on public.products, public.product_assets to authenticated;
grant update on public.stores to authenticated;
grant insert on public.store_applications to anon, authenticated;

-- ============================================================================
-- Storage
--
-- Create the bucket first (Dashboard → Storage → New bucket, or the snippet
-- below). Public read so <model-viewer>/three.js can fetch a .glb without a
-- signed URL; writes restricted to the owning store's folder.
--
-- Object paths are always:  <store_id>/<product_id>/<file>
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'furniture-models', 'furniture-models', true, 52428800,   -- 50 MB
  array['model/gltf-binary', 'model/vnd.usdz+zip', 'image/png', 'image/jpeg', 'application/octet-stream']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "furniture models are publicly readable" on storage.objects;
create policy "furniture models are publicly readable" on storage.objects
  for select using (bucket_id = 'furniture-models');

-- The first folder in the path must be a store the user belongs to.
drop policy if exists "store members upload their own models" on storage.objects;
create policy "store members upload their own models" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'furniture-models'
    and public.is_store_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "store members replace their own models" on storage.objects;
create policy "store members replace their own models" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'furniture-models'
    and public.is_store_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "store members delete their own models" on storage.objects;
create policy "store members delete their own models" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'furniture-models'
    and public.is_store_member(((storage.foldername(name))[1])::uuid)
  );
