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
  /** A pool (node-postgres `Pool`): a connection of its own, handed back with `release`. */
  connect?(): Promise<Queryable & { release(): void }>;
  /**
   * One embedded connection (PGlite): a transaction that holds the connection until it
   * ends, so nothing else runs on it in between.
   */
  transaction?<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Run work in one transaction that has its connection to itself (D-063, D-065).
 *
 * Two callers interleaving on one connection would share one transaction: one could
 * commit or roll back the other's statements, or run with the other's claims. A pool
 * (anything with `connect()`, as node-postgres's `Pool`) lends a connection for the
 * transaction and gets it back even when the work fails; PGlite runs it as its own
 * `transaction`, which holds its single connection until the end; anything else (one
 * plain client) is taken one transaction at a time.
 *
 * The work must use the `tx` it is given. The outer connection waits for the transaction
 * to end (on PGlite, for ever), so a slip shows up as a hang in a test rather than a
 * statement quietly run outside the transaction.
 */
export async function inTransaction<T>(
  db: Queryable,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (db.connect) {
    const client = await db.connect();
    try {
      return await beginCommit(client, work);
    } finally {
      client.release();
    }
  }
  if (db.transaction) return db.transaction(work);
  return oneAtATime(db, () => beginCommit(db, work));
}

/**
 * Run work as a signed-in user, with row level security deciding what they can reach.
 *
 * The claims and the role are set with `set local`, so they last exactly as long as the
 * transaction and cannot leak to the next request that borrows the same pooled
 * connection. This is the only way the application should read tenant data: the
 * alternative is passing an org_id by hand and hoping every query remembers to. The
 * transaction is `inTransaction`'s, so concurrent requests each run as their own user.
 */
export async function withUser<T>(
  db: Queryable,
  authUserId: string,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return inTransaction(db, async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: authUserId }),
    ]);
    await tx.query('set local role authenticated');
    return work(tx);
  });
}

async function beginCommit<T>(tx: Queryable, work: (tx: Queryable) => Promise<T>): Promise<T> {
  await tx.query('begin');
  try {
    const result = await work(tx);
    await tx.query('commit');
    return result;
  } catch (error) {
    await tx.query('rollback');
    throw error;
  }
}

const queues = new WeakMap<Queryable, Promise<unknown>>();

/** Runs `work` after every earlier call for the same connection has finished. */
function oneAtATime<T>(db: Queryable, work: () => Promise<T>): Promise<T> {
  const before = queues.get(db) ?? Promise.resolve();
  const run = before.then(work, work);
  queues.set(
    db,
    run.catch(() => undefined),
  );
  return run;
}
