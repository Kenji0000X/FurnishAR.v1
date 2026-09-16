-- ===========================================================================
-- Letting the superadmin see what has been uploaded, across every store.
--
-- This is read-only, on purpose. The superadmin vets who gets a store; once a
-- store exists, its models and listings are that owner's to manage — 0001's
-- policies already say so, and nothing here changes that. What was missing is
-- visibility: a way to notice a 400 MB file, a product with no model attached,
-- or an upload nobody remembers, without going shop by shop with database
-- credentials.
--
-- Two additional SELECT policies, added the same way 0003 added the others:
-- RLS combines multiple permissive policies with OR, so these sit alongside
-- products_public_read and product_assets_public_read without touching them.
-- ===========================================================================

drop policy if exists products_admin_read on public.products;
create policy products_admin_read on public.products
  for select using (public.is_platform_admin());

drop policy if exists product_assets_admin_read on public.product_assets;
create policy product_assets_admin_read on public.product_assets
  for select using (public.is_platform_admin());
