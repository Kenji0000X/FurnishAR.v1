-- ===========================================================================
-- 0016 — PayMongo (GCash) replaces Maya as FurnishAR's second payment
-- provider. DFD: P10.
--
-- 0015 added Maya beside PayPal. That plan is withdrawn: every Maya object it
-- created is removed here (no store ever had Maya enabled, and no Maya
-- payment exists — this migration refuses to run if one does). The provider
-- boundary 0015 introduced stays: one orders table, one payments table, one
-- fee rule (10% of the subtotal, computed once per order, split across
-- stages by stage_platform_fee).
--
--   provider        'paypal' | 'paymongo'    who processed the payment
--   payment_method  'paypal' | 'gcash'       what the buyer paid with
--
-- GCash is a PayMongo payment METHOD, not a provider of its own: FurnishAR
-- talks to PayMongo with PayMongo's keys, and PayMongo offers GCash.
--
-- WHO RECEIVES THE MONEY, per store (store_payment_accounts, provider
-- 'paymongo', set by an admin — PayMongo has no self-service onboarding into
-- a platform's account):
--   'platform'  (default) the PayMongo account that owns the API keys —
--               FurnishAR's — receives the payment, less PayMongo's
--               processing fee. FurnishAR's 10% is recorded as ACCRUED and
--               HELD (fee_mode 'platform_held'), never as "collected by a
--               split", and the store's share is OWED to the store until a
--               payout is recorded (store_remittances, 0015).
--   'split'     only when PayMongo has activated Split Payments for
--               FurnishAR and configured the store as a child merchant
--               (provider_account_ref). The store's portion is transferred by
--               PayMongo; FurnishAR's portion is EXPECTED via the split
--               (fee_mode 'provider_split') until reconciled against
--               PayMongo's records — never recorded as collected from the
--               request alone.
--
-- PayMongo's processing fee is recorded per payment when PayMongo reports it
-- (payments.processing_fee), so settlement reports never promise the store an
-- amount PayMongo did not pay out.
-- ===========================================================================

-- ------------------------------------------- remove every trace of Maya ----

do $$
begin
  if exists (select 1 from public.payments where provider = 'maya')
     or exists (select 1 from public.payment_attempts where provider = 'maya') then
    raise exception 'Maya payments exist; they must be reconciled by hand before 0016.';
  end if;
end $$;

delete from public.store_payment_accounts where provider = 'maya';

drop function if exists public.admin_set_maya_account(uuid, text, boolean, text, text, text, text);
drop function if exists public.maya_platform_payee();

-- ------------------------------------------------------ provider columns ----

alter table public.store_payment_accounts drop constraint if exists store_payment_accounts_provider_check;
alter table public.store_payment_accounts add constraint store_payment_accounts_provider_check
  check (provider in ('paypal', 'paymongo'));
alter table public.store_payment_accounts drop constraint if exists store_payment_accounts_settlement_mode_check;
update public.store_payment_accounts set settlement_mode = null where settlement_mode is not null;
alter table public.store_payment_accounts add constraint store_payment_accounts_settlement_mode_check
  check (settlement_mode in ('platform', 'split'));
alter table public.store_payment_accounts drop column if exists provider_profile;
comment on column public.store_payment_accounts.settlement_mode is
  'PayMongo only: platform = FurnishAR''s PayMongo account receives the payment and owes the store its share; split = PayMongo Split Payments to the store''s child merchant (provider_account_ref) (0016).';
comment on column public.store_payment_accounts.provider_account_ref is
  'PayMongo only, split mode: the store''s child-merchant id as PayMongo issued it (0016).';

alter table public.payment_attempts drop constraint if exists payment_attempts_provider_check;
alter table public.payment_attempts add constraint payment_attempts_provider_check check (provider in ('paypal', 'paymongo'));
alter table public.payment_attempts
  add column if not exists payment_method text not null default 'paypal' check (payment_method in ('paypal', 'gcash'));
alter table public.payment_attempts drop constraint if exists payment_attempts_fee_mode_check;
alter table public.payment_attempts add constraint payment_attempts_fee_mode_check
  check (fee_mode in ('accrual', 'platform_split', 'platform_held', 'provider_split'));
comment on column public.payment_attempts.provider_reference is
  'PayMongo: FurnishAR''s reference_number for the checkout session (0016).';

alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check check (provider in ('paypal', 'paymongo'));
alter table public.payments
  add column if not exists payment_method text not null default 'paypal' check (payment_method in ('paypal', 'gcash')),
  -- What the provider reported deducting as its processing fee, when it did.
  add column if not exists processing_fee numeric(12,2) check (processing_fee >= 0);
alter table public.payments drop constraint if exists payments_fee_mode_check;
alter table public.payments add constraint payments_fee_mode_check
  check (fee_mode in ('accrual', 'platform_split', 'platform_held', 'provider_split'));

-- ------------------------------------------------ who can take a payment ----

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
             when 'paymongo' then a.settlement_mode = 'platform'
                               or (a.settlement_mode = 'split' and a.provider_account_ref is not null)
             else false
           end
  );
