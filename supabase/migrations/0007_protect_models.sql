-- ===========================================================================
-- 3D models are no longer public files.
--
-- Until now the furniture-models bucket was public, and its read policy was
-- `using (bucket_id = 'furniture-models')` — true for everyone, signed in or
-- not. The planner hid its camera behind a sign-in check, but that check ran
-- in the browser, and every model's URL was already in the page source of
-- the catalogue and of each product page. Anyone could download any shop's
-- scanned furniture, drafts included, without an account. A hidden button is
-- not a permission.
--
-- After this:
--
--   AUTHENTICATION  decides who you are. A signed-out visitor gets nothing
--                   from this bucket at all — the policy below is granted to
--                   `authenticated` only, and the bucket is not public.
--
--   AUTHORIZATION   decides what you may open, per file, in can_view_model():
--
--     - anyone signed in     the model of a PUBLISHED product of an ACTIVE
--                            store — i.e. the furniture the catalogue shows;
--     - a store's members    their own store's files, drafts included, so a
--                            shop can check an upload before publishing it;
--     - a platform admin     everything, for the console's review of uploads.
--
--   Signed in is necessary and not sufficient: a shopper cannot open a
--   draft, and one shop cannot open another shop's unpublished work.
--
-- HOW A BROWSER GETS A FILE NOW
-- It asks /api/sb/model/<path> with its access token. The server confirms the
-- session with GoTrue (so a signed-out token is refused even before it
-- expires), then asks Storage to sign the object AS THAT USER. Storage runs
-- the policy below; if it allows, it returns a URL that works for five
-- minutes. The secret key is never involved: the decision is the database's,
-- made on the user's own identity, exactly like every other read in this app.
--
-- A refused object and a missing object look the same from outside, on
-- purpose. Saying "that draft exists but is not yours" would tell a stranger
-- what a shop is working on.
-- ===========================================================================

update storage.buckets set public = false where id = 'furniture-models';

drop policy if exists "furniture models are publicly readable" on storage.objects;

/*
  Paths are <store_id>/<product_id>/<file>. The first folder is cast to a
  uuid only after checking it looks like one: a cast that throws inside a
  policy aborts the whole query with an error instead of answering "no".
*/
create or replace function public.can_view_model(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, storage
as $$
  select auth.uid() is not null and (
    public.is_platform_admin()
    or (
      (storage.foldername(object_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and public.is_store_member(((storage.foldername(object_name))[1])::uuid)
    )
    or exists (
      select 1
      from public.product_assets a
      join public.products p on p.id = a.product_id
      join public.stores s on s.id = a.store_id
      where a.bucket = 'furniture-models'
        and a.object_path = object_name
        and p.status = 'published'
        and s.status = 'active'
    )
  );
$$;

revoke all on function public.can_view_model(text) from public;
grant execute on function public.can_view_model(text) to authenticated, service_role;

drop policy if exists "signed-in viewers read the models they may see" on storage.objects;
create policy "signed-in viewers read the models they may see" on storage.objects
  for select to authenticated
  using (bucket_id = 'furniture-models' and public.can_view_model(name));

/* The lookup above runs on every signed request. */
create index if not exists product_assets_object_path_idx
  on public.product_assets (bucket, object_path);
