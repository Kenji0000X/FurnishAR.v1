-- ===========================================================================
-- Orders, payments and the platform fee.                       DFD: P10 / D5
--
-- TWO KINDS OF STORE
--   stocked   sells what is on the shelf. A buyer pays in full; the stock is
--             held for them while they are at PayPal and released if they
--             do not finish.
--   custom    builds to order. A buyer sends a request (size, material,
--             notes); the shop quotes a price and lead time; the buyer pays a
--             50% deposit to reserve the build and the balance when the shop
--             says it is ready.
--
-- WHERE THE MONEY GOES
--   Straight to the shop's own PayPal account. FurnishAR never holds a
--   buyer's money. The buyer pays the shop's price plus a 10% service fee on
--   top; the shop receives all of it and owes the 10% to FurnishAR, which is
--   recorded per payment here and settled against fee_settlements.
--
-- WHO DECIDES WHAT
--   Every amount is computed in this file, from rows the buyer cannot write.
--   A browser sends "this product, this many" — never a price. Orders and
--   payments have no insert/update/delete grants at all; they change only
--   through the functions below, each of which checks auth.uid() itself.
--
--   A payment is recorded only by record_capture(), and only when the caller
--   presents the server's payment-recorder secret (billing_private.secrets).
--   The server calls it after PayPal has confirmed the capture and the server
--   has checked the amount and the payee. A buyer who calls it directly,
--   with any amounts they like, is refused: they do not have the secret.
--   The Supabase secret/service_role key is not involved anywhere.
-- ===========================================================================

-- ------------------------------------------------------------- store type --

do $$ begin
  create type public.store_fulfilment as enum ('stocked', 'custom');
exception when duplicate_object then null; end $$;

alter table public.stores
  add column if not exists fulfilment public.store_fulfilment not null default 'stocked';

-- Owners could previously UPDATE every column of their own store row —
-- including `plan` (a free premium upgrade) and `status` (un-suspending a
-- store an admin suspended). Only the shop's own details are theirs to edit.
revoke update on public.stores from authenticated;
grant update (name, address, contact_number, hours, fulfilment) on public.stores to authenticated;

-- The catalogue carries the store type so a product page knows whether to
-- offer "Buy" or "Request a custom build". Appended at the end: a view may
-- gain columns in place but not reorder them.
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
    s.fulfilment  as store_fulfilment
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.status = 'published' and s.status = 'active';

grant select on public.catalog to anon, authenticated;

-- --------------------------------------------------------- store payout ---
-- Where a shop is paid and where its order emails go. Kept off `stores`
-- because that table is publicly readable.

create table if not exists public.store_payout (
  store_id      uuid primary key references public.stores (id) on delete cascade,
  paypal_email  text check (paypal_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(paypal_email) <= 254),
  notify_email  text check (notify_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(notify_email) <= 254),
  updated_at    timestamptz not null default now()
);

alter table public.store_payout enable row level security;

drop policy if exists store_payout_member_read on public.store_payout;
create policy store_payout_member_read on public.store_payout
  for select using (public.is_store_member(store_id) or public.is_platform_admin());

grant select on public.store_payout to authenticated;

-- ----------------------------------------------------------------- orders --

do $$ begin
  create type public.order_kind as enum ('stock', 'custom');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum (
    'pending_payment',  -- stock: held, waiting for PayPal
    'requested',        -- custom: waiting for the shop's quote
    'quoted',           -- custom: waiting for the buyer's deposit
    'deposit_paid',     -- custom: being built
    'balance_due',      -- custom: ready, waiting for the balance
    'paid',             -- paid in full
    'fulfilled',        -- handed over
    'declined',         -- custom: the shop said no
    'cancelled',        -- the buyer withdrew before paying
    'expired'           -- stock: the hold ran out before payment
  );
exception when duplicate_object then null; end $$;

