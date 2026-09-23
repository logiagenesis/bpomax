#!/bin/sh
# Applies the seed (service categories, and any market price bands the owner has
# supplied) to DATABASE_URL; the SQL opens and commits its own transaction (ARB-013). Idempotent: safe to repeat.
set -eu

cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2-)
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set (see .env.example)." >&2
  exit 1
fi

pnpm -s exec tsx packages/db/scripts/print-seed.ts |
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f -
echo "seed applied"
