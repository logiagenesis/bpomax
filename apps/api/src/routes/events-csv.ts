import type { EventRow } from '@arbitron/db';

/**
 * The audit log as CSV (ARB-062).
 *
 * The export gets the same DD/MM/YYYY SAST date the page shows, and also the UTC
 * timestamp as stored, so a spreadsheet can sort it and a reviewer can match it to the
 * database.
 */

/** Past this, the export stops and says so in `x-export-truncated`, rather than grinding. */
export const EXPORT_ROW_CAP = 10_000;

const COLUMNS = [
  'date_sast',
  'created_at_utc',
  'type',
  'outcome',
  'actor_kind',
  'actor_user_id',
  'subject_table',
  'subject_id',
  'request_id',
  'payload',
  'id',
] as const;

/** SAST is UTC+2 all year (DECISIONS.md D-024). */
function sast(value: string | Date): string {
  const d = new Date(new Date(value).getTime() + 2 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * RFC 4180 quoting, plus protection against formula injection: a payload is written by
 * the system but can carry text that came from a client, and a cell that starts with
 * `=`, `+`, `-`, `@`, tab or carriage return is run as a formula by spreadsheet software.
 * Such a cell gets a leading apostrophe, which spreadsheets show as plain text.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function eventsToCsv(rows: readonly EventRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    const created = new Date(row.created_at);
    const values: Record<(typeof COLUMNS)[number], unknown> = {
      date_sast: sast(created),
      created_at_utc: created.toISOString(),
      type: row.type,
      outcome: row.outcome,
      actor_kind: row.actor_kind,
      actor_user_id: row.actor_user_id,
      subject_table: row.subject_table,
      subject_id: row.subject_id,
      request_id: row.request_id,
      payload: row.payload,
      id: row.id,
    };
    lines.push(COLUMNS.map((column) => csvCell(values[column])).join(','));
  }
  // CRLF per RFC 4180, and a trailing one so the last row is terminated too.
  return `${lines.join('\r\n')}\r\n`;
}
