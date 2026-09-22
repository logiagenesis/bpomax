/**
 * The narrow slice of a Postgres client this package needs, so the same code runs
 * against PGlite in tests and a pooled connection in production without either being
 * imported here.
 */
export interface QueryResult<T> {
  readonly rows: T[];
  readonly affectedRows?: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec?(sql: string): Promise<unknown>;
}

/**
 * Run work as a signed-in user, with row level security deciding what they can reach.
 *
 * The claims and the role are set with `set local`, so they last exactly as long as the
 * transaction and cannot leak to the next request that borrows the same pooled
 * connection. This is the only way the application should read tenant data: the
 * alternative is passing an org_id by hand and hoping every query remembers to.
 */
export async function withUser<T>(
  db: Queryable,
  authUserId: string,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: authUserId }),
    ]);
    await db.query('set local role authenticated');
    const result = await work(db);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
