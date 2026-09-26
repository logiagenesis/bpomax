import type { Queryable } from './client.js';

/**
 * The terms of service versions published so far (ARB-522, migration 0039). The API
 * records the approved version on show when it starts; `app.create_org` then makes an
 * org only for a person who names the latest one. The wording itself stays in the
 * published file, the owner's (D-16).
 */
export interface PublishedTerms {
  readonly version: string;
  /** YYYY-MM-DD, as the published file gives it. */
  readonly approvedOn: string;
}

/** Records a published version; recording one already known changes nothing. */
export async function recordPublishedTerms(db: Queryable, terms: PublishedTerms): Promise<boolean> {
  const result = await db.query(
    `insert into terms_versions (version, approved_on) values ($1, $2)
     on conflict (version) do nothing`,
    [terms.version, terms.approvedOn],
  );
  return (result.affectedRows ?? 0) > 0;
}

/** The version a new organisation's owner must accept, or null while none is published. */
export async function currentTermsVersion(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ version: string }>(
    `select version from terms_versions order by approved_on desc, created_at desc limit 1`,
  );
  return rows[0]?.version ?? null;
}
