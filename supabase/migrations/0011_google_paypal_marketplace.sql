-- ===========================================================================
-- Google sign-in onboarding, PayPal seller connection, the platform fee
-- modes, payment states, webhooks, refunds and payment-setup reminders.
--                                              DFD: P1, P7, P8, P10 / D1, D4, D5
--
-- Additive and safe on existing data:
--   - new tables and columns only, every column nullable or defaulted;
--   - functions replaced in place (same name). Where a signature had to
--     change, the old one is dropped first so PostgREST does not see two;
--   - no order, payment or settlement row is rewritten.
--
-- TWO ACCOUNT SYSTEMS, NOT ONE
--   Google is how a person proves who they are (auth.users.id, via Supabase
--   Auth). PayPal is where a shop is paid (a PayPal merchant id). Neither is
--   the other's key. A shop's PayPal email or merchant id is never an
--   identity; a Google email is never a permission.
--
-- WHO MAY WRITE WHAT
--   As before (0009): clients write nothing here directly. The browser's own
--   actions go through functions that check auth.uid(). Facts that only
--   PayPal can vouch for — a seller's status, a capture, a refund, a webhook —
--   are written only by functions that also demand the server's secret
--   (billing_private.secrets, 'payment_recorder'), which only the server
--   holds. The Supabase secret / service_role key is still not used anywhere.
-- ===========================================================================

-- --------------------------------------------------------------- helpers ---

/* True when p_secret is the server's payment-recorder secret. Compared as a
   SHA-256, the only form the database keeps. */
create or replace function billing_private.server_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = billing_private
as $$
  select p_secret is not null and exists (
    select 1 from billing_private.secrets
     where name = 'payment_recorder'
       and sha256_hex = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
  );
$$;

revoke all on function billing_private.server_secret_ok(text) from public;

create or replace function public.assert_server(p_secret text)
returns void
language plpgsql
stable
security definer
set search_path = public, billing_private
as $$
begin
  if not billing_private.server_secret_ok(p_secret) then
    raise exception 'Only the FurnishAR server may do this.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_server(text) from public, anon, authenticated;

-- ============================================================ ONBOARDING ===

-- An application now remembers WHICH ACCOUNT filed it, not only an email.
-- Older applications keep matching by email.
alter table public.store_applications
  add column if not exists applicant_user_id uuid references auth.users (id) on delete set null;

create index if not exists store_applications_applicant_idx
  on public.store_applications (applicant_user_id);

/*
  What kind of account is signed in.
    guest       no session
    admin       in platform_admins (never from Google, a form or metadata)
    owner       a member of a store
    buyer       has a buyers row
    pending     has a store application waiting for review
    onboarding  signed in (e.g. first Google sign-in) with no role yet — or
                a rejected applicant — and must choose what they are here for
*/
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select case
    when auth.uid() is null then 'guest'
    when exists (select 1 from public.platform_admins a where a.user_id = auth.uid()) then 'admin'
    when exists (select 1 from public.store_members m where m.user_id = auth.uid()) then 'owner'
    when exists (select 1 from public.buyers b where b.user_id = auth.uid()) then 'buyer'
    when exists (
      select 1 from public.store_applications sa
       where sa.status = 'pending'
         and (sa.applicant_user_id = auth.uid()
              or lower(sa.contact_email::text) = lower((select u.email from auth.users u where u.id = auth.uid())))
    ) then 'pending'
    else 'onboarding'
  end;
$$;

revoke all on function public.my_role() from public;
grant execute on function public.my_role() to anon, authenticated, service_role;

/* The caller's own onboarding picture: role, name from their sign-in
   provider, profile, latest application. Nothing about anyone else. */
create or replace function public.my_account_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  me auth.users;
  profile public.buyers;
  app public.store_applications;
begin
  if auth.uid() is null then
    return jsonb_build_object('role', 'guest');
  end if;
  select * into me from auth.users where id = auth.uid();
  select * into profile from public.buyers where user_id = auth.uid();
  select * into app from public.store_applications sa
   where sa.applicant_user_id = auth.uid() or lower(sa.contact_email::text) = lower(me.email)
   order by sa.created_at desc limit 1;

  return jsonb_build_object(
    'role', public.my_role(),
    'email', me.email,
    'name', nullif(btrim(coalesce(me.raw_user_meta_data ->> 'full_name', me.raw_user_meta_data ->> 'name', '')), ''),
    'buyer', case when profile.user_id is null then null
                  else jsonb_build_object('full_name', profile.full_name, 'municipality', profile.municipality) end,
    'application', case when app.id is null then null
                        else jsonb_build_object('status', app.status, 'store_name', app.store_name,
                                                'review_note', app.review_note, 'created_at', app.created_at) end
  );
end;
$$;

