-- ===========================================================================
-- 0013 — The owner hears about it before a model can be deleted.
--
-- 0012 made a model deletable by a platform admin once nobody had opened it
-- for 365 days. The shop that uploaded it was never told: a model could go
-- from "fine" to "deleted" without its owner having had any chance to say
-- "we still want that". This closes that gap, in the database, where the
-- 365-day rule already lives.
--
-- THE RULE, NOW
--   1. At 335 idle days (30 days before the year is up), the model is DUE a
--      notice. A daily job (app/api/cron/model-notices) emails the shop's
--      owners and records the time on the model's row: expiry_notice_at.
--   2. A model is ELIGIBLE for cleanup only when ALL of:
--        - it has been idle 365 days (0012's rule, unchanged);
--        - a notice was recorded AFTER its last use (a notice about an
--          earlier idle spell does not count once the model was used again);
--        - that notice is at least 30 days old.
--      So the owner always gets at least 30 days between the email and the
--      first moment an admin could delete — even if the job was down and the
--      notice went out late, eligibility simply moves later.
--   3. No notice, no deletion. A deployment that cannot send email never
--      makes a model deletable; it waits. Nothing is deleted automatically,
--      as before.
--
-- WHAT THE OWNER CAN DO
--   Open the model (any open records use, 0012), or press "Keep this model"
--   in the portal: keep_model() records a use for a model of the caller's own
--   store — exactly what opening it in the portal's preview already did, one
--   click shorter. Either resets the clock, and the old notice stops counting.
--
-- WHO WRITES expiry_notice_at
--   Only server_mark_model_notice(), behind the server's secret. The 0012
--   guard trigger is extended so an owner's upsert can no more forge a
--   notice than a last-access time, and a re-upload clears it (a new file is
--   a new model, with a new clock).
-- ===========================================================================

alter table public.product_assets
  add column if not exists expiry_notice_at timestamptz;

comment on column public.product_assets.expiry_notice_at is
  'When the owners were emailed that this model will become deletable (0013). Counts only if after the last use.';

/* 0012's guard, extended. Two trusted writers, each marking its own
   transaction with a setting PostgREST cannot set:
     furnishar.recording_model_access  — record_model_access / keep_model
     furnishar.recording_model_notice  — server_mark_model_notice
   Every other write is an upload: the clock restarts and the notice goes. */
create or replace function public.guard_asset_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.last_accessed_at := null;
    new.expiry_notice_at := null;
    new.created_at := now();
    return new;
  end if;
  if coalesce(current_setting('furnishar.recording_model_access', true), '') = 'on' then
    new.expiry_notice_at := old.expiry_notice_at;
    return new;
  end if;
  if coalesce(current_setting('furnishar.recording_model_notice', true), '') = 'on' then
    new.last_accessed_at := old.last_accessed_at;
    new.created_at := old.created_at;
    return new;
  end if;
  new.last_accessed_at := old.last_accessed_at;
  new.expiry_notice_at := null;
  new.created_at := now();
  return new;
end $$;

-- ---------------------------------------------------------- the notice ---

create or replace function public.model_notice_lead()
returns interval
language sql
immutable
as $$ select interval '30 days' $$;

/* Due a notice: idle for (365 - 30) days, and not yet told about THIS idle
   spell. */
create or replace function public.model_notice_due(
  p_kind public.asset_kind, p_created timestamptz, p_accessed timestamptz, p_noticed timestamptz
)
returns boolean
language sql
stable
as $$
  select p_kind in ('glb', 'usdz')
     and public.model_last_used(p_created, p_accessed)
           <= now() - (public.model_idle_threshold() - public.model_notice_lead())
     and (p_noticed is null or p_noticed < public.model_last_used(p_created, p_accessed))
$$;

/* The one eligibility rule, now with the notice in it. */
create or replace function public.model_cleanup_eligible(
  p_kind public.asset_kind, p_created timestamptz, p_accessed timestamptz, p_noticed timestamptz
)
returns boolean
language sql
stable
as $$
  select public.model_cleanup_eligible(p_kind, p_created, p_accessed)
     and p_noticed is not null
     and p_noticed >= public.model_last_used(p_created, p_accessed)
     and p_noticed <= now() - public.model_notice_lead()
$$;

/* The earliest day it could become deletable, given what has (or has not)
   been sent: a year after last use, and never sooner than 30 days after the
   notice — or, with no notice yet, 30 days after it would go out. */
create or replace function public.model_deletable_from(
  p_created timestamptz, p_accessed timestamptz, p_noticed timestamptz
)
returns date
language sql
stable
as $$
  select greatest(
    public.model_last_used(p_created, p_accessed) + public.model_idle_threshold(),
    case
      when p_noticed is not null and p_noticed >= public.model_last_used(p_created, p_accessed)
        then p_noticed
      else greatest(now(), public.model_last_used(p_created, p_accessed)
                           + public.model_idle_threshold() - public.model_notice_lead())
    end + public.model_notice_lead()
  )::date
$$;

-- ---------------------------------------- Storage's checks, re-pointed ---

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
       and public.model_cleanup_eligible(a.kind, a.created_at, a.last_accessed_at, a.expiry_notice_at)
  )
