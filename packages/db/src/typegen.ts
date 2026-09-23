import type { Queryable } from './client.js';

/**
 * Generated types for the `public` schema (ARB-010: "generated types committed").
 *
 * The output has the shape `supabase gen types typescript` produces — a `Database` type
 * with `Tables` (`Row`, `Insert`, `Update`, `Relationships`), `Views`, `Functions`,
 * `Enums` and `CompositeTypes`, plus the `Tables`, `TablesInsert`, `TablesUpdate` and
 * `Enums` helpers — so code written against it keeps compiling when the Supabase CLI
 * takes over (`pnpm db:types:supabase`, once docs/02 B-06 exists). Until then it is read
 * from the schema the migrations build (PGlite, D-009), so it can never describe a
 * table the migrations do not create; `typegen.test.ts` fails if the committed file
 * drifts from them. Functions are left empty: the only public functions are trigger
 * functions, which Supabase's generator also leaves out.
 */
interface ColumnRow {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  has_default: boolean;
  is_identity: 'YES' | 'NO';
  element_udt: string | null;
}

interface EnumRow {
  enum_name: string;
  label: string;
}

interface ForeignKeyRow {
  constraint_name: string;
  table_name: string;
  columns: string[];
  referenced_table: string;
  referenced_columns: string[];
  one_to_one: boolean;
}

const SCALARS: Record<string, string> = {
  bool: 'boolean',
  int2: 'number',
  int4: 'number',
  int8: 'number',
  float4: 'number',
  float8: 'number',
  numeric: 'number',
  json: 'Json',
  jsonb: 'Json',
  bytea: 'string',
  uuid: 'string',
  text: 'string',
  varchar: 'string',
  bpchar: 'string',
  date: 'string',
  time: 'string',
  timetz: 'string',
  timestamp: 'string',
  timestamptz: 'string',
  interval: 'string',
  inet: 'string',
  citext: 'string',
};

function tsType(udt: string, enums: ReadonlySet<string>): string {
  if (enums.has(udt)) return `Database['public']['Enums']['${udt}']`;
  return SCALARS[udt] ?? 'unknown';
}

function columnType(column: ColumnRow, enums: ReadonlySet<string>): string {
  const base =
    column.data_type === 'ARRAY'
      ? `${tsType(column.element_udt ?? column.udt_name.replace(/^_/, ''), enums)}[]`
      : tsType(column.udt_name, enums);
  return column.is_nullable === 'YES' ? `${base} | null` : base;
}

const key = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `'${name}'`);

