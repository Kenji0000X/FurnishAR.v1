-- 0017 — PayPal: provable money split per payment, and payment emails sent
-- exactly once.                                               DFD: P10 → D5, P10 → P9
--
-- Needs 0016. PayPal only: PayMongo / GCash behaviour is unchanged.
--
-- 1. Every payment row states, without arithmetic in the browser:
--      amount          what the buyer paid in this payment (gross)
--      platform_fee    FurnishAR's 10% share of it (stage_platform_fee: the
--                      order's fee is computed ONCE; deposit + balance = fee)
--      store_portion   amount - platform_fee: the furniture money, the shop's
--      fee_status      collected  PayPal reported taking exactly the fee
--                                 (platform_split, 0011's record_capture)
--                      accrued    the shop received it and owes it (accrual)
--                      refunded   the fee was returned with a refund
--                      held / expected   PayMongo (0016), unchanged
--                      none       not applied, or no fee
--
-- 2. payment_notifications is the ledger of "payment received" emails. A
--    trigger writes one row per audience (buyer, store, admin) in the same
--    transaction that records a PayPal payment, so a recorded payment always
--    has its notifications waiting, and a duplicate capture, webhook or page
--    refresh — which never inserts a second payment — can never create a
--    second set. The server claims rows atomically (FOR UPDATE SKIP LOCKED),
--    so the buyer's return and the webhook racing each other send once.
--    A failed email stays retryable; it never touches the payment.
--
-- 3. server_record_refund: a platform fee that PayPal collected is counted as
--    returned only when PayPal says it returned it. Before, a refund without
--    a platform-fee figure was split proportionally, which could show a fee
--    PayPal kept as refunded (and one it returned as still collected).

-- ------------------------------------------------ provable split per payment

alter table public.payments
  add column if not exists store_portion numeric(12,2)
    generated always as (amount - platform_fee) stored,
  add column if not exists fee_status text
    generated always as (
      case
        when not applied or platform_fee <= 0 then 'none'
        when refunded_platform_fee >= platform_fee then 'refunded'
        when fee_mode = 'platform_split' then 'collected'
        when fee_mode = 'platform_held' then 'held'
        when fee_mode = 'provider_split' then 'expected'
        else 'accrued'
      end) stored;

comment on column public.payments.store_portion is
  'amount - platform_fee: the furniture money that belongs to the shop, before any provider processing fee (0017).';
comment on column public.payments.fee_status is
  'collected only when PayPal reported the platform fee; accrued when the shop received it and owes it (0017).';

-- -------------------------------------------------- notification ledger ---

create table if not exists public.payment_notifications (
  id          bigserial primary key,
  capture_id  text not null references public.payments (capture_id) on delete cascade,
  order_id    uuid not null references public.orders (id) on delete cascade,
  audience    text not null check (audience in ('buyer', 'store', 'admin')),
  event       text not null check (event in ('paid', 'deposit_paid', 'unapplied')),
  status      text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts    integer not null default 0 check (attempts >= 0),
  last_error  text check (length(last_error) <= 200),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (capture_id, audience, event)
);

create index if not exists payment_notifications_open_idx
  on public.payment_notifications (status, created_at) where status in ('pending', 'sending', 'failed');

alter table public.payment_notifications enable row level security;

drop policy if exists payment_notifications_admin_read on public.payment_notifications;
create policy payment_notifications_admin_read on public.payment_notifications
  for select using (public.is_platform_admin());

revoke all on public.payment_notifications from anon;
revoke insert, update, delete, truncate, references, trigger on public.payment_notifications from authenticated;
grant select on public.payment_notifications to authenticated;
revoke all on sequence public.payment_notifications_id_seq from public, anon, authenticated;

/* One set of notifications per recorded PayPal payment, written with it. */
create or replace function public.queue_payment_notifications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.provider <> 'paypal' then
    return new;
  end if;
  if new.applied then
    insert into public.payment_notifications (capture_id, order_id, audience, event)
    select new.capture_id, new.order_id, a.audience,
           case new.stage when 'deposit' then 'deposit_paid' else 'paid' end
      from (values ('buyer'), ('store'), ('admin')) as a (audience)
    on conflict (capture_id, audience, event) do nothing;
  else
    -- Money that arrived for an order that had moved on: the shop refunds it.
    insert into public.payment_notifications (capture_id, order_id, audience, event)
    values (new.capture_id, new.order_id, 'store', 'unapplied')
    on conflict (capture_id, audience, event) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.queue_payment_notifications() from public, anon, authenticated;

drop trigger if exists payments_queue_notifications on public.payments;
create trigger payments_queue_notifications
  after insert on public.payments
  for each row execute function public.queue_payment_notifications();

/*
  Claims notifications to send: pending ones, failed ones with attempts left,
  and ones left "sending" for ten minutes by a server that died mid-send.
  With p_capture, only that payment's (the capture / webhook path); without,
  any (the scheduled retry). Each row is handed to exactly one caller.
*/
create or replace function public.server_claim_payment_notifications(
  p_secret text, p_capture text default null, p_limit integer default 25
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed jsonb;
begin
  perform public.assert_server(p_secret);
  with picked as (
    select n.id from public.payment_notifications n
     where (p_capture is null or n.capture_id = p_capture)
       and (n.status = 'pending'
            or (n.status = 'failed' and n.attempts < 5)
            or (n.status = 'sending' and n.claimed_at < now() - interval '10 minutes'))
     order by n.id
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  ), updated as (
    update public.payment_notifications n
       set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
      from picked
     where n.id = picked.id
    returning n.id, n.capture_id, n.order_id, n.audience, n.event, n.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'capture_id', capture_id, 'order_id', order_id,
           'audience', audience, 'event', event, 'attempts', attempts) order by id), '[]'::jsonb)
    into claimed from updated;
  return claimed;
