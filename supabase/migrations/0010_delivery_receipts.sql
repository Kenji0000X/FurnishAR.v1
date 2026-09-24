-- ===========================================================================
-- Delivery, pickup, estimated arrival and receipts.            DFD: P10 / D5
--
-- A buyer now says HOW they get the piece when they order:
--   delivery   to an address in Occidental Mindoro (free), or
--   pickup     at the shop.
-- Each shop says how many days each takes. When an order is paid (or a
-- custom build's deposit is), the database stamps an estimated arrival date:
-- today + the shop's days, + the quoted lead time for a custom build. The
-- shop then moves the order along — preparing → out for delivery / ready for
-- pickup → delivered — and each step is emailed to the buyer.
--
-- The same rules as 0009 hold: the browser supplies the buyer's own contact
-- details and a choice; every date and every status change is decided here.
-- ===========================================================================

-- ------------------------------------------------------ shop's timings ---

alter table public.store_payout
  add column if not exists delivery_days integer not null default 3 check (delivery_days between 1 and 60),
  add column if not exists pickup_days   integer not null default 1 check (pickup_days between 0 and 60);

-- --------------------------------------------------- order fulfilment ---

alter table public.orders
  add column if not exists fulfilment_method     text check (fulfilment_method in ('delivery', 'pickup')),
  add column if not exists delivery_address      text check (length(delivery_address) <= 300),
  add column if not exists delivery_municipality text check (length(delivery_municipality) <= 80),
  add column if not exists delivery_phone        text check (length(delivery_phone) <= 30),
  add column if not exists delivery_notes        text check (length(delivery_notes) <= 300),
  add column if not exists estimated_arrival     date,
  add column if not exists delivery_status       text check (delivery_status in
                             ('preparing', 'out_for_delivery', 'ready_for_pickup', 'delivered')),
  add column if not exists delivered_at          timestamptz;

/* The buyer's delivery choice, checked once for both kinds of order. */
create or replace function public.check_delivery(
  p_method text, p_address text, p_municipality text, p_phone text
) returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if p_method is null or p_method not in ('delivery', 'pickup') then
    raise exception 'Choose delivery or store pickup.' using errcode = 'check_violation';
  end if;
  if p_phone is null or btrim(p_phone) !~ '^[0-9+() -]{7,20}$' then
    raise exception 'Enter a mobile number the shop can call, e.g. 0917 123 4567.' using errcode = 'check_violation';
  end if;
  if p_method = 'delivery' then
    if p_address is null or length(btrim(p_address)) < 5 then
      raise exception 'Enter the delivery address: house, street and barangay.' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.municipalities m where m.name = p_municipality) then
      raise exception 'Choose a municipality in Occidental Mindoro for delivery.' using errcode = 'check_violation';
    end if;
  end if;
end;
$$;

revoke all on function public.check_delivery(text, text, text, text) from public, anon, authenticated;

-- ------------------------------------------ the arrival date, stamped ---
-- A trigger rather than a change inside record_capture(), so every path that
-- marks an order paid — now or later — gets a date the same way.

create or replace function public.stamp_delivery_eta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  days integer;
begin
  if new.status in ('paid', 'deposit_paid') and old.status is distinct from new.status then
    if new.delivery_status is null then
      new.delivery_status := 'preparing';
    end if;
    if new.estimated_arrival is null then
      select case when new.fulfilment_method = 'pickup' then po.pickup_days else po.delivery_days end
        into days from public.store_payout po where po.store_id = new.store_id;
      new.estimated_arrival := (now() at time zone 'Asia/Manila')::date
        + coalesce(days, case when new.fulfilment_method = 'pickup' then 1 else 3 end)
        + case when new.kind = 'custom' then coalesce(new.lead_time_days, 0) else 0 end;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_delivery_eta() from public, anon, authenticated;

drop trigger if exists orders_delivery_eta on public.orders;
create trigger orders_delivery_eta before update on public.orders
  for each row execute function public.stamp_delivery_eta();

-- ------------------------------------------------- store settings -------

drop function if exists public.save_store_billing(uuid, public.store_fulfilment, text, text);

