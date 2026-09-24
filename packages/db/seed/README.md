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

## plans.json

Empty, on purpose (ARB-410).

A plan is what a customer organisation pays for and what it may do each month: one
monthly limit per metered action (`jobs_scored`, `bids_drafted`, `bids_submitted`), a
whole number or `null` for no limit. The figures are the owner's (docs/02 D-12: earlier
working figures are not approved), so none are written here. Until a plan exists, an
organisation created through public sign-up can take no metered action, and says so; the
house org (Logi-Ink) is never limited (D-069).

Each entry, checked by `validatePlan` in `@arbitron/core` before anything is written:

```json
{
  "code": "a-code",
  "name": "Shown to customers",
  "active": true,
  "limits": { "jobs_scored": 0, "bids_drafted": 0, "bids_submitted": 0 }
}
```

Every metric must be stated; one left out fails the seed rather than reading as
unlimited. A plan removed from the file is not deleted: set `active` to false instead.
Prices are ARB-420's.
