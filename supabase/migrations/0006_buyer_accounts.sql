-- ===========================================================================
-- Buyer accounts: the third role, and the first one that is a customer.
--
-- Until now every account on FurnishAR belonged to somebody who SELLS: a
-- store owner waiting for approval, or the operator who approves them.
-- Shoppers had no accounts at all, which is why the notification bell has
-- nothing to notify and why "sign in" anywhere on the site meant "sign in to
-- sell something".
--
-- A buyer is now a real account with a real row, because the alternative —
-- deciding who is a buyer from a flag the browser sends, or from the absence
-- of a store membership — is not a permission. Anyone who can call PostgREST
-- can send whatever flag they like.
--
--   buyer         signs up with a name and a municipality, signs in, and uses
--                 the space planner. Owns nothing, sells nothing, and can
--                 read only their own row.
--
--   store owner   0001. Signs up as a store APPLICATION, is approved, then
--                 administers their own store.
--
--   superadmin    0003. Reviews applications.
--
-- One account is one role. The constraint at the bottom of this file enforces
-- that in the database rather than trusting the two sign-up forms to stay out
-- of each other's way.
-- ===========================================================================

-- ---------------------------------------------------------- municipalities --
-- The eleven municipalities of Occidental Mindoro, which is the whole of
-- FurnishAR's service area. A check constraint rather than free text: this is
-- meant to become "stores near you", and a column holding "Mamburao",
-- "mamburao" and "Mamburao, Occ. Mindoro" cannot group by anything.
--
-- A table rather than an enum so a municipality can be added without a type
-- migration, and so the sign-up form can read the list instead of hard-coding
-- its own copy that drifts.

create table if not exists public.municipalities (
  name text primary key
);

insert into public.municipalities (name) values
  ('Abra de Ilog'), ('Calintaan'), ('Looc'), ('Lubang'), ('Magsaysay'),
  ('Mamburao'), ('Paluan'), ('Rizal'), ('Sablayan'), ('San Jose'),
  ('Santa Cruz')
on conflict (name) do nothing;

alter table public.municipalities enable row level security;

-- The one table on the platform that is genuinely public: it is a list of
-- place names, and the sign-up form needs it before anyone has an account.
drop policy if exists municipalities_public_read on public.municipalities;
create policy municipalities_public_read on public.municipalities
  for select using (true);

grant select on public.municipalities to anon, authenticated;

-- ----------------------------------------------------------------- buyers --

create table if not exists public.buyers (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  full_name     text not null check (length(btrim(full_name)) between 2 and 80),
  municipality  text not null references public.municipalities (name),
  created_at    timestamptz not null default now()
);

alter table public.buyers enable row level security;

-- A buyer reads and edits their own row and no other. There is deliberately
-- no policy letting a store owner read buyers: a shop does not get the name
-- and town of everyone who looked at their furniture.
drop policy if exists buyers_self_read on public.buyers;
create policy buyers_self_read on public.buyers
  for select using (user_id = auth.uid());

drop policy if exists buyers_self_update on public.buyers;
create policy buyers_self_update on public.buyers
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- No insert policy, and none is wanted: the row is written by the trigger
-- below, as the account is created. An insert policy would let a signed-in
-- account create a buyer row for itself AFTER signing up as a store owner,
-- which is the exact thing the one-account-one-role rule forbids.

grant select, update (full_name, municipality) on public.buyers to authenticated;

-- ------------------------------------------------- one account, one role ---
-- Refuses a buyer row for an account that has already applied to sell, and
-- (via the second trigger) refuses a store application from an address that
-- already shops here.
--
-- Why it matters beyond tidiness: the portal decides what to show from what
-- the account IS. An account that was both would get a shopper's planner and
-- an owner's inventory on the same session, and every "is this person allowed
-- to edit this product" question would have two answers.

create or replace function public.reject_buyer_who_sells()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  seller_email text;
begin
  select email into seller_email from auth.users where id = new.user_id;

  if exists (select 1 from public.store_members m where m.user_id = new.user_id) then
    raise exception 'This account already belongs to a store.'
      using errcode = 'check_violation';
  end if;

  if seller_email is not null
     and exists (select 1 from public.store_applications a
                 where lower(a.contact_email) = lower(seller_email)) then
    raise exception 'This address has already applied to sell on FurnishAR.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists buyers_not_sellers on public.buyers;
create trigger buyers_not_sellers
  before insert on public.buyers
  for each row execute function public.reject_buyer_who_sells();

create or replace function public.reject_seller_who_buys()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if exists (
    select 1
    from public.buyers b
    join auth.users u on u.id = b.user_id
    where lower(u.email) = lower(new.contact_email)
  ) then
    raise exception 'This address is already signed up as a shopper.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists applications_not_buyers on public.store_applications;
create trigger applications_not_buyers
  before insert on public.store_applications
  for each row execute function public.reject_seller_who_buys();

-- ------------------------------------------- the row, written at sign-up ---
-- The buyer's row is created from the account's own metadata as the account
-- is created, not by a second write from the browser.
--
-- That second write is the bug this design avoids. Store sign-up does it —
-- create the account, then insert the application — and when the second write
-- fails the account already exists, so trying again earns "already
-- registered" and then a rate limit. Worse here: when the project requires
-- email confirmation there IS no session immediately after sign-up, so a
-- browser-side insert into a table whose policy is `user_id = auth.uid()`
-- cannot succeed at all.
--
-- Doing it in a trigger means the account and the profile are one
-- transaction: either both exist or neither does.
--
-- An account signing up through the STORE form has no buyer metadata, so this
-- does nothing for it — which is what keeps a store owner from silently
-- becoming a buyer too.

create or replace function public.create_buyer_from_signup()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  name text := nullif(btrim(new.raw_user_meta_data ->> 'full_name'), '');
  town text := nullif(btrim(new.raw_user_meta_data ->> 'municipality'), '');
begin
  -- Only for accounts that actually signed up as shoppers.
  if new.raw_user_meta_data ->> 'role' is distinct from 'buyer' then
    return new;
  end if;
  if name is null or town is null then
    raise exception 'A shopper account needs a name and a municipality.'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.municipalities m where m.name = town) then
    raise exception 'Unknown municipality: %', town using errcode = 'check_violation';
  end if;

  insert into public.buyers (user_id, full_name, municipality)
  values (new.id, name, town);

  return new;
end;
$$;

drop trigger if exists auth_user_becomes_buyer on auth.users;
create trigger auth_user_becomes_buyer
  after insert on auth.users
  for each row execute function public.create_buyer_from_signup();

-- ----------------------------------------------------------- who am I? -----
-- One round trip that answers the question every gated page asks, without
-- handing the browser anything it should not see.
--
-- Returns the caller's own role and nothing about anybody else. Safe to call
-- signed out — it answers 'guest'.

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
    -- Signed in, but not yet anything: a store applicant waiting on review.
    else 'pending'
  end;
$$;

revoke all on function public.my_role() from public;
grant execute on function public.my_role() to anon, authenticated, service_role;
