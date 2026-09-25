-- ===========================================================================
-- 0012  Catalogue posters and the 3D model lifecycle.
--
-- 1. POSTERS. Every uploaded .glb gets a small WebP render of itself, made in
--    the owner's browser from the model it just checked (ModelPreview), and
--    stored in a PUBLIC bucket so a catalogue card is one cached image rather
--    than a signed request and a multi-megabyte model per card. The models
--    stay in the PRIVATE furniture-models bucket (0007); nothing here changes
--    who may open a model.
--
--       product-posters   public read, 1 MB, images only. Paths are
--                         <store_id>/<product_id>/poster-<content hash>.webp:
--                         content-addressed, so a poster is immutable and can
--                         be cached for a year, and a new model gets a new
--                         name instead of a stale cached picture. Only the
--                         store's own members may write under their folder.
--       product_assets    kind = 'poster', bucket = 'product-posters' — the
--                         asset_kind value 0001 already reserved for this.
--
-- 2. LIFECYCLE. A model may be deleted by a platform admin once it has gone
--    UNUSED for 365 days. Never automatically, and never on age alone: a
--    model uploaded two years ago and opened yesterday is active.
--
--       last_accessed_at  set when FurnishAR grants a signed URL for the
--                         file (lib/supabase-proxy.js → record_model_access),
--                         at most once per asset per day. Nothing else: not a
--                         poster load, not a product page view, not a refused
--                         or failed request. No user id, no count, no
--                         location — only when the file was last opened.
--
--       last used         model_last_used(): the later of the upload time
--                         and the last access. A model never opened since
--                         upload is measured from its upload; a replaced
--                         model starts again (created_at is reset on
--                         re-upload by the trigger below).
--
--       eligible          model_cleanup_eligible(): a glb/usdz whose last
--                         use is at least model_idle_threshold() (365 days)
--                         ago. This is the ONE place the rule lives; the
--                         console displays what admin_model_lifecycle()
--                         returns and never computes it.
--
--    Deletion is two steps, both as the admin's own session (no secret key):
--      a. the Storage API deletes the objects — the storage policies below
--         let an admin delete a model object, and its poster, only while the
--         model is eligible, so eligibility is re-checked by the database at
--         the moment of deletion;
--      b. admin_delete_stale_model() removes the metadata, refusing while the
--         file still exists, re-checking eligibility under a row lock, and
--         writing the audit row in the same transaction.
--    Retrying after any interruption finishes the job: a missing file is not
--    an error for (a), and (b) is what makes the state consistent.
-- ===========================================================================

-- ------------------------------------------------------ usage tracking ----

alter table public.product_assets
  add column if not exists last_accessed_at timestamptz;

comment on column public.product_assets.last_accessed_at is
  'When FurnishAR last granted access to this model file (at most daily). Null = never since upload.';

/*
  Who may write the lifecycle columns: nobody but record_model_access().

  An owner writes asset rows (the upload's upsert), and a PostgREST upsert
  can carry any column. Without this an owner could backdate created_at or
  forge last_accessed_at — to keep a model "in use" forever, or to make one
  look abandoned. So on every write that is not the access recorder:
    - last_accessed_at keeps its stored value (null on insert);
    - created_at becomes now(): any other write to an asset row IS an upload
      or a replacement, and a replaced model is a new model.
  The recorder marks its own transaction with a setting PostgREST cannot set.
*/
create or replace function public.guard_asset_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.last_accessed_at := null;
    new.created_at := now();
    return new;
  end if;
  if coalesce(current_setting('furnishar.recording_model_access', true), '') = 'on' then
    return new;
  end if;
  new.last_accessed_at := old.last_accessed_at;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists product_assets_lifecycle on public.product_assets;
create trigger product_assets_lifecycle before insert or update on public.product_assets
  for each row execute function public.guard_asset_lifecycle();

-- --------------------------------------------------- the lifecycle rule ---

create or replace function public.model_idle_threshold()
returns interval
language sql
immutable
as $$ select interval '365 days' $$;

create or replace function public.model_last_used(p_created timestamptz, p_accessed timestamptz)
returns timestamptz
language sql
immutable
as $$ select greatest(p_created, coalesce(p_accessed, p_created)) $$;

create or replace function public.model_cleanup_eligible(
  p_kind public.asset_kind, p_created timestamptz, p_accessed timestamptz
)
returns boolean
language sql
stable
as $$
  select p_kind in ('glb', 'usdz')
     and public.model_last_used(p_created, p_accessed) <= now() - public.model_idle_threshold()
$$;

-- ------------------------------------------------- recording an access ----