create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  reference       text not null unique
                  default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  kind            public.order_kind not null,
  status          public.order_status not null,
  buyer_id        uuid not null references auth.users (id) on delete restrict,
  buyer_name      text not null,
  buyer_email     text not null,
  store_id        uuid not null references public.stores (id) on delete restrict,
  product_id      uuid references public.products (id) on delete set null,
  product_name    text not null,
  quantity        integer not null default 1 check (quantity between 1 and 20),
  unit_price      numeric(12,2) check (unit_price >= 0),
  subtotal        numeric(12,2) check (subtotal >= 0),    -- the shop's price
  fee_rate        numeric(5,4) not null,
  platform_fee    numeric(12,2) check (platform_fee >= 0),
  total           numeric(12,2) check (total >= 0),       -- what the buyer pays
  deposit_amount  numeric(12,2) check (deposit_amount >= 0),
  amount_paid     numeric(12,2) not null default 0 check (amount_paid >= 0),
  currency        text not null default 'PHP' check (currency = 'PHP'),
  request         jsonb,
  quote_note      text check (length(quote_note) <= 1000),
  lead_time_days  integer check (lead_time_days between 1 and 365),
  decline_reason  text check (length(decline_reason) <= 500),
  hold_expires_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  quoted_at       timestamptz,
  paid_at         timestamptz,
  fulfilled_at    timestamptz
);

create index if not exists orders_buyer_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_store_idx on public.orders (store_id, created_at desc);
create index if not exists orders_hold_idx  on public.orders (hold_expires_at) where status = 'pending_payment';

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

alter table public.orders enable row level security;

drop policy if exists orders_party_read on public.orders;
create policy orders_party_read on public.orders
  for select using (
    buyer_id = auth.uid() or public.is_store_member(store_id) or public.is_platform_admin()
  );

-- Read-only to clients. Every change goes through a function below.
grant select on public.orders to authenticated;

-- --------------------------------------------------------------- payments --

create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete restrict,
  store_id           uuid not null references public.stores (id) on delete restrict,
  stage              text not null check (stage in ('full', 'deposit', 'balance')),
  provider           text not null default 'paypal' check (provider = 'paypal'),
  provider_order_id  text not null,
  capture_id         text not null unique,
  amount             numeric(12,2) not null check (amount > 0),
  platform_fee       numeric(12,2) not null check (platform_fee >= 0),
  currency           text not null check (currency = 'PHP'),
  payee_email        text not null,
  payer_email        text,
  -- false when the money arrived but the order had already moved on (paid
  -- twice, or after a hold expired with the stock gone). The shop is told to
  -- refund it; it is never silently dropped.
  applied            boolean not null,
  captured_at        timestamptz not null default now()
);

create index if not exists payments_order_idx on public.payments (order_id);
create index if not exists payments_store_idx on public.payments (store_id, captured_at desc);

alter table public.payments enable row level security;

drop policy if exists payments_party_read on public.payments;
create policy payments_party_read on public.payments
  for select using (
    public.is_store_member(store_id)
    or public.is_platform_admin()
    or exists (select 1 from public.orders o where o.id = order_id and o.buyer_id = auth.uid())
  );

grant select on public.payments to authenticated;

-- -------------------------------------------------------- fee settlements --

