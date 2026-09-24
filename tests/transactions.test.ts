import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D-063 and D-065: a transaction is opened in one place, `inTransaction` in
 * packages/db/src/client.ts, which gives it a connection of its own. A `begin` written
 * anywhere else would run on a shared connection again, where two jobs or two requests
 * share one transaction. This reads every source file and allows none.
 */
const ROOT = resolve(__dirname, '..');
const ALLOWED = 'packages/db/src/client.ts';
const BEGIN = /\.(query|exec)\(\s*['"`]\s*(begin|start transaction)\b/i;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-demo') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|js)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe('transactions', () => {
  it('are opened only by inTransaction in packages/db', () => {
    const files = [...sources(join(ROOT, 'apps')), ...sources(join(ROOT, 'packages'))];
    expect(files.length).toBeGreaterThan(50);
    const opening = files
      .filter((file) => BEGIN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(opening).toEqual([ALLOWED]);
  });
});