$$;

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
                    and public.model_cleanup_eligible(model.kind, model.created_at,
                                                      model.last_accessed_at, model.expiry_notice_at))
         or not exists (select 1 from public.product_assets model
                         where model.product_id = poster.product_id and model.kind = 'glb')
       )
  )
$$;

-- ------------------------------------------------ the admin's list -------

-- The return type grows (notice_sent_at, notice_due), so it is replaced.
drop function if exists public.admin_model_lifecycle(uuid);
create function public.admin_model_lifecycle(p_asset uuid default null)
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
  poster_path text,
  notice_sent_at timestamptz,
  notice_due boolean
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
           public.model_cleanup_eligible(a.kind, a.created_at, a.last_accessed_at, a.expiry_notice_at),
           public.model_deletable_from(a.created_at, a.last_accessed_at, a.expiry_notice_at),
           p.id, p.name, p.slug, p.status::text, s.id, s.name,
           (select pa.object_path from public.product_assets pa
             where pa.product_id = a.product_id and pa.kind = 'poster' and a.kind = 'glb'),
           -- Only a notice about the current idle spell is reported as sent.
           case when a.expiry_notice_at >= public.model_last_used(a.created_at, a.last_accessed_at)
                then a.expiry_notice_at end,
           public.model_notice_due(a.kind, a.created_at, a.last_accessed_at, a.expiry_notice_at)
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

/* 0012's step (b), with the eligibility check now including the notice.
   Otherwise identical: row lock, storage-first, idempotent, audited once. */
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
  if not public.model_cleanup_eligible(asset.kind, asset.created_at, asset.last_accessed_at, asset.expiry_notice_at) then
    raise exception 'This model was used recently, or its owner has not had 30 days since being notified, so it is not eligible for cleanup.'
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
    'owner_notified_at', asset.expiry_notice_at,
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

-- ------------------------------------------------- the notice job --------