create table if not exists public.fee_settlements (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete restrict,
  amount      numeric(12,2) not null check (amount > 0),
  reference   text check (length(reference) <= 120),
  note        text check (length(note) <= 500),
  recorded_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists fee_settlements_store_idx on public.fee_settlements (store_id, created_at desc);

alter table public.fee_settlements enable row level security;

drop policy if exists fee_settlements_party_read on public.fee_settlements;
create policy fee_settlements_party_read on public.fee_settlements
  for select using (public.is_store_member(store_id) or public.is_platform_admin());

grant select on public.fee_settlements to authenticated;

-- ---------------------------------------------------- the server's secret --
-- A schema PostgREST does not expose, readable by no client role. It holds a
-- SHA-256 of the server's PAYMENT_RECORDER_SECRET, never the secret itself.
-- Set it once, from the SQL editor:
--   insert into billing_private.secrets (name, sha256_hex)
--   values ('payment_recorder', encode(sha256(convert_to('<the secret>', 'UTF8')), 'hex'))
--   on conflict (name) do update set sha256_hex = excluded.sha256_hex;

create schema if not exists billing_private;
revoke all on schema billing_private from public;

create table if not exists billing_private.secrets (
  name        text primary key,
  sha256_hex  text not null check (sha256_hex ~ '^[0-9a-f]{64}$')
);

revoke all on billing_private.secrets from public;

-- ----------------------------------------------------------------- helpers --

create or replace function public.platform_fee_rate()
returns numeric
language sql
immutable
set search_path = ''
as $$ select 0.10::numeric $$;

grant execute on function public.platform_fee_rate() to anon, authenticated;

/* Hands expired stock holds back to the shelf. Called at the start of every
   function that reads or takes stock, so no scheduler is needed. */
create or replace function public.release_expired_holds()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  held record;
begin
  for held in
    update public.orders
       set status = 'expired', hold_expires_at = null
     where status = 'pending_payment' and hold_expires_at < now()
    returning product_id, quantity
  loop
    if held.product_id is not null then
      update public.products set stock = stock + held.quantity where id = held.product_id;
    end if;
  end loop;
end;
$$;

revoke all on function public.release_expired_holds() from public, anon, authenticated;

create or replace function public.money(value numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$ select round(value, 2) $$;

grant execute on function public.money(numeric) to anon, authenticated;

/* The caller as a buyer: name and email, or an error. One account, one role
   (0006) — a store owner or admin does not shop with that account. */
create or replace function public.current_buyer()
returns table (user_id uuid, full_name text, email text)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to place an order.' using errcode = '28000';
  end if;
  return query
    select b.user_id, b.full_name, u.email::text
      from public.buyers b join auth.users u on u.id = b.user_id
     where b.user_id = auth.uid();
  if not found then
    raise exception 'Only a shopper account can place orders.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.current_buyer() from public, anon, authenticated;

-- ------------------------------------------------------------ store owner --

create or replace function public.save_store_billing(
  p_store uuid, p_fulfilment public.store_fulfilment, p_paypal_email text, p_notify_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_store_member(p_store) then
    raise exception 'Only this store''s owner can change its billing.' using errcode = '42501';
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

  insert into public.store_payout (store_id, paypal_email, notify_email, updated_at)
  values (p_store, nullif(lower(btrim(p_paypal_email)), ''), nullif(lower(btrim(p_notify_email)), ''), now())
  on conflict (store_id) do update
    set paypal_email = excluded.paypal_email,
        notify_email = excluded.notify_email,
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------- buying from stock --

create or replace function public.create_stock_order(p_product uuid, p_quantity integer)
returns jsonb
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

  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'Choose a quantity from 1 to 20.' using errcode = 'check_violation';
  end if;

  -- Someone holding every chair in town by opening checkouts they never
  -- finish is the abuse a hold invites. Three at a time is plenty.
  select count(*) into open_holds from public.orders
   where buyer_id = me.user_id and status = 'pending_payment';
  if open_holds >= 3 then
    raise exception 'Finish or cancel your open checkouts first.' using errcode = 'check_violation';
  end if;

  select p.id, p.name, p.price_php, p.stock, p.store_id, s.fulfilment, s.name as store_name,
         po.paypal_email
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
    quantity, unit_price, subtotal, fee_rate, platform_fee, total, hold_expires_at
  ) values (
    'stock', 'pending_payment', me.user_id, me.full_name, me.email, item.store_id, item.id, item.name,
    p_quantity, item.price_php, sub, public.platform_fee_rate(), fee, sub + fee, now() + interval '30 minutes'
  ) returning * into created;

  return jsonb_build_object('order_id', created.id, 'reference', created.reference);
end;
$$;

-- ------------------------------------------------------- custom builds ----

create or replace function public.create_custom_request(p_store uuid, p_product uuid, p_request jsonb)
returns jsonb
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

  -- Only the fields the shop needs, each bounded. Nothing else in the
  -- browser's JSON survives.
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
    fee_rate, request
  ) values (
    'custom', 'requested', me.user_id, me.full_name, me.email, shop.id, p_product,
    coalesce('Custom: ' || base_name, 'Custom build'), public.platform_fee_rate(), clean
  ) returning * into created;

  return jsonb_build_object('order_id', created.id, 'reference', created.reference);
end;
$$;

create or replace function public.quote_custom_order(
  p_order uuid, p_price numeric, p_lead_days integer, p_note text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
  fee numeric;
  total_due numeric;
begin
  select * into target from public.orders where id = p_order for update;
  if not found or not public.is_store_member(target.store_id) then
    raise exception 'That order is not one of your store''s.' using errcode = '42501';
  end if;
  if target.status not in ('requested', 'quoted') then
    raise exception 'This order can no longer be quoted.' using errcode = 'check_violation';
  end if;
  if p_price is null or p_price <= 0 or p_price > 10000000 then
    raise exception 'Enter a price between ₱1 and ₱10,000,000.' using errcode = 'check_violation';
  end if;
  if p_lead_days is null or p_lead_days < 1 or p_lead_days > 365 then
    raise exception 'Enter a lead time from 1 to 365 days.' using errcode = 'check_violation';
  end if;

  fee := public.money(p_price * target.fee_rate);
  total_due := public.money(p_price) + fee;

  update public.orders
     set status = 'quoted',
         unit_price = public.money(p_price),
         subtotal = public.money(p_price),
         platform_fee = fee,
         total = total_due,
         deposit_amount = public.money(total_due * 0.5),
         lead_time_days = p_lead_days,
         quote_note = nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
         quoted_at = now()
   where id = p_order;

  return jsonb_build_object('order_id', p_order, 'status', 'quoted');
end;
$$;

create or replace function public.decline_custom_order(p_order uuid, p_reason text)
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
  if target.status not in ('requested', 'quoted') then
    raise exception 'Only a request that has not been paid can be declined.' using errcode = 'check_violation';
  end if;
  update public.orders
     set status = 'declined', decline_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), '')
   where id = p_order;
  return jsonb_build_object('order_id', p_order, 'status', 'declined');