export async function generateDatabaseTypes(db: Queryable): Promise<string> {
  const columns = await db.query<ColumnRow>(
    `select c.table_name, c.column_name, c.ordinal_position, c.data_type, c.udt_name, c.is_nullable,
            (c.column_default is not null) as has_default, c.is_identity,
            et.typname as element_udt
     from information_schema.columns c
     join information_schema.tables t
       on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     left join pg_type ut on ut.typname = c.udt_name
     left join pg_type et on et.oid = ut.typelem and c.data_type = 'ARRAY'
     where c.table_schema = 'public'
     order by c.table_name, c.column_name`,
  );
  const enumRows = await db.query<EnumRow>(
    `select t.typname as enum_name, e.enumlabel as label
     from pg_type t join pg_enum e on e.enumtypid = t.oid
     join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
     order by t.typname, e.enumsortorder`,
  );
  const foreignKeys = await db.query<ForeignKeyRow>(
    `select con.conname as constraint_name, rel.relname as table_name,
            array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord) as columns,
            frel.relname as referenced_table,
            array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord) as referenced_columns,
            exists (
              select 1 from pg_index i
              where i.indrelid = con.conrelid and i.indisunique
                and (select array_agg(x order by x) from unnest(i.indkey::int2[]) x)
                  = (select array_agg(x order by x) from unnest(con.conkey) x)
            ) as one_to_one
     from pg_constraint con
     join pg_class rel on rel.oid = con.conrelid
     join pg_class frel on frel.oid = con.confrelid
     join pg_namespace n on n.oid = rel.relnamespace
     where con.contype = 'f' and n.nspname = 'public'
     order by rel.relname, con.conname`,
  );

  const enums = new Map<string, string[]>();
  for (const row of enumRows.rows)
    enums.set(row.enum_name, [...(enums.get(row.enum_name) ?? []), row.label]);
  const enumNames = new Set(enums.keys());

  const tables = new Map<string, ColumnRow[]>();
  for (const row of columns.rows)
    tables.set(row.table_name, [...(tables.get(row.table_name) ?? []), row]);
  const relationships = new Map<string, ForeignKeyRow[]>();
  for (const row of foreignKeys.rows)
    relationships.set(row.table_name, [...(relationships.get(row.table_name) ?? []), row]);

  const lines: string[] = [];
  const out = (line: string) => lines.push(line);
  out(
    '// Generated by `pnpm db:types` from the migrations (packages/db/src/typegen.ts). Do not edit.',
  );
  out('// Once the Supabase project exists (docs/02 B-06), `pnpm db:types:supabase` replaces it.');
  out('');
  out('export type Json =');
  out('  | string');
  out('  | number');
  out('  | boolean');
  out('  | null');
  out('  | { [key: string]: Json | undefined }');
  out('  | Json[];');
  out('');
  out('export type Database = {');
  out('  public: {');
  out('    Tables: {');
  for (const [table, cols] of [...tables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out(`      ${key(table)}: {`);
    out('        Row: {');
    for (const col of cols)
      out(`          ${key(col.column_name)}: ${columnType(col, enumNames)};`);
    out('        };');
    out('        Insert: {');
    for (const col of cols) {
      const optional = col.is_nullable === 'YES' || col.has_default || col.is_identity === 'YES';
      out(
        `          ${key(col.column_name)}${optional ? '?' : ''}: ${columnType(col, enumNames)};`,
      );
    }
    out('        };');
    out('        Update: {');
    for (const col of cols)
      out(`          ${key(col.column_name)}?: ${columnType(col, enumNames)};`);
    out('        };');
    const rels = relationships.get(table) ?? [];
    if (rels.length === 0) {
      out('        Relationships: [];');
    } else {
      out('        Relationships: [');
      for (const rel of rels) {
        out('          {');
        out(`            foreignKeyName: '${rel.constraint_name}';`);
        out(`            columns: [${rel.columns.map((c) => `'${c}'`).join(', ')}];`);
        out(`            isOneToOne: ${String(rel.one_to_one)};`);
        out(`            referencedRelation: '${rel.referenced_table}';`);
        out(
          `            referencedColumns: [${rel.referenced_columns.map((c) => `'${c}'`).join(', ')}];`,
        );
        out('          },');
      }
      out('        ];');
    }
    out('      };');
  }
  out('    };');
  out('    Views: {');
  out('      [_ in never]: never;');
  out('    };');
  out('    Functions: {');
  out('      [_ in never]: never;');
  out('    };');
  out('    Enums: {');
  for (const [name, labels] of [...enums.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out(`      ${key(name)}: ${labels.map((l) => `'${l}'`).join(' | ')};`);
  }
  out('    };');
  out('    CompositeTypes: {');
  out('      [_ in never]: never;');
  out('    };');
  out('  };');
  out('};');
  out('');
  out("type PublicSchema = Database['public'];");
  out('');
  out(
    "export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];",
  );
  out(
    "export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert'];",
  );
  out(
    "export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update'];",
  );
  out("export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];");
  out('');
  out('export const Constants = {');
  out('  public: {');
  out('    Enums: {');
  for (const [name, labels] of [...enums.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out(`      ${key(name)}: [${labels.map((l) => `'${l}'`).join(', ')}],`);
  }
  out('    },');
  out('  },');
  out('} as const;');
  return `${lines.join('\n')}\n`;
}