/*
  A signed-in account (typically a first Google sign-in) becomes a buyer.
  Asks only for what is missing: the name defaults to the one the sign-in
  provider gave. An account that is an admin, an owner or an applicant is
  refused — one account, one role (0006) — and 0006's trigger checks again.
*/
create or replace function public.complete_buyer_onboarding(p_full_name text, p_municipality text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  me auth.users;
  name text;
  acct_role text := public.my_role();
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if acct_role = 'buyer' then
    return jsonb_build_object('created', false, 'role', 'buyer');
  end if;
  if acct_role <> 'onboarding' then
    raise exception 'This account is already set up as a %.',
      case acct_role when 'owner' then 'store owner' when 'pending' then 'store applicant' else 'platform account' end
      using errcode = 'check_violation';
  end if;

  select * into me from auth.users where id = auth.uid();
  name := nullif(btrim(coalesce(p_full_name, me.raw_user_meta_data ->> 'full_name', me.raw_user_meta_data ->> 'name', '')), '');
  if name is null or length(name) < 2 then
    raise exception 'Enter your name.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.municipalities m where m.name = p_municipality) then
    raise exception 'Choose your municipality in Occidental Mindoro.' using errcode = 'check_violation';
  end if;

  insert into public.buyers (user_id, full_name, municipality)
  values (auth.uid(), left(name, 80), p_municipality);

  return jsonb_build_object('created', true, 'role', 'buyer', 'full_name', left(name, 80), 'email', me.email);
end;
$$;

/*
  A signed-in account applies to sell. The application carries the account
  id, so approval links the store to THIS account whatever its email is.
  Needs a confirmed email (Google accounts always have one).
*/
create or replace function public.submit_store_application(p_store_name text, p_phone text, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  me auth.users;
  acct_role text := public.my_role();
  created public.store_applications;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if acct_role = 'pending' then
    raise exception 'Your store application is already waiting for review.' using errcode = 'check_violation';
  end if;
  if acct_role <> 'onboarding' then
    raise exception 'This account is already set up as a %. Use a different account to sell.',
      case acct_role when 'owner' then 'store owner' when 'buyer' then 'shopper' else 'platform account' end
      using errcode = 'check_violation';
  end if;
  select * into me from auth.users where id = auth.uid();
  if me.email is null or me.email_confirmed_at is null then
    raise exception 'Confirm your email address before applying.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_store_name, ''))) < 2 then
    raise exception 'Enter your store''s name.' using errcode = 'check_violation';
  end if;
  if p_phone is null or btrim(p_phone) !~ '^[0-9+() -]{7,20}$' then
    raise exception 'Enter a contact number, e.g. 0917 123 4567.' using errcode = 'check_violation';
  end if;

  insert into public.store_applications (store_name, contact_email, contact_phone, message, applicant_user_id)
  values (left(btrim(p_store_name), 120), me.email, btrim(p_phone),
          nullif(left(btrim(coalesce(p_message, '')), 1000), ''), auth.uid())
  returning * into created;

  return jsonb_build_object('application_id', created.id, 'store_name', created.store_name,
                            'contact_email', created.contact_email);
end;
$$;

/* 0003's approval, now linking the account that applied (by id) and
   falling back to the email for applications filed before 0011. */
create or replace function public.approve_store_application(
  application uuid,
  store_slug  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  app         public.store_applications;
  owner_user  uuid;
  confirmed   timestamptz;
  banned      timestamptz;
  new_slug    text;
  target      uuid;
  actor_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may decide applications'
      using errcode = '42501';
  end if;

  select * into app from public.store_applications where id = application for update;
  if not found then
    raise exception 'No application with id %', application using errcode = 'P0002';
  end if;
  if app.status <> 'pending' then
    raise exception 'That application was already %', app.status using errcode = '22023';
  end if;

  if app.applicant_user_id is not null then
    select id, email_confirmed_at, banned_until into owner_user, confirmed, banned
      from auth.users where id = app.applicant_user_id;
  else
    select id, email_confirmed_at, banned_until into owner_user, confirmed, banned
      from auth.users where lower(email) = lower(app.contact_email);
  end if;
  if owner_user is null then
    raise exception
      'No account exists for % yet. The applicant must sign up before the store can be linked.',
      app.contact_email using errcode = 'P0002';
  end if;
  if confirmed is null then
    raise exception
      '% has not confirmed their email address yet, so there is nothing proving they own it.',
      app.contact_email using errcode = '22023';
  end if;
  if banned is not null and banned > now() then
    raise exception 'The account for % is disabled.', app.contact_email using errcode = '22023';
  end if;

  new_slug := coalesce(nullif(btrim(store_slug), ''), public.slugify(app.store_name));
  if new_slug is null or new_slug = '' then
    raise exception 'Could not derive a store slug from %', app.store_name using errcode = '22023';
  end if;

  insert into public.stores (slug, name, plan, status, contact_number)
  values (new_slug, app.store_name, 'freemium', 'active', app.contact_phone)
  on conflict (slug) do update set name = excluded.name
  returning id into target;

  insert into public.store_members (store_id, user_id, role)
  values (target, owner_user, 'owner')
  on conflict do nothing;

  update public.store_applications
     set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(),
         approved_store_id = target, applicant_user_id = owner_user
   where id = application;

  select email into actor_email from auth.users where id = auth.uid();
  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, 'application.approved', application,
          jsonb_build_object('store_id', target, 'slug', new_slug,
                             'store_name', app.store_name, 'contact_email', app.contact_email));

  return jsonb_build_object('store_id', target, 'slug', new_slug, 'user_id', owner_user,
                            'store_name', app.store_name, 'contact_email', app.contact_email);
end;
$$;

create or replace function public.reject_store_application(
  application uuid,
  note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  app         public.store_applications;
  actor_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only a platform administrator may decide applications'
      using errcode = '42501';
  end if;

  select * into app from public.store_applications where id = application for update;
  if not found then
    raise exception 'No application with id %', application using errcode = 'P0002';
  end if;
  if app.status <> 'pending' then
    raise exception 'That application was already %', app.status using errcode = '22023';
  end if;

  update public.store_applications
     set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(), review_note = note
   where id = application;

  select email into actor_email from auth.users where id = auth.uid();
  insert into public.admin_audit (actor, actor_email, action, subject, detail)
  values (auth.uid(), actor_email, 'application.rejected', application,
          jsonb_build_object('store_name', app.store_name, 'contact_email', app.contact_email, 'note', note));

  return jsonb_build_object('status', 'rejected', 'store_name', app.store_name,
                            'contact_email', app.contact_email, 'note', note);
end;
$$;

-- ================================================= PAYPAL SELLER ACCOUNTS ===

create table if not exists public.store_payment_accounts (
  store_id              uuid not null references public.stores (id) on delete cascade,
  environment           text not null check (environment in ('sandbox', 'live')),
  provider              text not null default 'paypal' check (provider = 'paypal'),
  tracking_id           text unique check (length(tracking_id) <= 127),
  merchant_id           text check (merchant_id ~ '^[A-Z0-9]{8,20}$'),
  onboarding_status     text not null default 'NOT_CONNECTED' check (onboarding_status in (
                          'NOT_CONNECTED', 'ONBOARDING_STARTED', 'PENDING', 'CONNECTED',
                          'LIMITED', 'DISABLED', 'ERROR', 'PAYMENTS_NEED_ATTENTION')),
  payments_receivable   boolean not null default false,
  email_confirmed       boolean not null default false,
  -- The seller granted FurnishAR (the partner) the right to take a platform
  -- fee from its payments. Without it no split is ever attempted.
  partner_fee_granted   boolean not null default false,
  status_detail         text check (length(status_detail) <= 300),
  onboarding_started_at timestamptz,
  connected_at          timestamptz,
  last_checked_at       timestamptz,
  last_paypal_reminder_at timestamptz,
  paypal_reminder_count integer not null default 0 check (paypal_reminder_count >= 0),
  updated_at            timestamptz not null default now(),
  primary key (store_id, environment)
);

create index if not exists store_payment_accounts_merchant_idx
  on public.store_payment_accounts (merchant_id, environment);

alter table public.store_payment_accounts enable row level security;

drop policy if exists store_payment_accounts_party_read on public.store_payment_accounts;
create policy store_payment_accounts_party_read on public.store_payment_accounts
  for select using (public.is_store_member(store_id) or public.is_platform_admin());

revoke all on public.store_payment_accounts from anon;
revoke insert, update, delete, truncate, references, trigger on public.store_payment_accounts from authenticated;
grant select on public.store_payment_accounts to authenticated;

comment on column public.store_payout.paypal_email is
  'Legacy / manual record of the shop''s PayPal email. Since 0011 it no longer enables checkout; a CONNECTED store_payment_accounts row does.';

/* Can this store take an online payment? Public: a product page asks it.
   Answers a yes/no only, never the merchant id. */
create or replace function public.store_accepts_payments(p_store uuid, p_env text default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.store_payment_accounts a
     where a.store_id = p_store
       and (p_env is null or a.environment = p_env)
       and a.onboarding_status = 'CONNECTED'
       and a.payments_receivable and a.email_confirmed
       and a.merchant_id is not null
  );
$$;

grant execute on function public.store_accepts_payments(uuid, text) to anon, authenticated;

/* The owner starts (or restarts) PayPal onboarding. The server generated the
   tracking id and got PayPal's link; this records the attempt as a member. */
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
  insert into public.store_payment_accounts (store_id, environment, tracking_id, onboarding_status, onboarding_started_at, updated_at)
  values (p_store, p_env, p_tracking_id, 'ONBOARDING_STARTED', now(), now())
  on conflict (store_id, environment) do update
     set tracking_id = excluded.tracking_id,
         -- A connected account stays connected while the owner re-runs
         -- onboarding; PayPal's answer decides what changes.
         onboarding_status = case when store_payment_accounts.onboarding_status = 'CONNECTED'
                                  then 'CONNECTED' else 'ONBOARDING_STARTED' end,
         onboarding_started_at = now(), updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

/*
  Records what PayPal said about a seller. Called by the server after it
  read the merchant integration from PayPal itself (never from the return
  URL's query string alone), and by the webhook handler. Finds the row by
  store, else by tracking id, else by merchant id. Returns the previous and
  new status so the caller knows whether to email.
*/
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
    select * into acct from public.store_payment_accounts where store_id = p_store and environment = p_env for update;
    if not found then
      insert into public.store_payment_accounts (store_id, environment) values (p_store, p_env)
      returning * into acct;
    end if;
  elsif p_tracking_id is not null then
    select * into acct from public.store_payment_accounts where tracking_id = p_tracking_id and environment = p_env for update;
  end if;
  if acct.store_id is null and p_merchant_id is not null then
    select * into acct from public.store_payment_accounts where merchant_id = p_merchant_id and environment = p_env for update;
  end if;
  if acct.store_id is null then
    return jsonb_build_object('found', false);
  end if;

  -- One PayPal account pays one shop. A merchant id already connected to a
  -- different store is refused rather than silently shared.
  if p_merchant_id is not null and exists (
    select 1 from public.store_payment_accounts o
     where o.merchant_id = p_merchant_id and o.environment = p_env and o.store_id <> acct.store_id
  ) then
    update public.store_payment_accounts
       set onboarding_status = 'ERROR', status_detail = 'This PayPal account is already connected to another store.',
           last_checked_at = now(), updated_at = now()
     where store_id = acct.store_id and environment = p_env;
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
   where store_id = acct.store_id and environment = p_env;

  return jsonb_build_object('found', true, 'store_id', acct.store_id, 'before', before, 'status', p_status,
                            'merchant_id', coalesce(p_merchant_id, acct.merchant_id));
end;
$$;

/* Who to email about a store: its name, notify address and owners. */
create or replace function public.server_store_contacts(p_secret text, p_store uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  shop record;
  owners text[];
begin
  perform public.assert_server(p_secret);
  select s.id, s.name, po.notify_email into shop
    from public.stores s left join public.store_payout po on po.store_id = s.id where s.id = p_store;
  select array_agg(u.email::text) into owners
    from public.store_members m join auth.users u on u.id = m.user_id where m.store_id = p_store;
  return jsonb_build_object('store_id', shop.id, 'store_name', shop.name,
    'store_emails', case when shop.notify_email is not null then array[shop.notify_email] else coalesce(owners, '{}') end);
end;
$$;

create or replace function public.server_admin_emails(p_secret text)
returns text[]
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  perform public.assert_server(p_secret);
  return coalesce((select array_agg(coalesce(u.email, a.email)::text)
                     from public.platform_admins a left join auth.users u on u.id = a.user_id), '{}');
end;
$$;

-- ------------------------------------------------------- reminders -------

/* Active stores that cannot take payments yet and are due a reminder. */
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
      left join public.store_payment_accounts a on a.store_id = s.id and a.environment = p_env
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
  insert into public.store_payment_accounts (store_id, environment, last_paypal_reminder_at, paypal_reminder_count)
  values (p_store, p_env, now(), 1)
  on conflict (store_id, environment) do update
     set last_paypal_reminder_at = now(),
         paypal_reminder_count = store_payment_accounts.paypal_reminder_count + 1,
         updated_at = now()
  returning paypal_reminder_count into sent;
  return jsonb_build_object('store_id', p_store, 'count', sent);
end;
$$;

-- ============================================================= THE FEE ====

-- The deposit's share of the fee, fixed when the quote is made.
alter table public.orders
  add column if not exists deposit_fee numeric(12,2) check (deposit_fee >= 0),
  add column if not exists refund_status text not null default 'none'
    check (refund_status in ('none', 'partial', 'full')),
  add column if not exists refunded_amount numeric(12,2) not null default 0 check (refunded_amount >= 0);

/*
  The platform fee carried by one stage of an order. The fee is computed
  ONCE (10% of the subtotal); the deposit carries half of it, rounded to the
  centavo, and the balance carries everything not yet carried — so the
  stages always add up to the fee exactly, whatever the rounding.
*/
create or replace function public.stage_platform_fee(p_order uuid, p_stage text)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target public.orders;
  carried numeric;
begin
  select * into target from public.orders where id = p_order;
  if not found or target.platform_fee is null then
    return 0;
  end if;
  if p_stage = 'full' then
    return target.platform_fee;
  end if;
  if p_stage = 'deposit' then
    return coalesce(target.deposit_fee, public.money(target.platform_fee * 0.5));
  end if;
  select coalesce(sum(p.platform_fee), 0) into carried
    from public.payments p where p.order_id = p_order and p.applied;
  return greatest(target.platform_fee - carried, 0);
end;
$$;

revoke all on function public.stage_platform_fee(uuid, text) from public, anon, authenticated;

/* 0009's quote, with the fee allocated between deposit and balance. */
create or replace function public.quote_custom_order(
  p_order uuid, p_price numeric, p_lead_days integer, p_note text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
  sub numeric;
  fee numeric;
  dep_fee numeric;
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

  sub := public.money(p_price);
  fee := public.money(sub * target.fee_rate);
  dep_fee := public.money(fee * 0.5);

  update public.orders
     set status = 'quoted',
         unit_price = sub,
         subtotal = sub,
         platform_fee = fee,
         total = sub + fee,
         deposit_fee = dep_fee,
         deposit_amount = public.money(sub * 0.5) + dep_fee,
         lead_time_days = p_lead_days,
         quote_note = nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
         quoted_at = now()
   where id = p_order;

  return jsonb_build_object('order_id', p_order, 'status', 'quoted');
end;
$$;

-- ============================================================ ORDERING ====
-- Unchanged from 0010 except: a store must have a CONNECTED PayPal seller
-- account (store_accepts_payments) instead of a typed PayPal email.

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

  select p.id, p.name, p.price_php, p.stock, p.store_id, s.fulfilment
    into item
    from public.products p
    join public.stores s on s.id = p.store_id
   where p.id = p_product and p.status = 'published' and s.status = 'active'
   for update of p;

  if not found then
    raise exception 'That piece is no longer available.' using errcode = 'no_data_found';
  end if;
  if item.fulfilment <> 'stocked' then
    raise exception 'This shop builds to order. Send a custom request instead.' using errcode = 'check_violation';
  end if;
  if not public.store_accepts_payments(item.store_id) then
    raise exception 'This shop is finishing its PayPal setup and cannot take online payments yet.' using errcode = 'check_violation';
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
  if not public.store_accepts_payments(shop.id) then
    raise exception 'This shop is finishing its PayPal setup and cannot take online orders yet.' using errcode = 'check_violation';
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

-- ============================================================= PAYING =====

/*
  What the buyer owes now, to which PayPal merchant, and the platform fee
  inside it. p_env is the server's PAYPAL_ENV: a sandbox seller is never
  paid by a live checkout, or the other way round.
*/
drop function if exists public.begin_payment(uuid);

create or replace function public.begin_payment(p_order uuid, p_env text default 'sandbox')
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
   where a.store_id = target.store_id and a.environment = p_env;
  if not public.store_accepts_payments(target.store_id, p_env) then
    raise exception 'This shop is finishing its PayPal setup and cannot take online payments yet.' using errcode = 'check_violation';
  end if;

  return jsonb_build_object(
    'order_id', target.id, 'reference', target.reference, 'stage', stage,
    'amount', due, 'currency', target.currency,
    'platform_fee', public.stage_platform_fee(target.id, stage),
    'merchant_id', acct.merchant_id,
    'partner_fee_granted', acct.partner_fee_granted,
    'store_name', store_name, 'product_name', target.product_name,
    'hold_expires_at', target.hold_expires_at
  );
end;
$$;

-- ------------------------------------------------------ payment attempts ---
-- One row per PayPal order FurnishAR created: the explicit payment state.

create table if not exists public.payment_attempts (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete restrict,
  store_id           uuid not null references public.stores (id) on delete restrict,
  stage              text not null check (stage in ('full', 'deposit', 'balance')),
  environment        text not null check (environment in ('sandbox', 'live')),
  provider_order_id  text not null unique,
  amount             numeric(12,2) not null check (amount > 0),
  currency           text not null check (currency = 'PHP'),
  platform_fee       numeric(12,2) not null check (platform_fee >= 0),
  fee_mode           text not null check (fee_mode in ('accrual', 'platform_split')),
  payee_merchant_id  text not null,
  status             text not null default 'CREATED' check (status in
                       ('CREATED', 'APPROVED', 'PENDING', 'CAPTURED', 'DECLINED', 'FAILED', 'CANCELLED')),
  capture_id         text,
  failure_reason     text check (length(failure_reason) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists payment_attempts_order_idx on public.payment_attempts (order_id, created_at desc);

alter table public.payment_attempts enable row level security;

drop policy if exists payment_attempts_party_read on public.payment_attempts;
create policy payment_attempts_party_read on public.payment_attempts
  for select using (
    public.is_store_member(store_id) or public.is_platform_admin()
    or exists (select 1 from public.orders o where o.id = order_id and o.buyer_id = auth.uid())
  );

revoke all on public.payment_attempts from anon;
revoke insert, update, delete, truncate, references, trigger on public.payment_attempts from authenticated;
grant select on public.payment_attempts to authenticated;

/* The server created a PayPal order for what begin_payment said; record it,
   as the buyer. The amounts are re-checked against the order here. */
create or replace function public.server_record_payment_attempt(
  p_secret text, p_order uuid, p_stage text, p_env text, p_provider_order text,
  p_amount numeric, p_platform_fee numeric, p_fee_mode text, p_merchant text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.orders;
begin
  perform public.assert_server(p_secret);
  select * into target from public.orders where id = p_order;
  if not found or target.buyer_id is distinct from auth.uid() then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  if public.money(p_platform_fee) <> public.money(public.stage_platform_fee(p_order, p_stage)) then
    raise exception 'Unexpected fee.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.store_payment_accounts a
                  where a.store_id = target.store_id and a.environment = p_env
                    and a.merchant_id = p_merchant and a.onboarding_status = 'CONNECTED') then
    raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
  end if;
  insert into public.payment_attempts (order_id, store_id, stage, environment, provider_order_id, amount,
                                       currency, platform_fee, fee_mode, payee_merchant_id)
  values (p_order, target.store_id, p_stage, p_env, p_provider_order, public.money(p_amount),
          target.currency, public.money(p_platform_fee), p_fee_mode, p_merchant)
  on conflict (provider_order_id) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

/* The recorded attempt for a PayPal order: what FurnishAR asked PayPal for. */
create or replace function public.server_payment_attempt(p_secret text, p_provider_order text)
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
  select * into a from public.payment_attempts where provider_order_id = p_provider_order;
  if not found then return null; end if;
  return to_jsonb(a);
end;
$$;

create or replace function public.server_update_payment_attempt(
  p_secret text, p_provider_order text, p_status text, p_capture text, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_server(p_secret);
  update public.payment_attempts
     set status = case
                    -- A captured attempt is final; later noise does not undo it.
                    when status = 'CAPTURED' then status
                    else p_status end,
         capture_id = coalesce(p_capture, capture_id),
         failure_reason = coalesce(nullif(left(coalesce(p_reason, ''), 300), ''), failure_reason),
         updated_at = now()
   where provider_order_id = p_provider_order;
  return jsonb_build_object('ok', found);
end;
$$;

-- -------------------------------------------------------------- payments --

alter table public.payments alter column payee_email drop not null;
alter table public.payments
  add column if not exists payee_merchant_id text,
  add column if not exists fee_mode text not null default 'accrual' check (fee_mode in ('accrual', 'platform_split')),
  -- What PayPal REPORTED as taken for FurnishAR in the capture breakdown.
  -- Null in accrual mode: nothing was collected, the fee is owed.
  add column if not exists platform_fee_collected numeric(12,2) check (platform_fee_collected >= 0),
  add column if not exists environment text check (environment in ('sandbox', 'live')),
  add column if not exists refunded_amount numeric(12,2) not null default 0 check (refunded_amount >= 0),
  add column if not exists refunded_platform_fee numeric(12,2) not null default 0 check (refunded_platform_fee >= 0),
  add column if not exists status text not null default 'COMPLETED'
    check (status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'));

/*
  Records a payment PayPal captured. 0009's rules, plus:
    - the payee is the store's PayPal MERCHANT id (0011); an email payee is
      accepted only for a PayPal order that has no 0011 attempt (created
      before this migration, still being finished);
    - the fee recorded is the stage's allocated share (stage_platform_fee);
    - fee_mode 'platform_split' is recorded only with the amount PayPal
      reported collected; otherwise the fee accrues;
    - callable by the server without a buyer session (webhook), still only
      with the secret. With a session, only by the order's buyer.
*/
drop function if exists public.record_capture(text, uuid, text, text, text, numeric, text, text, text);

create or replace function public.record_capture(
  p_secret text, p_order uuid, p_stage text, p_provider_order text, p_capture text,
  p_amount numeric, p_currency text, p_payee text, p_payer_email text,
  p_payee_merchant text default null, p_fee_mode text default 'accrual',
  p_fee_collected numeric default null, p_env text default null
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
  applied boolean := false;
  next_status public.order_status;
  existing public.payments;
  shelf integer;
begin
  perform public.assert_server(p_secret);

  select * into existing from public.payments where capture_id = p_capture;
  if found then
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
    if attempt.order_id <> target.id or attempt.stage <> p_stage
       or p_payee_merchant is distinct from attempt.payee_merchant_id
       or not exists (select 1 from public.store_payment_accounts a
                       where a.store_id = target.store_id and a.environment = attempt.environment
                         and a.merchant_id = p_payee_merchant) then
      raise exception 'The payment went to the wrong account.' using errcode = 'check_violation';
    end if;
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
  -- Split only when PayPal says it took exactly the fee; anything else accrues.
  mode := case when applied and p_fee_mode = 'platform_split'
                    and p_fee_collected is not null and public.money(p_fee_collected) = public.money(fee)
               then 'platform_split' else 'accrual' end;

  insert into public.payments (
    order_id, store_id, stage, provider_order_id, capture_id, amount, platform_fee,
    currency, payee_email, payer_email, applied,
    payee_merchant_id, fee_mode, platform_fee_collected, environment
  ) values (
    target.id, target.store_id, p_stage, p_provider_order, p_capture, public.money(p_amount), fee,
    p_currency, nullif(lower(coalesce(p_payee, '')), ''), nullif(left(p_payer_email, 254), ''), applied,
    p_payee_merchant, mode,
    case when p_fee_collected is not null then public.money(p_fee_collected) end,
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
                            'platform_fee', fee, 'fee_mode', mode);
end;
$$;

-- --------------------------------------------------------------- refunds --

create table if not exists public.payment_refunds (
  refund_id              text primary key,
  capture_id             text not null references public.payments (capture_id) on delete restrict,
  order_id               uuid not null references public.orders (id) on delete restrict,
  store_id               uuid not null references public.stores (id) on delete restrict,
  amount                 numeric(12,2) not null check (amount > 0),
  -- The two portions of the refund: what comes out of the seller's share
  -- and what comes out of FurnishAR's fee.
  seller_amount          numeric(12,2) not null check (seller_amount >= 0),
  platform_fee_refunded  numeric(12,2) not null check (platform_fee_refunded >= 0),
  kind                   text not null default 'refund' check (kind in ('refund', 'reversal')),
  status                 text not null check (status in ('COMPLETED', 'PENDING', 'FAILED', 'CANCELLED')),
  created_at             timestamptz not null default now()
);

create index if not exists payment_refunds_store_idx on public.payment_refunds (store_id, created_at desc);

alter table public.payment_refunds enable row level security;

drop policy if exists payment_refunds_party_read on public.payment_refunds;
create policy payment_refunds_party_read on public.payment_refunds
  for select using (
    public.is_store_member(store_id) or public.is_platform_admin()
    or exists (select 1 from public.orders o where o.id = order_id and o.buyer_id = auth.uid())
  );

revoke all on public.payment_refunds from anon;
revoke insert, update, delete, truncate, references, trigger on public.payment_refunds from authenticated;
grant select on public.payment_refunds to authenticated;

/*
  A refund (or reversal) PayPal reported. Idempotent on the refund id.
  The platform's portion is what PayPal reported refunded from the platform
  fee when it said; otherwise the fee's proportional share, and the whole
  remaining fee on the refund that empties the capture.
*/
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
                            'payment_status', new_status);
end;
$$;

-- -------------------------------------------------------------- webhooks --

create table if not exists public.payment_webhook_events (
  event_id     text primary key check (length(event_id) <= 100),
  event_type   text not null check (length(event_type) <= 100),
  resource_id  text check (length(resource_id) <= 100),
  environment  text check (environment in ('sandbox', 'live')),
  outcome      text check (length(outcome) <= 200),
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.payment_webhook_events enable row level security;

drop policy if exists payment_webhook_events_admin_read on public.payment_webhook_events;
create policy payment_webhook_events_admin_read on public.payment_webhook_events
  for select using (public.is_platform_admin());

revoke all on public.payment_webhook_events from anon;
revoke insert, update, delete, truncate, references, trigger on public.payment_webhook_events from authenticated;
grant select on public.payment_webhook_events to authenticated;

/* Claims a verified webhook event. True the first time; false for a
   redelivery of an event already processed (PayPal retries). An event that
   was claimed but never finished (the server died half way) may be claimed
   again after ten minutes. */
create or replace function public.server_claim_webhook_event(
  p_secret text, p_event_id text, p_type text, p_resource text, p_env text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  perform public.assert_server(p_secret);
  insert into public.payment_webhook_events (event_id, event_type, resource_id, environment)
  values (p_event_id, p_type, p_resource, p_env)
  on conflict (event_id) do nothing;
  if found then return true; end if;
  update public.payment_webhook_events
     set received_at = now()
   where event_id = p_event_id and processed_at is null and received_at < now() - interval '10 minutes'
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.server_finish_webhook_event(p_secret text, p_event_id text, p_outcome text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_server(p_secret);
  update public.payment_webhook_events
     set processed_at = now(), outcome = left(coalesce(p_outcome, 'processed'), 200)
   where event_id = p_event_id;
end;
$$;

-- ------------------------------------------------- contacts for emails ---

/* Everything on a receipt (0010's order_contacts), without the caller check.
   Not callable by clients; the two wrappers below decide who may ask. */
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
           'fee_mode', p.fee_mode, 'refunded_amount', p.refunded_amount) order by p.captured_at), '[]'::jsonb)
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

create or replace function public.order_contacts(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  target public.orders;
begin
  select * into target from public.orders where id = p_order;
  if not found or not (target.buyer_id = auth.uid() or public.is_store_member(target.store_id)) then
    raise exception 'That order is not yours.' using errcode = '42501';
  end if;
  return public.order_contacts_for(p_order);
end;
$$;

create or replace function public.server_order_contacts(p_secret text, p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_server(p_secret);
  return public.order_contacts_for(p_order);
end;
$$;

-- ---------------------------------------------------- fee summaries -------
-- Accrued = owed by the shop (accrual mode). Collected = PayPal reported
-- taking it at capture (platform_split). Refunded fee portions reduce each.

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
  settled numeric;
begin
  if not (public.is_store_member(p_store) or public.is_platform_admin()) then
    raise exception 'Not your store.' using errcode = '42501';
  end if;
  select coalesce(sum(platform_fee - refunded_platform_fee) filter (where fee_mode = 'accrual'), 0),
         coalesce(sum(coalesce(platform_fee_collected, 0) - refunded_platform_fee) filter (where fee_mode = 'platform_split'), 0)
    into accrued, collected
    from public.payments where store_id = p_store and applied;
  select coalesce(sum(amount), 0) into settled from public.fee_settlements where store_id = p_store;
  return jsonb_build_object('store_id', p_store, 'accrued', accrued, 'collected', collected,
                            'settled', settled, 'outstanding', accrued - settled,
                            'fee_rate', public.platform_fee_rate());
end;
$$;

drop function if exists public.fee_overview();

create or replace function public.fee_overview()
returns table (store_id uuid, store_name text, fulfilment public.store_fulfilment,
               sales numeric, accrued numeric, collected numeric, refunded numeric,
               settled numeric, outstanding numeric,
               payment_status text, payment_environment text, merchant_id_masked text)
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
                else repeat('•', greatest(length(a.merchant_id) - 4, 0)) || right(a.merchant_id, 4) end
      from public.stores s
      left join (select pa.store_id,
                        sum(pa.amount - pa.refunded_amount) as sales,
                        sum(pa.platform_fee - pa.refunded_platform_fee) filter (where pa.fee_mode = 'accrual') as accrued,
                        sum(coalesce(pa.platform_fee_collected, 0) - pa.refunded_platform_fee) filter (where pa.fee_mode = 'platform_split') as collected,
                        sum(pa.refunded_amount) as refunded
                   from public.payments pa where pa.applied group by pa.store_id) p on p.store_id = s.id
      left join (select fs.store_id, sum(fs.amount) as settled
                   from public.fee_settlements fs group by fs.store_id) f on f.store_id = s.id
      left join lateral (select * from public.store_payment_accounts spa
                          where spa.store_id = s.id order by spa.updated_at desc limit 1) a on true
     order by coalesce(p.accrued, 0) - coalesce(f.settled, 0) desc, s.name;
end;
$$;

-- ------------------------------------------------------------ catalogue ---
-- Appended column: can this shop take an online order right now?

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
    public.store_accepts_payments(s.id) as store_payments_ready
  from public.products p
  join public.stores s on s.id = p.store_id
  where p.status = 'published' and s.status = 'active';

grant select on public.catalog to anon, authenticated;

-- ------------------------------------------------------------------ grants --

do $$
declare
  fn text;
begin
  -- Signed-in callers; each checks auth.uid() itself.
  foreach fn in array array[
    'public.my_account_state()',
    'public.complete_buyer_onboarding(text, text)',
    'public.submit_store_application(text, text, text)',
    'public.quote_custom_order(uuid, numeric, integer, text)',
    'public.create_stock_order(uuid, integer, text, text, text, text, text)',
    'public.create_custom_request(uuid, uuid, jsonb, text, text, text, text, text)',
    'public.begin_payment(uuid, text)',
    'public.order_contacts(uuid)',
    'public.store_fee_summary(uuid)',
    'public.fee_overview()',
    'public.approve_store_application(uuid, text)',
    'public.reject_store_application(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;

  -- Server-only: every one demands the server's secret. Granted to anon too
  -- because webhooks and the reminder job have no user session. The secret
  -- is the authorization; a caller without it is refused.
  foreach fn in array array[
    'public.server_payment_onboarding_started(text, uuid, text, text)',
    'public.server_record_payment_account(text, text, uuid, text, text, text, boolean, boolean, boolean, text)',
    'public.server_store_contacts(text, uuid)',
    'public.server_admin_emails(text)',
    'public.server_stores_needing_payment_setup(text, text, integer, integer)',
    'public.server_mark_payment_reminder(text, uuid, text)',
    'public.server_record_payment_attempt(text, uuid, text, text, text, numeric, numeric, text, text)',
    'public.server_payment_attempt(text, text)',
    'public.server_update_payment_attempt(text, text, text, text, text)',
    'public.record_capture(text, uuid, text, text, text, numeric, text, text, text, text, text, numeric, text)',
    'public.server_record_refund(text, text, text, numeric, text, numeric, text, text)',
    'public.server_claim_webhook_event(text, text, text, text, text)',
    'public.server_finish_webhook_event(text, text, text)',
    'public.server_order_contacts(text, uuid)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;
