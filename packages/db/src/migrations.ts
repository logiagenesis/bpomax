import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface Migration {
  /** File name, e.g. `0001_identity.sql`. Ordering is lexical, which is why they are numbered. */
  readonly name: string;
  readonly sql: string;
}

/** Every migration in apply order. */
export function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}