end;
$$;

/* The buyer withdraws before paying anything. */
create or replace function public.cancel_order(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
begin
  select * into target from public.orders where id = p_order for update;
  if not found or target.buyer_id is distinct from auth.uid() then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  if target.status not in ('pending_payment', 'requested', 'quoted') then
    raise exception 'A paid order cannot be cancelled here. Contact the shop.' using errcode = 'check_violation';
  end if;
  if target.status = 'pending_payment' and target.product_id is not null then
    update public.products set stock = stock + target.quantity where id = target.product_id;
  end if;
  update public.orders set status = 'cancelled', hold_expires_at = null where id = p_order;
  return jsonb_build_object('order_id', p_order, 'status', 'cancelled');
end;
$$;

create or replace function public.mark_order_ready(p_order uuid)
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
  if target.status <> 'deposit_paid' then
    raise exception 'Only a build with its deposit paid can be marked ready.' using errcode = 'check_violation';
  end if;
  update public.orders
     set status = case when target.amount_paid >= target.total then 'paid'::public.order_status
                       else 'balance_due'::public.order_status end
   where id = p_order
  returning status into target.status;
  return jsonb_build_object('order_id', p_order, 'status', target.status);
end;
$$;

create or replace function public.mark_order_fulfilled(p_order uuid)
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
    raise exception 'Only a fully paid order can be marked handed over.' using errcode = 'check_violation';
  end if;
  update public.orders set status = 'fulfilled', fulfilled_at = now() where id = p_order;
  return jsonb_build_object('order_id', p_order, 'status', 'fulfilled');
end;
$$;

-- --------------------------------------------------------------- paying ---

/*
  What the buyer owes right now, and to whom. The server asks this before it
  creates a PayPal order and again before it captures one, so both use the
  database's amount — never the browser's.
*/
create or replace function public.begin_payment(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
  payee text;
  store_name text;
  stage text;
  due numeric;
begin
  perform public.release_expired_holds();
  select * into target from public.orders where id = p_order;
  if not found or target.buyer_id is distinct from auth.uid() then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;

  stage := case target.status
             when 'pending_payment' then 'full'
             when 'quoted'          then 'deposit'
             when 'balance_due'     then 'balance'
           end;
  -- Answered, not raised: raising would roll back release_expired_holds()
  -- above, and an expired hold would keep its stock off the shelf.
  if stage is null then
    return jsonb_build_object('order_id', target.id, 'reference', target.reference,
                              'stage', null, 'status', target.status);
  end if;

  due := case stage
           when 'full'    then target.total
           when 'deposit' then target.deposit_amount
           else target.total - target.amount_paid
         end;

  select po.paypal_email, s.name into payee, store_name
    from public.stores s left join public.store_payout po on po.store_id = s.id
   where s.id = target.store_id;
  if payee is null then
    raise exception 'This shop is not taking online payments yet.' using errcode = 'check_violation';
  end if;

  return jsonb_build_object(
    'order_id', target.id, 'reference', target.reference, 'stage', stage,
    'amount', due, 'currency', target.currency, 'payee_email', payee,
    'store_name', store_name, 'product_name', target.product_name,
    'hold_expires_at', target.hold_expires_at
  );
end;
$$;

/*
  Records a payment PayPal has already captured. Called by the server only —
  see the secret at the top of this file. Idempotent on capture_id: the
  server may retry after a timeout without paying anything twice.
*/
create or replace function public.record_capture(
  p_secret text, p_order uuid, p_stage text, p_provider_order text, p_capture text,
  p_amount numeric, p_currency text, p_payee text, p_payer_email text
) returns jsonb
language plpgsql
security definer
set search_path = public, billing_private
as $$
declare
  expected text;
  target public.orders;
  payee text;
  due numeric;
  applied boolean := false;
  next_status public.order_status;
  existing public.payments;
  shelf integer;
begin
  select sha256_hex into expected from billing_private.secrets where name = 'payment_recorder';
  if expected is null or p_secret is null
     or encode(sha256(convert_to(p_secret, 'UTF8')), 'hex') <> expected then
    raise exception 'Payments are recorded by the server only.' using errcode = '42501';
  end if;

  select * into existing from public.payments where capture_id = p_capture;
  if found then
    select * into target from public.orders where id = existing.order_id;
    return jsonb_build_object('order_id', target.id, 'status', target.status,
                              'applied', existing.applied, 'duplicate', true);
  end if;

  select * into target from public.orders where id = p_order for update;
  if not found or target.buyer_id is distinct from auth.uid() then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  if p_stage not in ('full', 'deposit', 'balance') or p_currency <> target.currency then
    raise exception 'Unexpected payment.' using errcode = 'check_violation';
  end if;

  select paypal_email into payee from public.store_payout where store_id = target.store_id;
  if payee is null or lower(p_payee) <> lower(payee) then
    raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
  end if;

  -- An expired hold whose stock is still on the shelf is taken back rather
  -- than refused: the buyer paid, and the piece is there.
  if p_stage = 'full' and target.status = 'expired' and target.product_id is not null then
    update public.products set stock = stock - target.quantity
     where id = target.product_id and stock >= target.quantity
    returning stock into shelf;
    if found then
      update public.orders set status = 'pending_payment' where id = target.id;
      target.status := 'pending_payment';
    end if;
  end if;

  due := case p_stage
           when 'full'    then target.total
           when 'deposit' then target.deposit_amount
           else target.total - target.amount_paid
         end;
  next_status := case
    when p_stage = 'full'    and target.status = 'pending_payment' then 'paid'
    when p_stage = 'deposit' and target.status = 'quoted'          then
      case when public.money(target.amount_paid + p_amount) >= target.total then 'paid' else 'deposit_paid' end
    when p_stage = 'balance' and target.status = 'balance_due'     then 'paid'
  end::public.order_status;

  applied := next_status is not null and public.money(p_amount) = public.money(due);

  insert into public.payments (
    order_id, store_id, stage, provider_order_id, capture_id, amount, platform_fee,
    currency, payee_email, payer_email, applied
  ) values (
    target.id, target.store_id, p_stage, p_provider_order, p_capture, public.money(p_amount),
    -- The fee inside this payment: the payment is (1 + rate) parts, the fee one of them.
    case when applied then public.money(p_amount * target.fee_rate / (1 + target.fee_rate)) else 0 end,
    p_currency, lower(p_payee), nullif(left(p_payer_email, 254), ''), applied
  );

  if applied then
    update public.orders
       set status = next_status,
           amount_paid = public.money(amount_paid + p_amount),
           hold_expires_at = null,
           paid_at = case when next_status = 'paid' then now() else paid_at end
     where id = target.id;
  end if;

  return jsonb_build_object('order_id', target.id,
                            'status', coalesce(next_status, target.status),
                            'applied', applied, 'duplicate', false);
end;
$$;

/* Who to email about an order. Only a party to the order may ask. */
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
begin
  select * into target from public.orders where id = p_order;
  if not found or not (target.buyer_id = auth.uid() or public.is_store_member(target.store_id)) then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  select s.name, po.notify_email into shop
    from public.stores s left join public.store_payout po on po.store_id = s.id
   where s.id = target.store_id;
  select array_agg(u.email::text) into owners
    from public.store_members m join auth.users u on u.id = m.user_id
   where m.store_id = target.store_id;
  return jsonb_build_object(
    'reference', target.reference, 'status', target.status, 'kind', target.kind,
    'product_name', target.product_name, 'quantity', target.quantity,
    'subtotal', target.subtotal, 'platform_fee', target.platform_fee, 'total', target.total,
    'deposit_amount', target.deposit_amount, 'amount_paid', target.amount_paid,
    'lead_time_days', target.lead_time_days, 'quote_note', target.quote_note,
    'decline_reason', target.decline_reason, 'request', target.request,
    'buyer_name', target.buyer_name, 'buyer_email', target.buyer_email,
    'store_name', shop.name,
    'store_emails', case when shop.notify_email is not null then array[shop.notify_email] else owners end
  );
end;
$$;

-- -------------------------------------------------------------- the fee ---

create or replace function public.store_fee_summary(p_store uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  accrued numeric;
  settled numeric;
begin
  if not (public.is_store_member(p_store) or public.is_platform_admin()) then
    raise exception 'Not your store.' using errcode = '42501';
  end if;
  select coalesce(sum(platform_fee), 0) into accrued from public.payments where store_id = p_store and applied;
  select coalesce(sum(amount), 0) into settled from public.fee_settlements where store_id = p_store;
  return jsonb_build_object('store_id', p_store, 'accrued', accrued, 'settled', settled,
                            'outstanding', accrued - settled, 'fee_rate', public.platform_fee_rate());
end;
$$;

create or replace function public.fee_overview()
returns table (store_id uuid, store_name text, fulfilment public.store_fulfilment,
               sales numeric, accrued numeric, settled numeric, outstanding numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may view fees.' using errcode = '42501';
  end if;
  return query
    select s.id, s.name, s.fulfilment,
           coalesce(p.sales, 0), coalesce(p.fees, 0), coalesce(f.settled, 0),
           coalesce(p.fees, 0) - coalesce(f.settled, 0)
      from public.stores s
      left join (select pa.store_id, sum(pa.amount) as sales, sum(pa.platform_fee) as fees
                   from public.payments pa where pa.applied group by pa.store_id) p on p.store_id = s.id
      left join (select fs.store_id, sum(fs.amount) as settled
                   from public.fee_settlements fs group by fs.store_id) f on f.store_id = s.id
     order by coalesce(p.fees, 0) - coalesce(f.settled, 0) desc, s.name;
end;
$$;

create or replace function public.record_fee_settlement(
  p_store uuid, p_amount numeric, p_reference text, p_note text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor_email text;
  created public.fee_settlements;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may record a settlement.' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount received.' using errcode = 'check_violation';
  end if;
  insert into public.fee_settlements (store_id, amount, reference, note, recorded_by)
  values (p_store, public.money(p_amount), nullif(left(btrim(coalesce(p_reference, '')), 120), ''),
          nullif(left(btrim(coalesce(p_note, '')), 500), ''), auth.uid())
  returning * into created;

  select email into actor_email from auth.users where id = auth.uid();
  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, 'fees.settled', p_store,
          jsonb_build_object('amount', created.amount, 'reference', created.reference));

  return jsonb_build_object('id', created.id);
end;
$$;

-- ------------------------------------------------------------------ grants --
-- Every function above checks its caller itself. None is callable signed out.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_store_billing(uuid, public.store_fulfilment, text, text)',
    'public.create_stock_order(uuid, integer)',
    'public.create_custom_request(uuid, uuid, jsonb)',
    'public.quote_custom_order(uuid, numeric, integer, text)',
    'public.decline_custom_order(uuid, text)',
    'public.cancel_order(uuid)',
    'public.mark_order_ready(uuid)',
    'public.mark_order_fulfilled(uuid)',
    'public.begin_payment(uuid)',
    'public.record_capture(text, uuid, text, text, text, numeric, text, text, text)',
    'public.order_contacts(uuid)',
    'public.store_fee_summary(uuid)',
    'public.fee_overview()',
    'public.record_fee_settlement(uuid, numeric, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ----------------------------------------------------- table privileges ---
-- Supabase's default privileges grant anon and authenticated ALL on every new
-- table in `public`. RLS would still refuse the writes (there are no write
-- policies), but "no client ever writes these" should be true of the grants
-- too, not only of the policies. Reads stay with authenticated, under RLS.
revoke all on public.orders, public.payments, public.store_payout, public.fee_settlements from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.orders, public.payments, public.store_payout, public.fee_settlements from authenticated;
-- The same default gave anon UPDATE on stores; only members (above) may edit.
revoke update on public.stores from anon;
