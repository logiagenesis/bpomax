#!/bin/sh
# Builds the web app on Vercel (ARB-070, DECISIONS.md D-043).
#
# With SUPABASE_URL, SUPABASE_ANON_KEY and API_URL set in the Vercel project's
# environment, this is the real app, signed in against the owner's Supabase project and
# calling the owner's API. With any of them missing, it is the demo build: every page is
# viewable with sample data answered inside the browser, and a banner on every page says
# so. Adding the three variables in Vercel and redeploying is the whole switch.
set -eu

cd "$(dirname "$0")/.."

if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON_KEY:-}" ] && [ -n "${API_URL:-}" ]; then
  echo "Building the web app against ${SUPABASE_URL} and ${API_URL}"
  pnpm build:web
else
  echo "SUPABASE_URL, SUPABASE_ANON_KEY or API_URL is not set: building demo mode (D-043)"
  pnpm --filter @arbitron/web exec vite build --mode demo --outDir ../dist --emptyOutDir
fi
