-- ===========================================================================
-- SUPERSEDED: the Maya integration in this migration was withdrawn. 0016 removes every Maya
-- object and adds PayMongo (GCash) instead. Kept only because it is applied history.
-- 0015 — A second payment provider (Maya) beside PayPal, in the SAME order,
-- payment, refund and fee system. DFD: P10.
--
-- NOT a second business system. There is still one `orders` table, one
-- `payments` table, one fee rule (10% of the subtotal, computed once per
-- order and split across stages by stage_platform_fee, 0011). What changes:
--
--   * `provider` ('paypal' | 'maya') on payment_attempts, payments and
--     store_payment_accounts, whose key becomes (store, environment,
--     provider). Every PayPal function is re-scoped to provider = 'paypal'
--     and otherwise unchanged.
--
--   * WHO RECEIVES THE MONEY is recorded, because it differs:
--       PayPal       the shop's own PayPal account (0011). FurnishAR's fee
--                    is split by PayPal ('platform_split') or owed by the
--                    shop ('accrual').
--       Maya, platform collect   (the default) the Maya merchant that owns
--                    the API keys: FurnishAR. FurnishAR then holds the whole
--                    payment and OWES THE SHOP its share (fee_mode
--                    'platform_collect'). The shop is paid out by FurnishAR
--                    and that remittance is recorded (store_remittances).
--       Maya PayFac  only when Maya has enabled Payment Facilitator for
--                    FurnishAR AND the shop has a sub-merchant id: Maya
--                    settles to the sub-merchant. Unless the agreement says
--                    Maya deducts FurnishAR's share ('provider_settlement',
--                    set by the server's MAYA_FEE_MODE), the fee is owed by
--                    the shop ('accrual'). Even 'provider_settlement' is
--                    never recorded as COLLECTED: Maya does not report a
--                    per-payment split, so the fee stays "expected via
--                    settlement" until reconciled against Maya's report.
--
--   * A shop is never "connected to Maya" by itself: there is no self-service
--     Maya onboarding into a platform's account. An administrator enables
--     Maya for a store (admin_set_maya_account), recording which settlement
--     applies. The portal shows "Set up by FurnishAR".
--
-- A PayPal capture can never satisfy a Maya attempt, nor the other way round:
-- record_capture checks the attempt's provider.
-- ===========================================================================

-- ------------------------------------------------------ provider columns ----

alter table public.store_payment_accounts drop constraint if exists store_payment_accounts_provider_check;
alter table public.store_payment_accounts add constraint store_payment_accounts_provider_check
  check (provider in ('paypal', 'maya'));
alter table public.store_payment_accounts drop constraint if exists store_payment_accounts_pkey;
alter table public.store_payment_accounts add primary key (store_id, environment, provider);
alter table public.store_payment_accounts
  -- Maya: how this store is paid. Null for PayPal.
  add column if not exists settlement_mode text check (settlement_mode in ('platform_collect', 'payfac')),
  -- Maya PayFac: the store's sub-merchant id / reference as Maya issued it.
  add column if not exists provider_account_ref text check (length(provider_account_ref) <= 64),
  -- Maya PayFac: the sub-merchant's city and postal code, which Maya's PayFac
  -- metadata requires (pf.mci, pf.mpc). The store's address is free text,
  -- so these are recorded explicitly when an admin enables PayFac.
  add column if not exists provider_profile jsonb;

comment on column public.store_payment_accounts.settlement_mode is
  'Maya only: platform_collect = FurnishAR''s Maya account receives the payment and owes the store its share; payfac = Maya settles to the store''s sub-merchant (0015).';

alter table public.payment_attempts
  add column if not exists provider text not null default 'paypal' check (provider in ('paypal', 'maya')),
  -- Maya's requestReferenceNumber: FurnishAR's own reference for the checkout.
  add column if not exists provider_reference text unique check (length(provider_reference) <= 64);
alter table public.payment_attempts drop constraint if exists payment_attempts_fee_mode_check;
alter table public.payment_attempts add constraint payment_attempts_fee_mode_check
  check (fee_mode in ('accrual', 'platform_split', 'platform_collect', 'provider_settlement'));

alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check check (provider in ('paypal', 'maya'));
alter table public.payments drop constraint if exists payments_fee_mode_check;
alter table public.payments add constraint payments_fee_mode_check
  check (fee_mode in ('accrual', 'platform_split', 'platform_collect', 'provider_settlement'));

-- ------------------------------------------------ who can take a payment ----

/* Can this store take a payment through THIS provider, in this environment?
   Public (a product page asks it); answers yes/no only. */
create or replace function public.store_accepts_provider(p_store uuid, p_provider text, p_env text default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.store_payment_accounts a
     where a.store_id = p_store
       and a.provider = p_provider
       and (p_env is null or a.environment = p_env)
       and a.onboarding_status = 'CONNECTED'
       and case a.provider
             when 'paypal' then a.payments_receivable and a.email_confirmed and a.merchant_id is not null
             when 'maya' then a.settlement_mode = 'platform_collect'
                           or (a.settlement_mode = 'payfac' and a.provider_account_ref is not null
                               and a.provider_profile ? 'city' and a.provider_profile ? 'postal')
             else false
           end
  );
$$;

/* Any provider (0011's name, kept: the catalogue and order creation use it). */
create or replace function public.store_accepts_payments(p_store uuid, p_env text default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.store_accepts_provider(p_store, 'paypal', p_env)
      or public.store_accepts_provider(p_store, 'maya', p_env);
$$;

/* Which providers this store can take right now, per the server's
   environment for each. The server intersects this with the providers it
   has configured; the browser only ever sees the result. */
create or replace function public.store_payment_providers(p_store uuid, p_paypal_env text, p_maya_env text)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[
    case when public.store_accepts_provider(p_store, 'paypal', p_paypal_env) then 'paypal' end,
    case when public.store_accepts_provider(p_store, 'maya', p_maya_env) then 'maya' end
  ], null);
$$;

-- --------------------------------------- PayPal functions, provider-scoped --