/*
  Called by the server right after Storage has signed a model URL for this
  caller (lib/supabase-proxy.js grantModelAccess), with the caller's own
  token. can_view_model() — the storage policy's own function — is checked
  again here, so this can only ever mark a file the caller may open, which is
  exactly the set whose use it is meant to record. Called directly it can do
  nothing a real open would not.

  Throttled: an asset already marked in the last day is not written again,
  so a shopper walking around a sofa in AR costs one write, not thousands.
*/
create or replace function public.record_model_access(p_object_path text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  touched int;
begin
  if auth.uid() is null or p_object_path is null or not public.can_view_model(p_object_path) then
    return false;
  end if;
  perform set_config('furnishar.recording_model_access', 'on', true);
  update public.product_assets
     set last_accessed_at = now()
   where bucket = 'furniture-models'
     and object_path = p_object_path
     and kind in ('glb', 'usdz')
     and (last_accessed_at is null or last_accessed_at < now() - interval '1 day');
  get diagnostics touched = row_count;
  perform set_config('furnishar.recording_model_access', '', true);
  return touched > 0;
end $$;

revoke all on function public.record_model_access(text) from public, anon;
grant execute on function public.record_model_access(text) to authenticated;

-- ------------------------------------------------------------- posters ----

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-posters', 'product-posters', true, 1048576,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/* Reading a poster needs no policy: the bucket is public, so its public URL
   serves the file to anyone. This policy is about the Storage API's own
   reads — listing a folder, and the row check behind every upsert and
   delete — and is limited to the store's own members and admins, so nobody
   can list the bucket to discover the ids of another shop's drafts. */
drop policy if exists "store members and admins see poster objects" on storage.objects;
create policy "store members and admins see poster objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'product-posters' and (
      public.is_platform_admin()
      or (
        (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and public.is_store_member(((storage.foldername(name))[1])::uuid)
      )
    )
  );

drop policy if exists "store members upload their own posters" on storage.objects;
create policy "store members upload their own posters" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-posters'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_store_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "store members replace their own posters" on storage.objects;
create policy "store members replace their own posters" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'product-posters'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_store_member(((storage.foldername(name))[1])::uuid)
  );

/* The catalogue's one image per product: the poster's path, for the card. */
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
       where a.product_id = p.id and a.kind = 'usdz') as model_usdz_path,
    s.fulfilment  as store_fulfilment,
    public.store_accepts_payments(s.id) as store_payments_ready,
    (select a.object_path from public.product_assets a
       where a.product_id = p.id and a.kind = 'poster' and a.bucket = 'product-posters') as poster_path
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.status = 'published' and s.status = 'active';

grant select on public.catalog to anon, authenticated;

-- --------------------------------------------------------- admin cleanup ---

/* May an admin delete this model object right now? Asked by Storage at the
   moment of deletion, so a model opened a second ago is refused. */