$$;

create or replace function public.store_accepts_payments(p_store uuid, p_env text default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.store_accepts_provider(p_store, 'paypal', p_env)
      or public.store_accepts_provider(p_store, 'paymongo', p_env);
$$;

drop function if exists public.store_payment_providers(uuid, text, text);

create or replace function public.store_payment_providers(p_store uuid, p_paypal_env text, p_paymongo_env text)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[
    case when public.store_accepts_provider(p_store, 'paypal', p_paypal_env) then 'paypal' end,
    case when public.store_accepts_provider(p_store, 'paymongo', p_paymongo_env) then 'paymongo' end
  ], null);
$$;

-- ------------------------------------------------------------- paying ------

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
  if p_provider not in ('paypal', 'paymongo') then
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
    raise exception '%', case p_provider when 'paymongo' then 'This shop cannot take GCash payments yet. Choose another payment method.'
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
    'store_id', target.store_id,
    'store_name', store_name, 'product_name', target.product_name,
    'hold_expires_at', target.hold_expires_at
  );
end;
$$;

/* The payee recorded for a PayMongo attempt that settles to FurnishAR's own
   PayMongo account (settlement 'platform'). */
create or replace function public.paymongo_platform_payee()
returns text language sql immutable as $$ select 'furnishar-paymongo' $$;

drop function if exists public.server_record_payment_attempt(text, uuid, text, text, text, numeric, numeric, text, text, text, text);

