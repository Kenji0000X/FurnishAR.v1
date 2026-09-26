-- ===========================================================================
-- 0014 — When was this product's model uploaded? (for the catalogue card)
--
-- The collection shows a product as a real card only when a shopper can see
-- its model: its poster exists, or the model was uploaded moments ago and
-- the owner's browser is still rendering and uploading the poster
-- ("Preparing preview…"). A model that has had no poster for longer than
-- that — uploaded before posters existed, or its poster failed — is not
-- presented to shoppers until the shop regenerates it (app/model-state.js).
--
-- Telling "moments ago" from "months ago" needs the model's upload time,
-- which the catalogue did not expose. It is appended here as the view's last
-- column (create or replace view can only add columns at the end). It is the
-- asset's created_at, which 0012's guard resets on every re-upload.
-- ===========================================================================

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
       where a.product_id = p.id and a.kind = 'poster' and a.bucket = 'product-posters') as poster_path,
    (select a.created_at from public.product_assets a
       where a.product_id = p.id and a.kind = 'glb') as model_uploaded_at
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.status = 'published' and s.status = 'active';

grant select on public.catalog to anon, authenticated;
