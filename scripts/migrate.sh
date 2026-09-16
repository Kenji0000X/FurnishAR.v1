#!/usr/bin/env bash
#
# Applies supabase/migrations/*.sql, in filename order, to the database in
# $SUPABASE_DB_URL. Optionally applies supabase/seed.sql afterwards.
#
#   scripts/migrate.sh              apply pending migrations
#   scripts/migrate.sh --seed       …and then the seed data
#   scripts/migrate.sh --force      re-apply every migration, even recorded ones
#   scripts/migrate.sh --dry-run    list what would run, touch nothing
#
# Which migrations have run is recorded in public.schema_migrations, so a
# second run is a no-op rather than a gamble. The current migration happens to
# be written idempotently, but that is a property of the file and not something
# a runner should assume of every future one.
#
# Every file is applied inside a single transaction with ON_ERROR_STOP, so a
# migration that fails part-way leaves nothing behind.
#
# The connection string is a privileged credential — it is never echoed, and
# psql reads it from the environment rather than the command line so it does
# not appear in the process list.
set -euo pipefail

SEED=false
FORCE=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=true ;;
    --force) FORCE=true ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  cat >&2 <<'MSG'
SUPABASE_DB_URL is not set.

Supabase dashboard → Settings → Database → Connection string → URI.
Use the pooled "Session" string; it is the one that works from CI.

In GitHub: Settings → Secrets and variables → Actions → New repository secret,
named SUPABASE_DB_URL.
MSG
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"

# psql reads the connection string from the environment, not argv.
run_sql() { PGPASSWORD="" psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "$@"; }

echo "→ checking the connection"
server_version="$(run_sql -tAc 'select version()' | head -1)"
echo "  connected: ${server_version:0:40}…"

run_sql -q -c "
  create table if not exists public.schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  );
  revoke all on public.schema_migrations from anon, authenticated;
"

applied="$(run_sql -tAc 'select filename from public.schema_migrations')"

pending=()
for file in "$MIGRATIONS"/*.sql; do
  [ -e "$file" ] || continue
  name="$(basename "$file")"
  if [ "$FORCE" = false ] && grep -qxF "$name" <<<"$applied"; then
    echo "  skip    $name (already applied)"
    continue
  fi
  pending+=("$file")
done

if [ ${#pending[@]} -eq 0 ]; then
  echo "→ no pending migrations"
else
  echo "→ ${#pending[@]} migration(s) to apply"
  for file in "${pending[@]}"; do
    name="$(basename "$file")"
    if [ "$DRY_RUN" = true ]; then
      echo "  would apply  $name"
      continue
    fi
    echo "  applying     $name"
    # One transaction per file: a failure rolls the whole file back, and the
    # record of it is written in the same transaction, so the table can never
    # claim a migration that did not finish.
    run_sql -q --single-transaction \
      -f "$file" \
      -c "insert into public.schema_migrations (filename) values ('$name')
          on conflict (filename) do update set applied_at = now();"
    echo "  applied      $name"
  done
fi

if [ "$SEED" = true ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "  would apply  seed.sql"
  else
    echo "→ applying seed.sql"
    run_sql -q --single-transaction -f "$ROOT/supabase/seed.sql"
    echo "  applied      seed.sql"
  fi
fi

echo "→ schema summary"
# to_regclass rather than a direct count: on a dry run against an empty
# database the catalogue view does not exist yet, and the summary should
# report that rather than fail.
run_sql -tAc "
  select '  tables: ' || count(*) from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE';
  select '  policies: ' || count(*) from pg_policies where schemaname = 'public';
  select case
    when to_regclass('public.catalog') is null then '  catalogue view: not created yet'
    else '  published products: ' || (select count(*) from public.catalog)
  end;
"
echo "done"
