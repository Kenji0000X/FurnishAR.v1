-- ===========================================================================
-- Least privilege on the functions PostgREST can reach.
--
-- Supabase grants EXECUTE on every new public function to anon and
-- authenticated by default, so `revoke ... from public` in the earlier
-- migrations did not remove it: the security advisor lists each of these as
-- callable at /rest/v1/rpc/<name>. Revoked here from PUBLIC as well as the
-- two roles, since a trigger function created without a revoke still
-- carries the PUBLIC grant every Postgres function starts with.
--
-- TRIGGER FUNCTIONS
-- Nobody should call these over HTTP. Postgres already refuses a trigger
-- function called directly, so this closes nothing that was open; it takes
-- them off the API surface so the list of callable functions is the list of
-- functions meant to be called. A trigger does not check EXECUTE when it
-- fires, so every trigger keeps working.
--
-- can_view_model
-- The storage policy (0007) calls it as the signed-in user, so
-- `authenticated` keeps it. A signed-out caller always gets false from it —
-- auth.uid() is null — so revoking anon changes no answer; it only stops a
-- guest from asking.
--
-- Deliberately NOT changed:
--   my_role()                 must answer 'guest' to a signed-out visitor;
--                             it is the first question the planner asks.
--   is_platform_admin(),
--   is_store_member(),
--   current_store_ids()       called from RLS policies, including ones
--                             evaluated for anon (public catalogue reads).
--   approve/reject_store_application, applicant_account, storage_usage
--                             each checks is_platform_admin() itself and is
--                             on the proxy's ALLOWED_FUNCTIONS list.
--   rls_auto_enable()         Supabase's own, not this project's.
-- ===========================================================================

revoke execute on function public.create_buyer_from_signup() from public, anon, authenticated;
revoke execute on function public.reject_buyer_who_sells()   from public, anon, authenticated;
revoke execute on function public.reject_seller_who_buys()   from public, anon, authenticated;
revoke execute on function public.enforce_plan_rules()       from public, anon, authenticated;
revoke execute on function public.set_asset_store()          from public, anon, authenticated;
revoke execute on function public.touch_updated_at()         from public, anon, authenticated;

revoke execute on function public.can_view_model(text) from public, anon;
