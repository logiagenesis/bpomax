import { isReferralCode } from '@arbitron/core';
import type { Queryable } from './client.js';

/**
 * Affiliates (ARB-430): the click, and the owner's report of each affiliate's funnel. The
 * click is written for an anonymous visitor and the report crosses every referred org,
 * so both run on the service connection; the API decides who may ask (D-071).
 */
export async function recordReferralClick(
  db: Queryable,
  input: { code: string; landingPage: string | null },
): Promise<string | null> {
  if (!isReferralCode(input.code)) return null;
  const page =
    input.landingPage && /^[a-z-]+\.html$/.test(input.landingPage) ? input.landingPage : null;
  const { rows } = await db.query<{ id: string }>(
    `insert into attribution (affiliate_id, source, landing_page)
     select id, 'link', $2 from affiliates where code = $1 and active
     returning id`,
    [input.code, page],
  );
  return rows[0]?.id ?? null;
}

export interface AffiliateReportRow {
  id: string;
  code: string;
  owner_email: string | null;
  commission_pct: string | null;
  active: boolean;
  created_at: string;
  clicks: number;
  sign_ups: number;
  paid: number;
  last_click_at: string | null;
}

/** Each affiliate of an org's programme, with its clicks, sign-ups and paid orgs. */
export async function affiliateReport(
  db: Queryable,
  programmeOrgId: string,
): Promise<AffiliateReportRow[]> {
  const { rows } = await db.query<AffiliateReportRow>(
    `select a.id, a.code, a.owner_email, a.commission_pct::text as commission_pct, a.active,
            a.created_at::text as created_at,
            count(t.id)::int as clicks,
            count(t.id) filter (where t.org_id is not null)::int as sign_ups,
            count(t.id) filter (where t.converted_at is not null)::int as paid,
            max(t.first_seen_at)::text as last_click_at
       from affiliates a
       left join attribution t on t.affiliate_id = a.id
      where a.org_id = $1
      group by a.id
      order by a.created_at, a.code`,
    [programmeOrgId],
  );
  return rows;
}
