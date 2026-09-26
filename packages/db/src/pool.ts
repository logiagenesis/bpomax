import pg from 'pg';
import type { Queryable } from './client.js';

/**
 * The production database connection (ARB-510, the owner's audit E-01): a node-postgres
 * pool behind the same `Queryable` interface the tests use with PGlite.
 *
 * The code was written and tested against PGlite, so the pool returns values in PGlite's
 * shapes, not node-postgres's defaults, and `pool.test.ts` holds the two side by side
 * against a real Postgres:
 *
 * - `bigint` as a number, as PGlite does. The bigints here are counts and money in minor
 *   units, far below 2^53; node-postgres's default would hand back a string.
 * - `date` as a `Date` at midnight UTC, as PGlite does; node-postgres's default is
 *   midnight in the host's time zone. (`timestamp` without a zone is read in the host's
 *   time zone by both.)
 * - `interval` as Postgres's own text, as PGlite does, not node-postgres's object.
 * - `numeric` stays a string, `timestamptz` a `Date`, `json` and `jsonb` parsed: the
 *   same in both.
 *
 * `affectedRows` is node-postgres's `rowCount`, the name PGlite uses.
 */
export interface PoolOptions {
  /** DATABASE_URL. For a hosted Postgres, include the provider's `sslmode` in it. */
  readonly connectionString: string;
  readonly max?: number;
  /** Shows in `pg_stat_activity`, so an operator can tell the processes apart. */
  readonly applicationName?: string;
  /** An idle connection's error, such as the server dropping it; the pool replaces it. */
  readonly onError?: (error: Error) => void;
}

export interface DatabasePool extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  /** Waits for borrowed connections to come back, then closes every connection. */
  end(): Promise<void>;
}

const INT8 = 20;
const INT8_ARRAY = 1016;
const DATE = 1082;
const INTERVAL = 1186;

const parseInt8 = (value: string): number => Number(value);
const parseDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** node-postgres's own parsers, except where PGlite answers differently. */
export const PGLITE_COMPATIBLE_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (format === 'binary') return pg.types.getTypeParser(oid, 'binary');
    if (oid === INT8) return parseInt8;
    if (oid === DATE) return parseDate;
    if (oid === INTERVAL) return (value: string) => value;
    if (oid === INT8_ARRAY) {
      const parseArray = (
        pg.types.getTypeParser as (oid: number, format: 'text') => (value: string) => unknown
      )(INT8_ARRAY, 'text') as (value: string) => (string | null)[];
      return (value: string) => parseArray(value).map((v) => (v === null ? null : Number(v)));
    }
    return pg.types.getTypeParser(oid, 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
};

function adapt(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return {
        rows: result.rows as T[],
        ...(result.rowCount === null ? {} : { affectedRows: result.rowCount }),
      };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

export function createPool(options: PoolOptions): DatabasePool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    types: PGLITE_COMPATIBLE_TYPES,
    ...(options.applicationName ? { application_name: options.applicationName } : {}),
  });
  // An idle connection that the server drops (a restart, a failover) is replaced on the
  // next query; without a listener its error would crash the process.
  pool.on('error', (error) => options.onError?.(error));
  const shared = adapt(pool);
  return {
    query: shared.query,
    exec: shared.exec!,
    async connect() {
      const client = await pool.connect();
      return { ...adapt(client), release: () => client.release() };
    },
    end: () => pool.end(),
  };
}