/* Models due a notice, for the daily job. Server-only (0011's secret). */
create or replace function public.server_models_due_notice(p_secret text)
returns table (
  asset_id uuid,
  kind public.asset_kind,
  product_id uuid,
  product_name text,
  product_slug text,
  store_id uuid,
  store_name text,
  idle_days integer,
  deletable_from date
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_server(p_secret);
  return query
    select a.id, a.kind, p.id, p.name, p.slug, s.id, s.name,
           floor(extract(epoch from now() - public.model_last_used(a.created_at, a.last_accessed_at)) / 86400)::int,
           -- As it will be once this notice is recorded today.
           greatest(public.model_last_used(a.created_at, a.last_accessed_at) + public.model_idle_threshold(),
                    now() + public.model_notice_lead())::date
      from public.product_assets a
      join public.products p on p.id = a.product_id
      join public.stores s on s.id = a.store_id
     where a.bucket = 'furniture-models'
       and public.model_notice_due(a.kind, a.created_at, a.last_accessed_at, a.expiry_notice_at)
     order by s.id, p.name;
end $$;

/* Records that the owners were told. Only after an email actually went. */
create or replace function public.server_mark_model_notice(p_secret text, p_asset uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  touched int;
begin
  perform public.assert_server(p_secret);
  perform set_config('furnishar.recording_model_notice', 'on', true);
  update public.product_assets a
     set expiry_notice_at = now()
   where a.id = p_asset
     and public.model_notice_due(a.kind, a.created_at, a.last_accessed_at, a.expiry_notice_at);
  get diagnostics touched = row_count;
  perform set_config('furnishar.recording_model_notice', '', true);
  return touched > 0;
end $$;

-- --------------------------------------------- the owner's side ----------

/* The shop's own models and where each stands, for the portal. The same
   functions as the admin's list, so the two can never disagree. */
create or replace function public.store_model_lifecycle(p_store uuid)
returns table (
  asset_id uuid,
  kind public.asset_kind,
  product_id uuid,
  last_used_at timestamptz,
  idle_days integer,
  notice_sent_at timestamptz,
  at_risk boolean,
  eligible boolean,
  deletable_from date
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_store_member(p_store) or public.is_platform_admin()) then
    raise exception 'Only this store''s members can see its models.' using errcode = '42501';
  end if;
  return query
    select a.id, a.kind, a.product_id,
           public.model_last_used(a.created_at, a.last_accessed_at),
           floor(extract(epoch from now() - public.model_last_used(a.created_at, a.last_accessed_at)) / 86400)::int,
           case when a.expiry_notice_at >= public.model_last_used(a.created_at, a.last_accessed_at)
                then a.expiry_notice_at end,
           public.model_last_used(a.created_at, a.last_accessed_at)
             <= now() - (public.model_idle_threshold() - public.model_notice_lead()),
           public.model_cleanup_eligible(a.kind, a.created_at, a.last_accessed_at, a.expiry_notice_at),
           public.model_deletable_from(a.created_at, a.last_accessed_at, a.expiry_notice_at)
      from public.product_assets a
     where a.store_id = p_store
       and a.bucket = 'furniture-models'
       and a.kind in ('glb', 'usdz');
end $$;

/* "Keep this model": a use, recorded by the shop that owns it. Grants nothing
   an owner could not already do by opening the model in the portal's own
   preview (record_model_access accepts the owner, 0012) — it is that, without
   the download. Not throttled to once a day: pressing it should visibly work. */
create or replace function public.keep_model(p_asset uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  asset public.product_assets%rowtype;
begin
  select * into asset from public.product_assets where id = p_asset;
  if not found or asset.kind not in ('glb', 'usdz') or asset.bucket <> 'furniture-models' then
    raise exception 'That 3D model no longer exists.' using errcode = 'P0002';
  end if;
  if auth.uid() is null or not public.is_store_member(asset.store_id) then
    raise exception 'Only this store''s members can keep its models.' using errcode = '42501';
  end if;
  perform set_config('furnishar.recording_model_access', 'on', true);
  update public.product_assets set last_accessed_at = now() where id = p_asset;
  perform set_config('furnishar.recording_model_access', '', true);
  return jsonb_build_object('status', 'kept', 'deletable_from',
    (now() + public.model_idle_threshold())::date);
end $$;

-- ---------------------------------------------------------- grants -------

revoke all on function public.store_model_lifecycle(uuid) from public, anon;
grant execute on function public.store_model_lifecycle(uuid) to authenticated;
revoke all on function public.keep_model(uuid) from public, anon;
grant execute on function public.keep_model(uuid) to authenticated;

-- Server-only, like 0011's: the secret is the authorization; the cron job has
-- no user session, so anon may call and is refused without the secret.
revoke all on function public.server_models_due_notice(text) from public;
grant execute on function public.server_models_due_notice(text) to anon, authenticated;
revoke all on function public.server_mark_model_notice(text, uuid) from public;
grant execute on function public.server_mark_model_notice(text, uuid) to anon, authenticated;
