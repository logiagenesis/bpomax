# Seed data

Applied by `pnpm db:seed`, and by `supabase db reset`, which runs `seed.sql`.

Seeding is idempotent: running it twice leaves the same rows with the same values, so it
is safe on an existing database. `packages/db/src/seed.test.ts` proves that against real
Postgres, and also checks the category slugs against the list in
`docs/01-MASTER-BUILD-PROMPT.md` section D — if the spec changes and this file does not,
the build fails.

## service-categories.json

The 22 categories the spec names. `in_house` is left `false` for every one: which
categories Logi-Ink delivers itself is the owner's decision (docs/02-BLOCKERS.md D-04)
and it changes how ARB-040 prices work, so it is not guessed here.

## market-price-bands.json

Empty, on purpose.

A band is a p25/p50/p75 for a category and currency. ARB-040 uses the p50 to price real
bids when there is no rate card, so a made-up band becomes a made-up price on a real
proposal. Rows here are flagged `source='seed'` and labelled as estimates wherever they
appear, but a label is not a substitute for a figure that came from somewhere.

Fill it in from one of:

- the owner's own completed projects, or a quoted rate the owner stands behind;
- a CSV import of observed marketplace prices (`source='owner_csv'`);
- the weekly price-refresh worker, once there is completed-project data
  (`source='completed_projects'`).

Until then the estimate worker falls through to the next method rather than reading a
band that does not exist.
