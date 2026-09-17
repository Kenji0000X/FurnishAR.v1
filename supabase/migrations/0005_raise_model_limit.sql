-- ===========================================================================
-- Raising the per-file model limit from 50 MB to 100 MB.
--
-- This changes ONE number, on purpose, rather than touching how uploads work.
-- The upload path was already built to scale before this was asked for:
--
--   - Files go straight from the browser to Storage with a one-time signed
--     URL (lib/supabase-proxy.js createSignedUpload). The bytes never pass
--     through this app's serverless function — which caps a request body at
--     4.5 MB on Vercel, far below even the old 50 MB limit — and they never
--     touch Postgres. A bigger file does not mean a bigger load on the app
--     or the database; it only takes longer in the owner's own browser.
--   - Fifty owners uploading fifty models is fifty independent uploads
--     straight to object storage, which is what it is built for. There is no
--     shared lock, no queue, and no table this contends on: product_assets
--     has one row per file, and a hundred more of them changes nothing about
--     how fast any one query runs.
--
-- What a bigger cap changes is real and worth saying plainly, not just
-- raising the number and moving on:
--
--   1. Storage cost and quota. Fifty stores each uploading fifty 100 MB
--      models is up to 250 GB — far past a free-tier project's storage
--      allowance. This migration does not, and cannot, change your plan's
--      quota; watch Settings -> Usage, and see the storage_usage view added
--      below for a per-store breakdown from inside the database.
--   2. Time on a slow connection. A 100 MB upload will take several minutes
--      on the mobile connections this app is built for. The portal now shows
--      real progress instead of a static "Uploading..." (see public/supabase.js
--      and app/portal/ProductFormDialog.js), so a slow upload reads as
--      "working", not "frozen" — but it is still slow, and that is physics,
--      not a database problem.
-- ===========================================================================

update storage.buckets
   set file_size_limit = 104857600  -- 100 MB
 where id = 'furniture-models';

-- A fresh project that runs 0005 before ever running 0001 would find no row
-- to update above; that is not this migration's job to fix; run 0001 first.
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'furniture-models') then
    raise exception 'storage.buckets has no furniture-models row: run supabase/migrations/0001_init.sql first';
  end if;
end $$;

-- ------------------------------------------------------ storage_usage view --
-- Bytes uploaded per store, so a bigger per-file cap does not turn into a
-- surprise quota bill with no way to see it coming. Admin-only, the same way
-- 0004 made products and product_assets admin-readable: a security-definer
-- function rather than a policy on storage.objects, because that table is
-- owned by the storage extension and this project does not manage its RLS.
create or replace function public.storage_usage()
returns table (store_id uuid, store_name text, store_slug text, file_count bigint, total_bytes bigint)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  -- Refuses outright rather than answering with zero rows. An empty result
  -- from a totals query reads as "nothing uploaded yet", not "you may not
  -- ask" — the same distinction applicant_account() draws in 0002, and for
  -- the same reason: RLS's usual "no rows" is right for a table a caller
  -- might legitimately see nothing in, and wrong for a question this bluntly
  -- either theirs to ask or not.
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may view storage usage'
      using errcode = '42501';
  end if;

  -- stores.slug is citext (case-insensitive) and sum(bigint) is numeric —
  -- neither matches this function's declared return type without a cast.
  return query
    select s.id, s.name, s.slug::text, count(pa.id), coalesce(sum(pa.byte_size), 0)::bigint
      from public.stores s
      left join public.product_assets pa on pa.store_id = s.id
     group by s.id, s.name, s.slug
     order by coalesce(sum(pa.byte_size), 0) desc;
end;
$$;

revoke all on function public.storage_usage() from public, anon;
grant execute on function public.storage_usage() to authenticated;

-- A useful index the moment there is more than a handful of files to sort
-- through — cheap now, and the query the admin console already runs
-- (order by created_at desc) is exactly what it serves.
create index if not exists product_assets_created_idx on public.product_assets (created_at desc);
