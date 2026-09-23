import { readFileSync, writeFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from './testing.js';
import { generateDatabaseTypes } from './typegen.js';

/**
 * ARB-010: "generated types committed". The committed file must be exactly what the
 * migrations generate today; `pnpm db:types` rewrites it (UPDATE_TYPES=1).
 */
const TARGET = new URL('./types.generated.ts', import.meta.url);
let db: PGlite;
let generated = '';

beforeAll(async () => {
  db = await createTestDatabase();
  const raw = await generateDatabaseTypes(db);
  const file = fileURLToPath(TARGET);
  const options = (await resolveConfig(file)) ?? {};
  generated = await format(raw, { ...options, filepath: file });
  if (process.env.UPDATE_TYPES === '1') writeFileSync(TARGET, generated);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('generated types', () => {
  it('are committed exactly as the migrations generate them', () => {
    const committed = readFileSync(TARGET, 'utf8');
    expect(committed, 'run `pnpm db:types` after changing a migration').toBe(generated);
  });

  it('describe every table, with nullability, defaults and enums', () => {
    expect(generated).toMatch(/ {6}proposals: \{\n {8}Row: \{/);
    // Nullable column: `| null` on the row, optional on insert.
    expect(generated).toContain(
      "approved_via: Database['public']['Enums']['approval_channel'] | null;",
    );
    expect(generated).toContain(
      "approved_via?: Database['public']['Enums']['approval_channel'] | null;",
    );
    // Not null without a default: required on insert.
    expect(generated).toMatch(/Insert: \{[^}]*\n {10}body: string;/);
    // Not null with a default: optional on insert, never null on the row.
    expect(generated).toContain("status?: Database['public']['Enums']['proposal_status'];");
    expect(generated).toContain('skills: string[];');
    expect(generated).toContain('raw: Json;');
    expect(generated).toContain(
      "proposal_status: 'draft' | 'queued' | 'approved' | 'rejected' | 'submitted' | 'failed';",
    );
  });

  it('record foreign keys the way the Supabase client reads them', () => {
    expect(generated).toMatch(
      /foreignKeyName: 'proposals_job_id_fkey';\n {12}columns: \['job_id'\];\n {12}isOneToOne: false;\n {12}referencedRelation: 'jobs';\n {12}referencedColumns: \['id'\];/,
    );
    // pipeline_items.job_id is unique, so each job has at most one pipeline item.
    expect(generated).toMatch(
      /foreignKeyName: 'pipeline_items_job_id_fkey';\n {12}columns: \['job_id'\];\n {12}isOneToOne: true;/,
    );
  });
});
