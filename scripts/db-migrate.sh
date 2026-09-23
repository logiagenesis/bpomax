#!/bin/sh
# Applies every migration in packages/db/migrations to DATABASE_URL, in order, each in its
# own transaction, stopping at the first error (ARB-010).
#
# For the compose Postgres (the supabase/postgres image, which supplies the auth schema and
# the roles the policies name) or any Supabase database. `supabase db reset` does the same
# for a Supabase CLI stack. The URL is read from the environment or the repo-root .env.
set -eu

cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2-)
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set (see .env.example)." >&2
  exit 1
fi

for file in packages/db/migrations/*.sql; do
  echo "applying $(basename "$file")"
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$file"
done
echo "applied $(ls packages/db/migrations/*.sql | wc -l | tr -d ' ') migrations"