end;
$$;

create or replace function public.server_finish_payment_notification(
  p_secret text, p_id bigint, p_status text, p_error text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_server(p_secret);
  if p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'Unexpected notification status.' using errcode = 'check_violation';
  end if;
  update public.payment_notifications
     set status = p_status,
         last_error = case when p_status = 'sent' then null else left(p_error, 200) end,
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id and status = 'sending';
end;
$$;

-- ---------------------------------------------- refunds: no guessed fee ---

create or replace function public.server_record_refund(
  p_secret text, p_capture text, p_refund text, p_amount numeric, p_currency text,
  p_fee_refunded numeric, p_status text, p_kind text default 'refund'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pay public.payments;
  fee_part numeric;
  after_amount numeric;
  new_status text;
  total_refunded numeric;
  paid_total numeric;
begin
  perform public.assert_server(p_secret);
  if exists (select 1 from public.payment_refunds where refund_id = p_refund) then
    return jsonb_build_object('duplicate', true);
  end if;
  select * into pay from public.payments where capture_id = p_capture for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  if p_currency <> pay.currency or p_amount is null or p_amount <= 0 then
    raise exception 'Unexpected refund.' using errcode = 'check_violation';
  end if;
  if p_status not in ('COMPLETED', 'PENDING', 'FAILED', 'CANCELLED') then
    raise exception 'Unexpected refund status.' using errcode = 'check_violation';
  end if;

  after_amount := least(pay.amount, pay.refunded_amount + public.money(p_amount));
  fee_part := case
    when p_fee_refunded is not null then public.money(p_fee_refunded)
    -- PayPal took this fee; it is returned only when PayPal says so.
    when pay.fee_mode = 'platform_split' then 0
    -- Accrued (or held) fee: the buyer got it back, so the shop no longer owes it.
    when after_amount >= pay.amount then pay.platform_fee - pay.refunded_platform_fee
    else public.money(pay.platform_fee * p_amount / pay.amount)
  end;
  fee_part := least(greatest(fee_part, 0), pay.platform_fee - pay.refunded_platform_fee, public.money(p_amount));

  insert into public.payment_refunds (refund_id, capture_id, order_id, store_id, amount, seller_amount,
                                      platform_fee_refunded, kind, status)
  values (p_refund, p_capture, pay.order_id, pay.store_id, public.money(p_amount),
          public.money(p_amount) - fee_part, fee_part, coalesce(p_kind, 'refund'), p_status);

  if p_status <> 'COMPLETED' then
    return jsonb_build_object('order_id', pay.order_id, 'recorded', true, 'completed', false);
  end if;

  new_status := case when p_kind = 'reversal' then 'REVERSED'
                     when after_amount >= pay.amount then 'REFUNDED' else 'PARTIALLY_REFUNDED' end;
  update public.payments
     set refunded_amount = after_amount,
         refunded_platform_fee = refunded_platform_fee + fee_part,
         status = new_status
   where capture_id = p_capture;

  select coalesce(sum(refunded_amount), 0), coalesce(sum(amount), 0) into total_refunded, paid_total
    from public.payments where order_id = pay.order_id and applied;
  update public.orders
     set refunded_amount = total_refunded,
         refund_status = case when total_refunded <= 0 then 'none'
                              when total_refunded >= paid_total then 'full' else 'partial' end
   where id = pay.order_id;

  return jsonb_build_object('order_id', pay.order_id, 'recorded', true, 'completed', true,
                            'amount', public.money(p_amount), 'platform_fee_refunded', fee_part,
                            'fee_mode', pay.fee_mode, 'capture_id', p_capture,
                            'payment_status', new_status);
end;
$$;

-- --------------------------------------- contacts: the split per payment ---

create or replace function public.order_contacts_for(p_order uuid)
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
  if not found then return null; end if;
  select s.name, s.address, s.contact_number, po.notify_email into shop
    from public.stores s left join public.store_payout po on po.store_id = s.id
   where s.id = target.store_id;
  select array_agg(u.email::text) into owners
    from public.store_members m join auth.users u on u.id = m.user_id
   where m.store_id = target.store_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'stage', p.stage, 'amount', p.amount, 'capture_id', p.capture_id,
           'captured_at', p.captured_at, 'applied', p.applied, 'platform_fee', p.platform_fee,
           'fee_mode', p.fee_mode, 'refunded_amount', p.refunded_amount,
           'provider', p.provider, 'payment_method', p.payment_method,
           'processing_fee', p.processing_fee, 'platform_fee_collected', p.platform_fee_collected,
           'store_portion', p.store_portion, 'fee_status', p.fee_status,
           'environment', p.environment) order by p.captured_at), '[]'::jsonb)
    into paid from public.payments p where p.order_id = target.id;

  return jsonb_build_object(
    'order_id', target.id, 'store_id', target.store_id, 'reference', target.reference,
    'status', target.status, 'kind', target.kind,
    'created_at', target.created_at, 'paid_at', target.paid_at,
    'product_name', target.product_name, 'quantity', target.quantity, 'unit_price', target.unit_price,
    'subtotal', target.subtotal, 'platform_fee', target.platform_fee, 'total', target.total,
    'deposit_amount', target.deposit_amount, 'amount_paid', target.amount_paid, 'currency', target.currency,
    'refund_status', target.refund_status, 'refunded_amount', target.refunded_amount,
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

revoke all on function public.order_contacts_for(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ grants --

do $$
declare
  fn text;
begin
  -- Server-only: the payment-recorder secret is the authorization.
  foreach fn in array array[
    'public.server_claim_payment_notifications(text, text, integer)',
    'public.server_finish_payment_notification(text, bigint, text, text)',
    'public.server_record_refund(text, text, text, numeric, text, numeric, text, text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;