create or replace function public.server_payment_onboarding_started(
  p_secret text, p_store uuid, p_env text, p_tracking_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_server(p_secret);
  if not public.is_store_member(p_store) then
    raise exception 'Only this store''s owner can connect its PayPal account.' using errcode = '42501';
  end if;
  if p_env not in ('sandbox', 'live') or p_tracking_id is null then
    raise exception 'Unexpected onboarding request.' using errcode = 'check_violation';
  end if;
  insert into public.store_payment_accounts (store_id, environment, provider, tracking_id, onboarding_status, onboarding_started_at, updated_at)
  values (p_store, p_env, 'paypal', p_tracking_id, 'ONBOARDING_STARTED', now(), now())
  on conflict (store_id, environment, provider) do update
     set tracking_id = excluded.tracking_id,
         onboarding_status = case when store_payment_accounts.onboarding_status = 'CONNECTED'
                                  then 'CONNECTED' else 'ONBOARDING_STARTED' end,
         onboarding_started_at = now(), updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.server_record_payment_account(
  p_secret text, p_env text, p_store uuid, p_tracking_id text, p_merchant_id text,
  p_status text, p_receivable boolean, p_email_confirmed boolean, p_partner_fee boolean, p_detail text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  acct public.store_payment_accounts;
  before text;
begin
  perform public.assert_server(p_secret);
  if p_env not in ('sandbox', 'live') then
    raise exception 'Unexpected environment.' using errcode = 'check_violation';
  end if;

  if p_store is not null then
    select * into acct from public.store_payment_accounts
     where store_id = p_store and environment = p_env and provider = 'paypal' for update;
    if not found then
      insert into public.store_payment_accounts (store_id, environment, provider) values (p_store, p_env, 'paypal')
      returning * into acct;
    end if;
  elsif p_tracking_id is not null then
    select * into acct from public.store_payment_accounts
     where tracking_id = p_tracking_id and environment = p_env and provider = 'paypal' for update;
  end if;
  if acct.store_id is null and p_merchant_id is not null then
    select * into acct from public.store_payment_accounts
     where merchant_id = p_merchant_id and environment = p_env and provider = 'paypal' for update;
  end if;
  if acct.store_id is null then
    return jsonb_build_object('found', false);
  end if;

  if p_merchant_id is not null and exists (
    select 1 from public.store_payment_accounts o
     where o.merchant_id = p_merchant_id and o.environment = p_env and o.provider = 'paypal' and o.store_id <> acct.store_id
  ) then
    update public.store_payment_accounts
       set onboarding_status = 'ERROR', status_detail = 'This PayPal account is already connected to another store.',
           last_checked_at = now(), updated_at = now()
     where store_id = acct.store_id and environment = p_env and provider = 'paypal';
    return jsonb_build_object('found', true, 'store_id', acct.store_id, 'before', acct.onboarding_status,
                              'status', 'ERROR', 'conflict', true);
  end if;

  before := acct.onboarding_status;
  update public.store_payment_accounts
     set merchant_id = coalesce(p_merchant_id, merchant_id),
         onboarding_status = p_status,
         payments_receivable = coalesce(p_receivable, false),
         email_confirmed = coalesce(p_email_confirmed, false),
         partner_fee_granted = coalesce(p_partner_fee, false),
         status_detail = nullif(left(coalesce(p_detail, ''), 300), ''),
         connected_at = case when p_status = 'CONNECTED' and before <> 'CONNECTED' then now() else connected_at end,
         last_checked_at = now(), updated_at = now()
   where store_id = acct.store_id and environment = p_env and provider = 'paypal';

  return jsonb_build_object('found', true, 'store_id', acct.store_id, 'before', before, 'status', p_status,
                            'merchant_id', coalesce(p_merchant_id, acct.merchant_id));
end;
$$;

/* Stores that cannot take ANY online payment and are due a PayPal reminder.
   A store that takes Maya is not nagged about PayPal. */
create or replace function public.server_stores_needing_payment_setup(
  p_secret text, p_env text, p_cooldown_hours integer, p_max_count integer
) returns table (store_id uuid, store_name text, status text, reminder_count integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_server(p_secret);
  return query
    select s.id, s.name, coalesce(a.onboarding_status, 'NOT_CONNECTED'), coalesce(a.paypal_reminder_count, 0)
      from public.stores s
      left join public.store_payment_accounts a
        on a.store_id = s.id and a.environment = p_env and a.provider = 'paypal'
     where s.status = 'active'
       and not public.store_accepts_payments(s.id, p_env)
       and coalesce(a.paypal_reminder_count, 0) < greatest(p_max_count, 0)
       and (a.last_paypal_reminder_at is null
            or a.last_paypal_reminder_at < now() - make_interval(hours => greatest(p_cooldown_hours, 1)))
     order by s.created_at;
end;
$$;

create or replace function public.server_mark_payment_reminder(p_secret text, p_store uuid, p_env text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sent integer;
begin
  perform public.assert_server(p_secret);
  insert into public.store_payment_accounts (store_id, environment, provider, last_paypal_reminder_at, paypal_reminder_count)
  values (p_store, p_env, 'paypal', now(), 1)
  on conflict (store_id, environment, provider) do update
     set last_paypal_reminder_at = now(),
         paypal_reminder_count = store_payment_accounts.paypal_reminder_count + 1,
         updated_at = now()
  returning paypal_reminder_count into sent;
  return jsonb_build_object('store_id', p_store, 'count', sent);
end;
$$;

-- ------------------------------------------------------------- paying ------

/* 0011's begin_payment, for a chosen provider. What is due is the same
   whatever the provider; only the payee differs. */
drop function if exists public.begin_payment(uuid, text);

create or replace function public.begin_payment(p_order uuid, p_env text default 'sandbox', p_provider text default 'paypal')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
  acct public.store_payment_accounts;
  store_name text;
  stage text;
  due numeric;
begin
  perform public.release_expired_holds();
  if p_provider not in ('paypal', 'maya') then
    raise exception 'Unknown payment method.' using errcode = 'check_violation';
  end if;
  select * into target from public.orders where id = p_order;
  if not found or target.buyer_id is distinct from auth.uid() then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;

  stage := case target.status
             when 'pending_payment' then 'full'
             when 'quoted'          then 'deposit'
             when 'balance_due'     then 'balance'
           end;
  if stage is null then
    return jsonb_build_object('order_id', target.id, 'reference', target.reference,
                              'stage', null, 'status', target.status);
  end if;

  due := case stage
           when 'full'    then target.total
           when 'deposit' then target.deposit_amount
           else target.total - target.amount_paid
         end;

  select s.name into store_name from public.stores s where s.id = target.store_id;
  select * into acct from public.store_payment_accounts a
   where a.store_id = target.store_id and a.environment = p_env and a.provider = p_provider;
  if not public.store_accepts_provider(target.store_id, p_provider, p_env) then
    raise exception '%', case p_provider when 'maya' then 'This shop cannot take Maya payments yet. Choose another payment method.'
                                          else 'This shop is finishing its PayPal setup and cannot take online payments yet.' end
      using errcode = 'check_violation';
  end if;

  return jsonb_build_object(
    'order_id', target.id, 'reference', target.reference, 'stage', stage,
    'amount', due, 'currency', target.currency,
    'platform_fee', public.stage_platform_fee(target.id, stage),
    'provider', p_provider,
    'merchant_id', acct.merchant_id,
    'partner_fee_granted', acct.partner_fee_granted,
    'settlement_mode', acct.settlement_mode,
    'provider_account_ref', acct.provider_account_ref,
    'provider_profile', acct.provider_profile,
    'store_id', target.store_id,
    'store_name', store_name, 'product_name', target.product_name,
    'hold_expires_at', target.hold_expires_at
  );
end;
$$;

/* The payee recorded for a Maya attempt that settles to FurnishAR itself. */
create or replace function public.maya_platform_payee()
returns text language sql immutable as $$ select 'furnishar-platform' $$;

drop function if exists public.server_record_payment_attempt(text, uuid, text, text, text, numeric, numeric, text, text);

create or replace function public.server_record_payment_attempt(
  p_secret text, p_order uuid, p_stage text, p_env text, p_provider_order text,
  p_amount numeric, p_platform_fee numeric, p_fee_mode text, p_merchant text,
  p_provider text default 'paypal', p_reference text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
  acct public.store_payment_accounts;
begin
  perform public.assert_server(p_secret);
  select * into target from public.orders where id = p_order;
  if not found or target.buyer_id is distinct from auth.uid() then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  if public.money(p_platform_fee) <> public.money(public.stage_platform_fee(p_order, p_stage)) then
    raise exception 'Unexpected fee.' using errcode = 'check_violation';
  end if;
  if p_provider = 'paypal' then
    if p_fee_mode not in ('accrual', 'platform_split') or not exists (
         select 1 from public.store_payment_accounts a
          where a.store_id = target.store_id and a.environment = p_env and a.provider = 'paypal'
            and a.merchant_id = p_merchant and a.onboarding_status = 'CONNECTED') then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
  elsif p_provider = 'maya' then
    select * into acct from public.store_payment_accounts a
     where a.store_id = target.store_id and a.environment = p_env and a.provider = 'maya';
    if not public.store_accepts_provider(target.store_id, 'maya', p_env)
       or p_reference is null
       -- The payee and the fee mode must be what this store's Maya setup says.
       or (acct.settlement_mode = 'platform_collect'
           and (p_merchant <> public.maya_platform_payee() or p_fee_mode <> 'platform_collect'))
       or (acct.settlement_mode = 'payfac'
           and (p_merchant is distinct from acct.provider_account_ref or p_fee_mode not in ('accrual', 'provider_settlement'))) then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
  else
    raise exception 'Unknown payment method.' using errcode = 'check_violation';
  end if;

  insert into public.payment_attempts (order_id, store_id, stage, environment, provider_order_id, amount,
                                       currency, platform_fee, fee_mode, payee_merchant_id, provider, provider_reference)
  values (p_order, target.store_id, p_stage, p_env, p_provider_order, public.money(p_amount),
          target.currency, public.money(p_platform_fee), p_fee_mode, p_merchant, p_provider, p_reference)
  on conflict (provider_order_id) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

/* A Maya attempt by FurnishAR's own reference (requestReferenceNumber). */
create or replace function public.server_payment_attempt_by_reference(p_secret text, p_provider text, p_reference text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a public.payment_attempts;
begin
  perform public.assert_server(p_secret);
  select * into a from public.payment_attempts where provider = p_provider and provider_reference = p_reference;
  if not found then return null; end if;
  return to_jsonb(a);
end;
$$;

/*
  0011's record_capture, provider-aware. For PayPal, unchanged. For Maya:
    - there is always an attempt (no legacy path), of provider 'maya';
    - the payee must be the attempt's payee;
    - fee_mode is the attempt's: 'platform_collect' records the fee as
      collected (FurnishAR's Maya account received the whole payment) and
      the store's share as owed to the store; 'accrual' and
      'provider_settlement' record nothing as collected.
  A capture recorded under one provider can never satisfy another's attempt.
*/
drop function if exists public.record_capture(text, uuid, text, text, text, numeric, text, text, text, text, text, numeric, text);

create or replace function public.record_capture(
  p_secret text, p_order uuid, p_stage text, p_provider_order text, p_capture text,
  p_amount numeric, p_currency text, p_payee text, p_payer_email text,
  p_payee_merchant text default null, p_fee_mode text default 'accrual',
  p_fee_collected numeric default null, p_env text default null,
  p_provider text default 'paypal'
) returns jsonb
language plpgsql
security definer
set search_path = public, billing_private
as $$
declare
  target public.orders;
  attempt public.payment_attempts;
  legacy_payee text;
  due numeric;
  fee numeric;
  mode text;
  collected numeric;
  applied boolean := false;
  next_status public.order_status;
  existing public.payments;
  shelf integer;
begin
  perform public.assert_server(p_secret);
  if p_provider not in ('paypal', 'maya') then
    raise exception 'Unknown payment method.' using errcode = 'check_violation';
  end if;

  select * into existing from public.payments where capture_id = p_capture;
  if found then
    if existing.provider <> p_provider then
      raise exception 'That payment belongs to another payment method.' using errcode = 'check_violation';
    end if;
    select * into target from public.orders where id = existing.order_id;
    return jsonb_build_object('order_id', target.id, 'status', target.status,
                              'applied', existing.applied, 'duplicate', true);
  end if;

  select * into target from public.orders where id = p_order for update;
  if not found or (auth.uid() is not null and target.buyer_id is distinct from auth.uid()) then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  if p_stage not in ('full', 'deposit', 'balance') or p_currency <> target.currency then
    raise exception 'Unexpected payment.' using errcode = 'check_violation';
  end if;

  select * into attempt from public.payment_attempts where provider_order_id = p_provider_order;
  if attempt.id is not null then
    if attempt.provider <> p_provider or attempt.order_id <> target.id or attempt.stage <> p_stage
       or p_payee_merchant is distinct from attempt.payee_merchant_id then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
    if p_provider = 'paypal' and not exists (select 1 from public.store_payment_accounts a
                       where a.store_id = target.store_id and a.environment = attempt.environment
                         and a.provider = 'paypal' and a.merchant_id = p_payee_merchant) then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
  elsif p_provider = 'maya' then
    raise exception 'Unknown Maya payment.' using errcode = 'check_violation';
  else
    -- A PayPal order from before 0011: it named the shop's email as payee.
    select paypal_email into legacy_payee from public.store_payout where store_id = target.store_id;
    if legacy_payee is null or lower(coalesce(p_payee, '')) <> lower(legacy_payee) then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
  end if;

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
  fee := case when applied then public.stage_platform_fee(target.id, p_stage) else 0 end;

  if p_provider = 'paypal' then
    -- Split only when PayPal says it took exactly the fee; anything else accrues.
    mode := case when applied and p_fee_mode = 'platform_split'
                      and p_fee_collected is not null and public.money(p_fee_collected) = public.money(fee)
                 then 'platform_split' else 'accrual' end;
    collected := case when p_fee_collected is not null then public.money(p_fee_collected) end;
  else
    mode := attempt.fee_mode;
    -- Only platform collect puts FurnishAR's fee in FurnishAR's hands (it
    -- received the whole payment). Nothing else is claimed as collected.
    collected := case when mode = 'platform_collect' and applied then fee end;
  end if;

  insert into public.payments (
    order_id, store_id, stage, provider, provider_order_id, capture_id, amount, platform_fee,
    currency, payee_email, payer_email, applied,
    payee_merchant_id, fee_mode, platform_fee_collected, environment
  ) values (
    target.id, target.store_id, p_stage, p_provider, p_provider_order, p_capture, public.money(p_amount), fee,
    p_currency, nullif(lower(coalesce(p_payee, '')), ''), nullif(left(p_payer_email, 254), ''), applied,
    p_payee_merchant, mode, collected,
    coalesce(p_env, attempt.environment)
  );

  if applied then
    update public.orders
       set status = next_status,
           amount_paid = public.money(amount_paid + p_amount),
           hold_expires_at = null,
           paid_at = case when next_status = 'paid' then now() else paid_at end
     where id = target.id;
  end if;

  update public.payment_attempts
     set status = 'CAPTURED', capture_id = p_capture, updated_at = now()
   where provider_order_id = p_provider_order;

  return jsonb_build_object('order_id', target.id,
                            'status', coalesce(next_status, target.status),
                            'applied', applied, 'duplicate', false,
                            'platform_fee', fee, 'fee_mode', mode, 'provider', p_provider);
end;
$$;

-- ------------------------------------------------ Maya setup, by an admin --

/*
  Enables (or disables) Maya for a store. Admin only: there is no
  self-service Maya onboarding into FurnishAR's account. 'payfac' needs the
  store's sub-merchant reference as Maya issued it; 'platform_collect' needs
  nothing, because FurnishAR's own Maya account receives the payment.
*/
create or replace function public.admin_set_maya_account(
  p_store uuid, p_env text, p_enabled boolean, p_settlement text, p_submerchant text default null,
  p_city text default null, p_postal text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator can set up Maya for a store.' using errcode = '42501';
  end if;
  if p_env not in ('sandbox', 'live') then
    raise exception 'Unexpected environment.' using errcode = 'check_violation';
  end if;
  if p_enabled and p_settlement not in ('platform_collect', 'payfac') then
    raise exception 'Choose how the store is paid through Maya.' using errcode = 'check_violation';
  end if;
  if p_enabled and p_settlement = 'payfac' and nullif(btrim(coalesce(p_submerchant, '')), '') is null then
    raise exception 'Enter the store''s Maya sub-merchant ID.' using errcode = 'check_violation';
  end if;
  if p_enabled and p_settlement = 'payfac'
     and (nullif(btrim(coalesce(p_city, '')), '') is null or coalesce(p_postal, '') !~ '^\d{4}$') then
    raise exception 'Enter the store''s city and 4-digit postal code, as registered with Maya.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'Unknown store.' using errcode = 'no_data_found';
  end if;

  insert into public.store_payment_accounts (store_id, environment, provider, onboarding_status, payments_receivable,
                                             settlement_mode, provider_account_ref, provider_profile,
                                             status_detail, connected_at, updated_at)
  values (p_store, p_env, 'maya', case when p_enabled then 'CONNECTED' else 'NOT_CONNECTED' end, p_enabled,
          case when p_enabled then p_settlement end,
          case when p_enabled and p_settlement = 'payfac' then left(btrim(p_submerchant), 64) end,
          case when p_enabled and p_settlement = 'payfac'
               then jsonb_build_object('city', left(btrim(p_city), 60), 'postal', p_postal, 'country', 'PHL') end,
          case when p_enabled then 'Set up by FurnishAR.' else 'Maya is not set up for this store.' end,
          case when p_enabled then now() end, now())
  on conflict (store_id, environment, provider) do update
     set onboarding_status = excluded.onboarding_status,
         payments_receivable = excluded.payments_receivable,
         settlement_mode = excluded.settlement_mode,
         provider_account_ref = excluded.provider_account_ref,
         provider_profile = excluded.provider_profile,
         status_detail = excluded.status_detail,
         connected_at = coalesce(excluded.connected_at, store_payment_accounts.connected_at),
         updated_at = now();

  select email into actor_email from auth.users where id = auth.uid();
  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, case when p_enabled then 'maya.enabled' else 'maya.disabled' end, p_store,
          jsonb_build_object('environment', p_env, 'settlement', p_settlement,
                             'submerchant_set', p_submerchant is not null));
  return jsonb_build_object('store_id', p_store, 'enabled', p_enabled, 'settlement', p_settlement);
end;
$$;

-- --------------------------------------- money FurnishAR owes a store -------

/* Payouts FurnishAR made to a store for Maya payments it collected
   (platform collect). The mirror of fee_settlements (money a store paid
   FurnishAR). Admin-recorded; read by the store and admins. */
create table if not exists public.store_remittances (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete restrict,
  amount      numeric(12,2) not null check (amount > 0),
  reference   text check (length(reference) <= 120),
  note        text check (length(note) <= 500),
  recorded_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists store_remittances_store_idx on public.store_remittances (store_id, created_at desc);
alter table public.store_remittances enable row level security;
drop policy if exists store_remittances_party_read on public.store_remittances;
create policy store_remittances_party_read on public.store_remittances
  for select using (public.is_store_member(store_id) or public.is_platform_admin());
revoke all on public.store_remittances from anon;
revoke insert, update, delete, truncate, references, trigger on public.store_remittances from authenticated;
grant select on public.store_remittances to authenticated;

create or replace function public.record_store_remittance(p_store uuid, p_amount numeric, p_reference text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor_email text;
  created public.store_remittances;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may record a payout.' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then
    raise exception 'Enter an amount between ₱1 and ₱10,000,000.' using errcode = 'check_violation';
  end if;
  insert into public.store_remittances (store_id, amount, reference, note, recorded_by)
  values (p_store, public.money(p_amount), nullif(left(btrim(coalesce(p_reference, '')), 120), ''),
          nullif(left(btrim(coalesce(p_note, '')), 500), ''), auth.uid())
  returning * into created;
  select email into actor_email from auth.users where id = auth.uid();
  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, 'store.remittance_recorded', p_store,
          jsonb_build_object('amount', created.amount, 'reference', created.reference));
  return jsonb_build_object('id', created.id, 'amount', created.amount);
end;
$$;

-- ---------------------------------------------------------- fee summaries --
/*
  accrued       the store owes FurnishAR (accrual: the store received it)
  collected     FurnishAR has it: PayPal reported the split, or Maya platform
                collect put the whole payment in FurnishAR's account
  expected      Maya PayFac with provider_settlement: due via Maya's
                settlement, not yet reconciled
  owed_to_store FurnishAR owes the store (Maya platform collect: the store's
                share, less refunds), minus payouts recorded
*/
create or replace function public.store_fee_summary(p_store uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  accrued numeric;
  collected numeric;
  expected numeric;
  share numeric;
  settled numeric;
  remitted numeric;
begin
  if not (public.is_store_member(p_store) or public.is_platform_admin()) then
    raise exception 'Not your store.' using errcode = '42501';
  end if;
  select coalesce(sum(platform_fee - refunded_platform_fee) filter (where fee_mode = 'accrual'), 0),
         coalesce(sum(coalesce(platform_fee_collected, 0) - refunded_platform_fee) filter (where fee_mode in ('platform_split', 'platform_collect')), 0),
         coalesce(sum(platform_fee - refunded_platform_fee) filter (where fee_mode = 'provider_settlement'), 0),
         coalesce(sum((amount - refunded_amount) - (platform_fee - refunded_platform_fee)) filter (where fee_mode = 'platform_collect'), 0)
    into accrued, collected, expected, share
    from public.payments where store_id = p_store and applied;
  select coalesce(sum(amount), 0) into settled from public.fee_settlements where store_id = p_store;
  select coalesce(sum(amount), 0) into remitted from public.store_remittances where store_id = p_store;
  return jsonb_build_object('store_id', p_store, 'accrued', accrued, 'collected', collected,
                            'expected_via_settlement', expected,
                            'settled', settled, 'outstanding', accrued - settled,
                            'owed_to_store', share - remitted, 'remitted', remitted,
                            'fee_rate', public.platform_fee_rate());
end;
$$;

drop function if exists public.fee_overview();

create or replace function public.fee_overview()
returns table (store_id uuid, store_name text, fulfilment public.store_fulfilment,
               sales numeric, accrued numeric, collected numeric, refunded numeric,
               settled numeric, outstanding numeric,
               payment_status text, payment_environment text, merchant_id_masked text,
               paypal_sales numeric, maya_sales numeric, expected_via_settlement numeric,
               owed_to_store numeric, maya_status text, maya_settlement text)
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
           coalesce(p.sales, 0), coalesce(p.accrued, 0), coalesce(p.collected, 0), coalesce(p.refunded, 0),
           coalesce(f.settled, 0), coalesce(p.accrued, 0) - coalesce(f.settled, 0),
           coalesce(a.onboarding_status, 'NOT_CONNECTED'), a.environment,
           case when a.merchant_id is null then null
                else repeat('•', greatest(length(a.merchant_id) - 4, 0)) || right(a.merchant_id, 4) end,
           coalesce(p.paypal_sales, 0), coalesce(p.maya_sales, 0), coalesce(p.expected, 0),
           coalesce(p.share, 0) - coalesce(r.remitted, 0),
           coalesce(m.onboarding_status, 'NOT_CONNECTED'), m.settlement_mode
      from public.stores s
      left join (select pa.store_id,
                        sum(pa.amount - pa.refunded_amount) as sales,
                        sum(pa.amount - pa.refunded_amount) filter (where pa.provider = 'paypal') as paypal_sales,
                        sum(pa.amount - pa.refunded_amount) filter (where pa.provider = 'maya') as maya_sales,
                        sum(pa.platform_fee - pa.refunded_platform_fee) filter (where pa.fee_mode = 'accrual') as accrued,
                        sum(coalesce(pa.platform_fee_collected, 0) - pa.refunded_platform_fee)
                          filter (where pa.fee_mode in ('platform_split', 'platform_collect')) as collected,
                        sum(pa.platform_fee - pa.refunded_platform_fee) filter (where pa.fee_mode = 'provider_settlement') as expected,
                        sum((pa.amount - pa.refunded_amount) - (pa.platform_fee - pa.refunded_platform_fee))
                          filter (where pa.fee_mode = 'platform_collect') as share,
                        sum(pa.refunded_amount) as refunded
                   from public.payments pa where pa.applied group by pa.store_id) p on p.store_id = s.id
      left join (select fs.store_id, sum(fs.amount) as settled
                   from public.fee_settlements fs group by fs.store_id) f on f.store_id = s.id
      left join (select sr.store_id, sum(sr.amount) as remitted
                   from public.store_remittances sr group by sr.store_id) r on r.store_id = s.id
      left join lateral (select * from public.store_payment_accounts spa
                          where spa.store_id = s.id and spa.provider = 'paypal'
                          order by spa.updated_at desc limit 1) a on true
      left join lateral (select * from public.store_payment_accounts spm
                          where spm.store_id = s.id and spm.provider = 'maya'
                          order by spm.updated_at desc limit 1) m on true
     order by coalesce(p.accrued, 0) - coalesce(f.settled, 0) desc, s.name;
end;
$$;

-- ----------------------------------------------------- receipts & emails ---

/* 0011's order_contacts_for, with each payment's provider (receipts and
   emails say "Paid via PayPal" or "Paid via Maya" from the record). */
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
           'provider', p.provider) order by p.captured_at), '[]'::jsonb)
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
  foreach fn in array array[
    'public.begin_payment(uuid, text, text)',
    'public.store_fee_summary(uuid)',
    'public.fee_overview()',
    'public.admin_set_maya_account(uuid, text, boolean, text, text, text, text)',
    'public.record_store_remittance(uuid, numeric, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;

  foreach fn in array array[
    'public.store_accepts_provider(uuid, text, text)',
    'public.store_accepts_payments(uuid, text)',
    'public.store_payment_providers(uuid, text, text)'
  ] loop
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;

  -- Server-only: the secret is the authorization.
  foreach fn in array array[
    'public.server_payment_onboarding_started(text, uuid, text, text)',
    'public.server_record_payment_account(text, text, uuid, text, text, text, boolean, boolean, boolean, text)',
    'public.server_stores_needing_payment_setup(text, text, integer, integer)',
    'public.server_mark_payment_reminder(text, uuid, text)',
    'public.server_record_payment_attempt(text, uuid, text, text, text, numeric, numeric, text, text, text, text)',
    'public.server_payment_attempt_by_reference(text, text, text)',
    'public.record_capture(text, uuid, text, text, text, numeric, text, text, text, text, text, numeric, text, text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;