create or replace function public.model_cleanup_allowed(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin() and exists (
    select 1 from public.product_assets a
     where a.bucket = 'furniture-models'
       and a.object_path = object_name
       and public.model_cleanup_eligible(a.kind, a.created_at, a.last_accessed_at)
  )
$$;

/* A poster is a render of its product's .glb. It goes with that model: while
   the model is eligible, or once the model's row is already gone (a cleanup
   that was interrupted half way and is being finished). */
create or replace function public.poster_cleanup_allowed(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin() and exists (
    select 1 from public.product_assets poster
     where poster.bucket = 'product-posters'
       and poster.kind = 'poster'
       and poster.object_path = object_name
       and (
         exists (select 1 from public.product_assets model
                  where model.product_id = poster.product_id and model.kind = 'glb'
                    and public.model_cleanup_eligible(model.kind, model.created_at, model.last_accessed_at))
         or not exists (select 1 from public.product_assets model
                         where model.product_id = poster.product_id and model.kind = 'glb')
       )
  )
$$;

revoke all on function public.model_cleanup_allowed(text) from public, anon;
revoke all on function public.poster_cleanup_allowed(text) from public, anon;
grant execute on function public.model_cleanup_allowed(text) to authenticated;
grant execute on function public.poster_cleanup_allowed(text) to authenticated;

-- Owners delete their own old posters; an admin only a poster whose model is
-- being cleaned up (see poster_cleanup_allowed below).
drop policy if exists "poster deletes" on storage.objects;
create policy "poster deletes" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'product-posters' and (
      (
        (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and public.is_store_member(((storage.foldername(name))[1])::uuid)
      )
      or (public.is_platform_admin() and public.poster_cleanup_allowed(name))
    )
  );

drop policy if exists "admins delete stale models" on storage.objects;
create policy "admins delete stale models" on storage.objects
  for delete to authenticated
  using (bucket_id = 'furniture-models' and public.model_cleanup_allowed(name));

/*
  Every model file with its lifecycle, as the console shows it. The admin's
  screen displays these values; it does not work any of them out.
  p_asset narrows it to one row, for the cleanup's own fresh re-read.
*/
create or replace function public.admin_model_lifecycle(p_asset uuid default null)
returns table (
  asset_id uuid,
  kind public.asset_kind,
  object_path text,
  byte_size bigint,
  uploaded_at timestamptz,
  last_accessed_at timestamptz,
  last_used_at timestamptz,
  idle_days integer,
  eligible boolean,
  eligible_on date,
  product_id uuid,
  product_name text,
  product_slug text,
  product_status text,
  store_id uuid,
  store_name text,
  poster_path text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may review model files.' using errcode = '42501';
  end if;
  return query
    select a.id, a.kind, a.object_path, a.byte_size, a.created_at, a.last_accessed_at,
           public.model_last_used(a.created_at, a.last_accessed_at),
           floor(extract(epoch from now() - public.model_last_used(a.created_at, a.last_accessed_at)) / 86400)::int,
           public.model_cleanup_eligible(a.kind, a.created_at, a.last_accessed_at),
           (public.model_last_used(a.created_at, a.last_accessed_at) + public.model_idle_threshold())::date,
           p.id, p.name, p.slug, p.status::text, s.id, s.name,
           (select pa.object_path from public.product_assets pa
             where pa.product_id = a.product_id and pa.kind = 'poster' and a.kind = 'glb')
      from public.product_assets a
      join public.products p on p.id = a.product_id
      join public.stores s on s.id = a.store_id
     where a.kind in ('glb', 'usdz')
       and a.bucket = 'furniture-models'
       and (p_asset is null or a.id = p_asset)
     order by public.model_last_used(a.created_at, a.last_accessed_at) asc;
end $$;

revoke all on function public.admin_model_lifecycle(uuid) from public, anon;
grant execute on function public.admin_model_lifecycle(uuid) to authenticated;

/*
  Step (b): the metadata, after Storage has deleted the file(s).

  Re-checks everything the browser could have been wrong about — admin, a
  model asset, still eligible (under a row lock, so an access being recorded
  right now either lands first and refuses this, or waits) — and refuses
  while the model or its poster file is still in Storage, so a row is never
  removed from under a file that would then be orphaned.

  Deletes the model row and its poster row only. Never the product, its
  dimensions, its orders or its store: the listing stays, without AR.

  Idempotent: an asset that is already gone answers 'gone' and audits
  nothing, so a retried request cannot write a second audit row.
*/
create or replace function public.admin_delete_stale_model(p_asset uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth, storage
as $$
declare
  asset public.product_assets%rowtype;
  poster public.product_assets%rowtype;
  product_row public.products%rowtype;
  last_used timestamptz;
  actor_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may delete model files.' using errcode = '42501';
  end if;

  select * into asset from public.product_assets where id = p_asset for update;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  if asset.kind not in ('glb', 'usdz') or asset.bucket <> 'furniture-models' then
    raise exception 'Only 3D model files can be cleaned up here.' using errcode = '22023';
  end if;
  if not public.model_cleanup_eligible(asset.kind, asset.created_at, asset.last_accessed_at) then
    raise exception 'This model was used recently and is no longer eligible for cleanup.'
      using errcode = 'P0001', hint = 'not_eligible';
  end if;
  if exists (select 1 from storage.objects o
              where o.bucket_id = asset.bucket and o.name = asset.object_path) then
    raise exception 'The model file is still in storage; delete it first.' using errcode = 'P0001', hint = 'storage_pending';
  end if;

  if asset.kind = 'glb' then
    select * into poster from public.product_assets
     where product_id = asset.product_id and kind = 'poster' for update;
    if found and exists (select 1 from storage.objects o
                          where o.bucket_id = poster.bucket and o.name = poster.object_path) then
      raise exception 'The preview image is still in storage; delete it first.' using errcode = 'P0001', hint = 'storage_pending';
    end if;
  end if;

  select * into product_row from public.products where id = asset.product_id;
  last_used := public.model_last_used(asset.created_at, asset.last_accessed_at);
  select email into actor_email from auth.users where id = auth.uid();

  if poster.id is not null then
    delete from public.product_assets where id = poster.id;
  end if;
  delete from public.product_assets where id = asset.id;

  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, 'model.deleted_stale', asset.id, jsonb_build_object(
    'asset_id', asset.id,
    'kind', asset.kind,
    'product_id', asset.product_id,
    'product_name', product_row.name,
    'product_status', product_row.status,
    'store_id', asset.store_id,
    'object_path', asset.object_path,
    'byte_size', asset.byte_size,
    'uploaded_at', asset.created_at,
    'last_accessed_at', asset.last_accessed_at,
    'idle_days', floor(extract(epoch from now() - last_used) / 86400)::int,
    'poster_removed', poster.id is not null
  ));

  return jsonb_build_object(
    'status', 'deleted',
    'product_id', asset.product_id,
    'byte_size', asset.byte_size,
    'poster_removed', poster.id is not null
  );
end $$;

revoke all on function public.admin_delete_stale_model(uuid) from public, anon;
grant execute on function public.admin_delete_stale_model(uuid) to authenticated;