create or replace function public.server_record_payment_attempt(
  p_secret text, p_order uuid, p_stage text, p_env text, p_provider_order text,
  p_amount numeric, p_platform_fee numeric, p_fee_mode text, p_merchant text,
  p_provider text default 'paypal', p_reference text default null, p_method text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
  acct public.store_payment_accounts;
  method text := coalesce(p_method, case p_provider when 'paymongo' then 'gcash' else 'paypal' end);
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
    if method <> 'paypal' or p_fee_mode not in ('accrual', 'platform_split') or not exists (
         select 1 from public.store_payment_accounts a
          where a.store_id = target.store_id and a.environment = p_env and a.provider = 'paypal'
            and a.merchant_id = p_merchant and a.onboarding_status = 'CONNECTED') then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
  elsif p_provider = 'paymongo' then
    select * into acct from public.store_payment_accounts a
     where a.store_id = target.store_id and a.environment = p_env and a.provider = 'paymongo';
    if method <> 'gcash'
       or not public.store_accepts_provider(target.store_id, 'paymongo', p_env)
       or p_reference is null
       -- The payee and the fee mode must be what this store's PayMongo setup says.
       or (acct.settlement_mode = 'platform'
           and (p_merchant <> public.paymongo_platform_payee() or p_fee_mode <> 'platform_held'))
       or (acct.settlement_mode = 'split'
           and (p_merchant is distinct from acct.provider_account_ref or p_fee_mode <> 'provider_split')) then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
  else
    raise exception 'Unknown payment method.' using errcode = 'check_violation';
  end if;

  insert into public.payment_attempts (order_id, store_id, stage, environment, provider_order_id, amount,
                                       currency, platform_fee, fee_mode, payee_merchant_id, provider,
                                       provider_reference, payment_method)
  values (p_order, target.store_id, p_stage, p_env, p_provider_order, public.money(p_amount),
          target.currency, public.money(p_platform_fee), p_fee_mode, p_merchant, p_provider,
          p_reference, method)
  on conflict (provider_order_id) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

/*
  record_capture, provider-aware (0011, 0015). PayPal is unchanged. PayMongo:
    - there is always an attempt of provider 'paymongo';
    - the payee must be the attempt's payee;
    - fee_mode is the attempt's; nothing is recorded as COLLECTED:
      'platform_held' is accrued and held in FurnishAR's PayMongo balance,
      'provider_split' is expected via PayMongo's split until reconciled;
    - PayMongo's processing fee is recorded when PayMongo reports it.
  A capture recorded under one provider can never satisfy another's attempt,
  and a second successful payment for a stage already paid is recorded but
  never applied (the order is paid once).
*/
drop function if exists public.record_capture(text, uuid, text, text, text, numeric, text, text, text, text, text, numeric, text, text);

create or replace function public.record_capture(
  p_secret text, p_order uuid, p_stage text, p_provider_order text, p_capture text,
  p_amount numeric, p_currency text, p_payee text, p_payer_email text,
  p_payee_merchant text default null, p_fee_mode text default 'accrual',
  p_fee_collected numeric default null, p_env text default null,
  p_provider text default 'paypal', p_processing_fee numeric default null
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
  if p_provider not in ('paypal', 'paymongo') then
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
  elsif p_provider = 'paymongo' then
    raise exception 'Unknown PayMongo payment.' using errcode = 'check_violation';
  else
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
    mode := case when applied and p_fee_mode = 'platform_split'
                      and p_fee_collected is not null and public.money(p_fee_collected) = public.money(fee)
                 then 'platform_split' else 'accrual' end;
    collected := case when p_fee_collected is not null then public.money(p_fee_collected) end;
  else
    mode := attempt.fee_mode;
    collected := null;   -- held or expected, never "collected" on PayMongo's say-so alone
  end if;

  insert into public.payments (
    order_id, store_id, stage, provider, provider_order_id, capture_id, amount, platform_fee,
    currency, payee_email, payer_email, applied,
    payee_merchant_id, fee_mode, platform_fee_collected, environment,
    payment_method, processing_fee
  ) values (
    target.id, target.store_id, p_stage, p_provider, p_provider_order, p_capture, public.money(p_amount), fee,
    p_currency, nullif(lower(coalesce(p_payee, '')), ''), nullif(left(p_payer_email, 254), ''), applied,
    p_payee_merchant, mode, collected,
    coalesce(p_env, attempt.environment),
    coalesce(attempt.payment_method, case p_provider when 'paymongo' then 'gcash' else 'paypal' end),
    case when p_processing_fee is not null and p_processing_fee >= 0 then public.money(p_processing_fee) end
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

-- ----------------------------------------------- PayMongo setup, by an admin

/*
  Enables (or disables) GCash via PayMongo for a store. Admin only: PayMongo
  child merchants are arranged with PayMongo, not connected by the store.
  'split' needs the store's child-merchant id as PayMongo issued it.
*/
create or replace function public.admin_set_paymongo_account(
  p_store uuid, p_env text, p_enabled boolean, p_settlement text, p_child_merchant text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator can set up GCash for a store.' using errcode = '42501';
  end if;
  if p_env not in ('sandbox', 'live') then
    raise exception 'Unexpected environment.' using errcode = 'check_violation';
  end if;
  if p_enabled and p_settlement not in ('platform', 'split') then
    raise exception 'Choose how the store is paid for GCash payments.' using errcode = 'check_violation';
  end if;
  if p_enabled and p_settlement = 'split' and nullif(btrim(coalesce(p_child_merchant, '')), '') is null then
    raise exception 'Enter the store''s PayMongo child-merchant ID.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'Unknown store.' using errcode = 'no_data_found';
  end if;

  insert into public.store_payment_accounts (store_id, environment, provider, onboarding_status, payments_receivable,
                                             settlement_mode, provider_account_ref,
                                             status_detail, connected_at, updated_at)
  values (p_store, p_env, 'paymongo', case when p_enabled then 'CONNECTED' else 'NOT_CONNECTED' end, p_enabled,
          case when p_enabled then p_settlement end,
          case when p_enabled and p_settlement = 'split' then left(btrim(p_child_merchant), 64) end,
          case when p_enabled then 'Set up by FurnishAR.' else 'GCash is not set up for this store.' end,
          case when p_enabled then now() end, now())
  on conflict (store_id, environment, provider) do update
     set onboarding_status = excluded.onboarding_status,
         payments_receivable = excluded.payments_receivable,
         settlement_mode = excluded.settlement_mode,
         provider_account_ref = excluded.provider_account_ref,
         status_detail = excluded.status_detail,
         connected_at = coalesce(excluded.connected_at, store_payment_accounts.connected_at),
         updated_at = now();

  select email into actor_email from auth.users where id = auth.uid();
  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, case when p_enabled then 'paymongo.enabled' else 'paymongo.disabled' end, p_store,
          jsonb_build_object('environment', p_env, 'settlement', p_settlement,
                             'child_merchant_set', p_child_merchant is not null));
  return jsonb_build_object('store_id', p_store, 'enabled', p_enabled, 'settlement', p_settlement);
end;
$$;

-- ---------------------------------------------------------- fee summaries --
/*
  accrued        the store owes FurnishAR (accrual: the store received it)
  collected      PayPal reported taking the fee (platform_split)
  held           PayMongo 'platform': the fee is accrued and sits in
                 FurnishAR's PayMongo balance with the rest of the payment
  expected_via_split  PayMongo 'split': FurnishAR's portion, not reconciled
  processing_fees     what providers reported deducting
  owed_to_store  PayMongo 'platform': the store's share (paid amount less the
                 fee, less refunds), minus payouts recorded. Before any
                 processing fee: who absorbs that is shown separately.
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
  held numeric;
  expected numeric;
  processing numeric;
  share numeric;
  settled numeric;
  remitted numeric;
begin
  if not (public.is_store_member(p_store) or public.is_platform_admin()) then
    raise exception 'Not your store.' using errcode = '42501';
  end if;
  select coalesce(sum(platform_fee - refunded_platform_fee) filter (where fee_mode = 'accrual'), 0),
         coalesce(sum(coalesce(platform_fee_collected, 0) - refunded_platform_fee) filter (where fee_mode = 'platform_split'), 0),
         coalesce(sum(platform_fee - refunded_platform_fee) filter (where fee_mode = 'platform_held'), 0),
         coalesce(sum(platform_fee - refunded_platform_fee) filter (where fee_mode = 'provider_split'), 0),
         coalesce(sum(processing_fee), 0),
         coalesce(sum((amount - refunded_amount) - (platform_fee - refunded_platform_fee)) filter (where fee_mode = 'platform_held'), 0)
    into accrued, collected, held, expected, processing, share
    from public.payments where store_id = p_store and applied;
  select coalesce(sum(amount), 0) into settled from public.fee_settlements where store_id = p_store;
  select coalesce(sum(amount), 0) into remitted from public.store_remittances where store_id = p_store;
  return jsonb_build_object('store_id', p_store, 'accrued', accrued, 'collected', collected,
                            'held', held, 'expected_via_split', expected, 'processing_fees', processing,
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
               paypal_sales numeric, gcash_sales numeric, held numeric, expected_via_split numeric,
               processing_fees numeric, owed_to_store numeric, paymongo_status text, paymongo_settlement text)
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
           coalesce(p.paypal_sales, 0), coalesce(p.gcash_sales, 0), coalesce(p.held, 0), coalesce(p.expected, 0),
           coalesce(p.processing, 0),
           coalesce(p.share, 0) - coalesce(r.remitted, 0),
           coalesce(m.onboarding_status, 'NOT_CONNECTED'), m.settlement_mode
      from public.stores s
      left join (select pa.store_id,
                        sum(pa.amount - pa.refunded_amount) as sales,
                        sum(pa.amount - pa.refunded_amount) filter (where pa.provider = 'paypal') as paypal_sales,
                        sum(pa.amount - pa.refunded_amount) filter (where pa.payment_method = 'gcash') as gcash_sales,
                        sum(pa.platform_fee - pa.refunded_platform_fee) filter (where pa.fee_mode = 'accrual') as accrued,
                        sum(coalesce(pa.platform_fee_collected, 0) - pa.refunded_platform_fee)
                          filter (where pa.fee_mode = 'platform_split') as collected,
                        sum(pa.platform_fee - pa.refunded_platform_fee) filter (where pa.fee_mode = 'platform_held') as held,
                        sum(pa.platform_fee - pa.refunded_platform_fee) filter (where pa.fee_mode = 'provider_split') as expected,
                        sum(pa.processing_fee) as processing,
                        sum((pa.amount - pa.refunded_amount) - (pa.platform_fee - pa.refunded_platform_fee))
                          filter (where pa.fee_mode = 'platform_held') as share,
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
                          where spm.store_id = s.id and spm.provider = 'paymongo'
                          order by spm.updated_at desc limit 1) m on true
     order by coalesce(p.accrued, 0) - coalesce(f.settled, 0) desc, s.name;
end;
$$;

comment on table public.store_remittances is
  'Payouts FurnishAR made to a store for GCash payments its PayMongo account received (settlement platform) (0015, 0016).';

-- ----------------------------------------------------- receipts & emails ---

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
           'processing_fee', p.processing_fee) order by p.captured_at), '[]'::jsonb)
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
    'public.admin_set_paymongo_account(uuid, text, boolean, text, text)',
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
    'public.server_record_payment_attempt(text, uuid, text, text, text, numeric, numeric, text, text, text, text, text)',
    'public.server_payment_attempt_by_reference(text, text, text)',
    'public.record_capture(text, uuid, text, text, text, numeric, text, text, text, text, text, numeric, text, text, numeric)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;
