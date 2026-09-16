-- Run this only if the deployed project's 0001 migration was skipped.
-- It verifies the two objects required by the signup and portal membership flows.
-- For a new project, run the complete 0001_init.sql first instead.

DO $$
BEGIN
  IF to_regclass('public.store_applications') IS NULL THEN
    RAISE EXCEPTION 'public.store_applications is missing: run supabase/migrations/0001_init.sql';
  END IF;
  IF to_regclass('public.store_members') IS NULL THEN
    RAISE EXCEPTION 'public.store_members is missing: run supabase/migrations/0001_init.sql';
  END IF;
END $$;

-- PostgREST may cache the schema after tables are created in SQL Editor.
NOTIFY pgrst, 'reload schema';
