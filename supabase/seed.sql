-- ============================================================================
-- FurnishAR — seed data
--
-- Safe to run more than once. Creates the three pilot shops and the furniture
-- currently in data/catalog.json so the live catalogue is not empty on day one.
--
-- It deliberately does NOT create users or memberships. Owners sign themselves
-- up through the portal; an admin then links the account to its store with the
-- snippet at the bottom of this file.
-- ============================================================================

insert into public.stores (slug, name, address, contact_number, hours, plan)
values
  ('sc-variety', 'S&C Variety Store',
   '123 Main Street, Mamburao, Occidental Mindoro (PLACEHOLDER - UPDATE BEFORE LAUNCH)',
   '+63 (0)43-288-1234', 'Mon-Sun: 8:00 AM - 6:00 PM', 'premium'),
  ('tiampion', 'Tiampion Buildings',
   '456 Commerce Avenue, Mamburao, Occidental Mindoro (PLACEHOLDER - UPDATE BEFORE LAUNCH)',
   '+63 (0)43-288-5678', 'Mon-Sat: 9:00 AM - 5:00 PM', 'freemium'),
  ('sanros', 'Sanros General Merchandise',
   '789 Market Place, Mamburao, Occidental Mindoro (PLACEHOLDER - UPDATE BEFORE LAUNCH)',
   '+63 (0)43-288-9999', 'Mon-Sun: 7:00 AM - 8:00 PM', 'premium')
on conflict (slug) do update
  set name = excluded.name,
      address = excluded.address,
      contact_number = excluded.contact_number,
      hours = excluded.hours,
      plan = excluded.plan;

-- The one piece currently in the catalogue. Its .glb is uploaded through the
-- owner portal, which writes the matching public.product_assets row.
insert into public.products (
  store_id, slug, name, category, style, color,
  price_php, stock, width_cm, height_cm, depth_cm,
  bounds_width_cm, bounds_height_cm, bounds_depth_cm,
  preview_shape, description, ar_ready, featured, status
)
select
  s.id, 'cane-back-armchair', 'Cane Back Armchair', 'Chair', 'Contemporary', 'Natural',
  9850, 5, 70, 88, 78,
  70, 88, 78,
  'chair',
  'Woven cane back armchair with a solid frame and cushioned seat, scanned as a real 3D model for true-to-scale AR placement.',
  true, true, 'published'
from public.stores s
where s.slug = 'sc-variety'
on conflict (store_id, slug) do nothing;

-- ----------------------------------------------------------------------------
-- Linking an owner to a store (admin step, run as service_role)
--
-- After the person signs up through the portal, grant them their shop:
--
--   insert into public.store_members (store_id, user_id, role)
--   select s.id, u.id, 'owner'
--   from public.stores s, auth.users u
--   where s.slug = 'sc-variety' and u.email = 'owner@furnishar.ph'
--   on conflict do nothing;
--
-- Approving a pending application, and recording which store it became:
--
--   update public.store_applications
--      set status = 'approved', reviewed_at = now(), approved_store_id = :store_id
--    where id = :application_id;
-- ----------------------------------------------------------------------------
