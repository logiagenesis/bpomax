#!/bin/sh
# Resets the local database to a clean state (ARB-010): recreates the compose Postgres
# with an empty volume, applies every migration, then the seed.
#
# This is for the local stand-in only. It never touches a hosted Supabase project; that
# is migrated with the Supabase CLI once one exists (docs/02 B-06, DECISIONS.md D-038).
set -eu

cd "$(dirname "$0")/.."

docker compose rm --stop --force postgres
docker volume rm --force arbitron-postgres-data >/dev/null
docker compose up -d --wait --wait-timeout 240 postgres
sh scripts/db-migrate.sh
sh scripts/db-seed.sh
