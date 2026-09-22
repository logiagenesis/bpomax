-- 0013 the membership plan and bid allowance on a marketplace account (ARB-042, docs/02 T-03)

-- The allowance belongs to the account, not the org: it is what the platform grants the
-- membership the owner pays for. Both stay null until the owner records them (T-03: "plan
-- name and monthly bid limit"); while the allowance is null nothing is submitted, and the
-- message says why. `plan_recorded_on` is when the owner read it off the account, so a
-- stale figure can be told from a current one.
alter table platform_accounts
  add column plan_name text,
  add column monthly_bid_allowance integer check (monthly_bid_allowance >= 0),
  add column plan_recorded_on date;

-- Bids used against that allowance are counted in usage_counters, one row per org,
-- metric ('bids:<platform>') and period (the first day of the month, SAST). The count is
-- moved with one conditional upsert (packages/db/src/allowance.ts), so two submissions
-- racing for the last bid cannot both take it.