create or replace function public.save_store_billing(
  p_store uuid, p_fulfilment public.store_fulfilment, p_paypal_email text, p_notify_email text,
  p_delivery_days integer, p_pickup_days integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_store_member(p_store) then
    raise exception 'Only this store''s owner can change its billing.' using errcode = '42501';
  end if;
  if coalesce(p_delivery_days, 0) not between 1 and 60 or coalesce(p_pickup_days, -1) not between 0 and 60 then
    raise exception 'Delivery takes 1 to 60 days and pickup 0 to 60.' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.orders
     where store_id = p_store
       and status in ('pending_payment', 'requested', 'quoted', 'deposit_paid', 'balance_due')
  ) and (select fulfilment from public.stores where id = p_store) <> p_fulfilment then
    raise exception 'Finish or cancel the open orders before changing the store type.'
      using errcode = 'check_violation';
  end if;

  update public.stores set fulfilment = p_fulfilment where id = p_store;

  insert into public.store_payout (store_id, paypal_email, notify_email, delivery_days, pickup_days, updated_at)
  values (p_store, nullif(lower(btrim(p_paypal_email)), ''), nullif(lower(btrim(p_notify_email)), ''),
          p_delivery_days, p_pickup_days, now())
  on conflict (store_id) do update
    set paypal_email = excluded.paypal_email,
        notify_email = excluded.notify_email,
        delivery_days = excluded.delivery_days,
        pickup_days = excluded.pickup_days,
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- ------------------------------------------------ ordering, with delivery --
-- The 0009 versions are replaced, not overloaded: an order without delivery
-- details can no longer be placed.

drop function if exists public.create_stock_order(uuid, integer);

create or replace function public.create_stock_order(
  p_product uuid, p_quantity integer,
  p_method text, p_address text, p_municipality text, p_phone text, p_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  me record;
  item record;
  open_holds integer;
  sub numeric;
  fee numeric;
  created public.orders;
begin
  select * into me from public.current_buyer();
  perform public.release_expired_holds();
  perform public.check_delivery(p_method, p_address, p_municipality, p_phone);

  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'Choose a quantity from 1 to 20.' using errcode = 'check_violation';
  end if;

  select count(*) into open_holds from public.orders
   where buyer_id = me.user_id and status = 'pending_payment';
  if open_holds >= 3 then
    raise exception 'Finish or cancel your open checkouts first.' using errcode = 'check_violation';
  end if;

  select p.id, p.name, p.price_php, p.stock, p.store_id, s.fulfilment, po.paypal_email
    into item
    from public.products p
    join public.stores s on s.id = p.store_id
    left join public.store_payout po on po.store_id = s.id
   where p.id = p_product and p.status = 'published' and s.status = 'active'
   for update of p;

  if not found then
    raise exception 'That piece is no longer available.' using errcode = 'no_data_found';
  end if;
  if item.fulfilment <> 'stocked' then
    raise exception 'This shop builds to order. Send a custom request instead.' using errcode = 'check_violation';
  end if;
  if item.paypal_email is null then
    raise exception 'This shop is not taking online payments yet.' using errcode = 'check_violation';
  end if;
  if item.price_php <= 0 then
    raise exception 'This piece has no price yet. Contact the shop.' using errcode = 'check_violation';
  end if;
  if item.stock < p_quantity then
    raise exception 'Only % left in stock.', item.stock using errcode = 'check_violation';
  end if;

  update public.products set stock = stock - p_quantity where id = item.id;

  sub := public.money(item.price_php * p_quantity);
  fee := public.money(sub * public.platform_fee_rate());

  insert into public.orders (
    kind, status, buyer_id, buyer_name, buyer_email, store_id, product_id, product_name,
    quantity, unit_price, subtotal, fee_rate, platform_fee, total, hold_expires_at,
    fulfilment_method, delivery_address, delivery_municipality, delivery_phone, delivery_notes
  ) values (
    'stock', 'pending_payment', me.user_id, me.full_name, me.email, item.store_id, item.id, item.name,
    p_quantity, item.price_php, sub, public.platform_fee_rate(), fee, sub + fee, now() + interval '30 minutes',
    p_method,
    case when p_method = 'delivery' then btrim(p_address) end,
    case when p_method = 'delivery' then p_municipality end,
    btrim(p_phone),
    nullif(left(btrim(coalesce(p_notes, '')), 300), '')
  ) returning * into created;

  return jsonb_build_object('order_id', created.id, 'reference', created.reference);
end;
$$;

drop function if exists public.create_custom_request(uuid, uuid, jsonb);

create or replace function public.create_custom_request(
  p_store uuid, p_product uuid, p_request jsonb,
  p_method text, p_address text, p_municipality text, p_phone text, p_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  me record;
  shop record;
  base_name text;
  open_requests integer;
  clean jsonb;
  created public.orders;
begin
  select * into me from public.current_buyer();
  perform public.check_delivery(p_method, p_address, p_municipality, p_phone);

  select s.id, s.name, s.fulfilment into shop
    from public.stores s where s.id = p_store and s.status = 'active';
  if not found then
    raise exception 'That shop is not available.' using errcode = 'no_data_found';
  end if;
  if shop.fulfilment <> 'custom' then
    raise exception 'This shop sells from stock. Buy the piece instead.' using errcode = 'check_violation';
  end if;

  if p_product is not null then
    select name into base_name from public.products
     where id = p_product and store_id = p_store and status = 'published';
    if base_name is null then
      raise exception 'That piece is not from this shop.' using errcode = 'check_violation';
    end if;
  end if;

  select count(*) into open_requests from public.orders
   where buyer_id = me.user_id and store_id = p_store and status in ('requested', 'quoted');
  if open_requests >= 5 then
    raise exception 'You already have 5 open requests with this shop.' using errcode = 'check_violation';
  end if;

  clean := jsonb_strip_nulls(jsonb_build_object(
    'width_cm',  case when (p_request->>'width_cm')  ~ '^\d{1,4}(\.\d)?$' and (p_request->>'width_cm')::numeric  between 1 and 1000 then (p_request->>'width_cm')::numeric end,
    'height_cm', case when (p_request->>'height_cm') ~ '^\d{1,4}(\.\d)?$' and (p_request->>'height_cm')::numeric between 1 and 1000 then (p_request->>'height_cm')::numeric end,
    'depth_cm',  case when (p_request->>'depth_cm')  ~ '^\d{1,4}(\.\d)?$' and (p_request->>'depth_cm')::numeric  between 1 and 1000 then (p_request->>'depth_cm')::numeric end,
    'material',  nullif(left(btrim(coalesce(p_request->>'material', '')), 80), ''),
    'color',     nullif(left(btrim(coalesce(p_request->>'color', '')), 80), ''),
    'notes',     nullif(left(btrim(coalesce(p_request->>'notes', '')), 1000), '')
  ));
  if clean->>'notes' is null and clean->>'width_cm' is null then
    raise exception 'Describe what you want built: a size or some notes.' using errcode = 'check_violation';
  end if;

  insert into public.orders (
    kind, status, buyer_id, buyer_name, buyer_email, store_id, product_id, product_name,
    fee_rate, request,
    fulfilment_method, delivery_address, delivery_municipality, delivery_phone, delivery_notes
  ) values (
    'custom', 'requested', me.user_id, me.full_name, me.email, shop.id, p_product,
    coalesce('Custom: ' || base_name, 'Custom build'), public.platform_fee_rate(), clean,
    p_method,
    case when p_method = 'delivery' then btrim(p_address) end,
    case when p_method = 'delivery' then p_municipality end,
    btrim(p_phone),
    nullif(left(btrim(coalesce(p_notes, '')), 300), '')
  ) returning * into created;

  return jsonb_build_object('order_id', created.id, 'reference', created.reference);
end;
$$;

-- ----------------------------------------------- moving it along -------

/*
  The shop's steps after payment. Only a fully paid order moves; each step
  must fit the buyer's choice (a pickup is never "out for delivery"), and
  "delivered" closes the order as fulfilled.
*/
create or replace function public.update_delivery_status(p_order uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
begin
  select * into target from public.orders where id = p_order for update;
  if not found or not public.is_store_member(target.store_id) then
    raise exception 'That order is not one of your store''s.' using errcode = '42501';
  end if;
  if target.status <> 'paid' then
    raise exception 'Only a fully paid order can be sent or handed over.' using errcode = 'check_violation';
  end if;
  if p_status = 'out_for_delivery' and target.fulfilment_method is distinct from 'delivery' then
    raise exception 'This order is a store pickup, not a delivery.' using errcode = 'check_violation';
  end if;
  if p_status = 'ready_for_pickup' and target.fulfilment_method is distinct from 'pickup' then
    raise exception 'This order is a delivery, not a store pickup.' using errcode = 'check_violation';
  end if;
  if p_status not in ('out_for_delivery', 'ready_for_pickup', 'delivered') then
    raise exception 'Unknown delivery step.' using errcode = 'check_violation';
  end if;

  update public.orders
     set delivery_status = p_status,
         status = case when p_status = 'delivered' then 'fulfilled'::public.order_status else status end,
         fulfilled_at = case when p_status = 'delivered' then now() else fulfilled_at end,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end
   where id = p_order;

  return jsonb_build_object('order_id', p_order, 'delivery_status', p_status,
                            'status', case when p_status = 'delivered' then 'fulfilled' else 'paid' end);
end;
$$;

/* 0009's "handed over" now also closes the delivery. */
create or replace function public.mark_order_fulfilled(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.update_delivery_status(p_order, 'delivered');
end;
$$;

-- --------------------------------------------- everything on a receipt ---

create or replace function public.order_contacts(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  target public.orders;
  shop record;
  owners text[];
  paid jsonb;
begin
  select * into target from public.orders where id = p_order;
  if not found or not (target.buyer_id = auth.uid() or public.is_store_member(target.store_id)) then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  select s.name, s.address, s.contact_number, po.notify_email into shop
    from public.stores s left join public.store_payout po on po.store_id = s.id
   where s.id = target.store_id;
  select array_agg(u.email::text) into owners
    from public.store_members m join auth.users u on u.id = m.user_id
   where m.store_id = target.store_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'stage', p.stage, 'amount', p.amount, 'capture_id', p.capture_id,
           'captured_at', p.captured_at, 'applied', p.applied) order by p.captured_at), '[]'::jsonb)
    into paid from public.payments p where p.order_id = target.id;

  return jsonb_build_object(
    'order_id', target.id, 'reference', target.reference, 'status', target.status, 'kind', target.kind,
    'created_at', target.created_at, 'paid_at', target.paid_at,
    'product_name', target.product_name, 'quantity', target.quantity, 'unit_price', target.unit_price,
    'subtotal', target.subtotal, 'platform_fee', target.platform_fee, 'total', target.total,
    'deposit_amount', target.deposit_amount, 'amount_paid', target.amount_paid, 'currency', target.currency,
    'lead_time_days', target.lead_time_days, 'quote_note', target.quote_note,
    'decline_reason', target.decline_reason, 'request', target.request,
    'buyer_name', target.buyer_name, 'buyer_email', target.buyer_email,
    'fulfilment_method', target.fulfilment_method, 'delivery_address', target.delivery_address,
    'delivery_municipality', target.delivery_municipality, 'delivery_phone', target.delivery_phone,
    'delivery_notes', target.delivery_notes, 'estimated_arrival', target.estimated_arrival,
    'delivery_status', target.delivery_status, 'delivered_at', target.delivered_at,
    'payments', paid,
    'store_name', shop.name, 'store_address', shop.address, 'store_contact', shop.contact_number,
    'store_emails', case when shop.notify_email is not null then array[shop.notify_email] else owners end
  );
end;
$$;

-- ------------------------------------------------------------ grants ---

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_store_billing(uuid, public.store_fulfilment, text, text, integer, integer)',
    'public.create_stock_order(uuid, integer, text, text, text, text, text)',
    'public.create_custom_request(uuid, uuid, jsonb, text, text, text, text, text)',
    'public.update_delivery_status(uuid, text)',
    'public.mark_order_fulfilled(uuid)',
    'public.order_contacts(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
