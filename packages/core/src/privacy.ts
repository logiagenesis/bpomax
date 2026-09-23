import type { FieldError, ValidationResult } from './scanners.js';

/**
 * The privacy notice (ARB-015, docs/02 T-06).
 *
 * The wording is the owner's, settled with a legal adviser, and none is written here
 * (docs/01 rule 6). This is the shape the owner's text is published in, at
 * `apps/web/src/public/privacy-notice.json`, and the rule that holds it: a notice is
 * either `pending`, with no wording at all, or `approved`, naming who approved it and
 * when. A draft cannot be shown by accident, because a pending notice with sections in
 * it is refused, and so is an approved one without its approval.
 */
export interface PrivacyNoticeSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export type PrivacyNotice =
  | { readonly status: 'pending' }
  | {
      readonly status: 'approved';
      /** Who approved the wording: the owner or the legal adviser. */
      readonly approvedBy: string;
      /** YYYY-MM-DD, the day it was approved. */
      readonly approvedOn: string;
      /** The owner's own version label, shown with the notice. */
      readonly version: string;
      readonly sections: readonly PrivacyNoticeSection[];
    };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parsePrivacyNotice(input: unknown): ValidationResult<PrivacyNotice> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'notice', message: 'must be an object' }] };
  }
  const notice = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const sections = notice.sections ?? [];

  if (notice.status === 'pending') {
    if (!Array.isArray(sections) || sections.length > 0) {
      errors.push({
        field: 'sections',
        message: 'must be empty while the notice is pending; no draft wording is published',
      });
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { status: 'pending' } };
  }

  if (notice.status !== 'approved') {
    return { ok: false, errors: [{ field: 'status', message: 'must be pending or approved' }] };
  }
  if (!nonEmptyText(notice.approvedBy)) {
    errors.push({ field: 'approvedBy', message: 'must name who approved the wording' });
  }
  if (typeof notice.approvedOn !== 'string' || !isRealDate(notice.approvedOn)) {
    errors.push({ field: 'approvedOn', message: 'must be the approval date as YYYY-MM-DD' });
  }
  if (!nonEmptyText(notice.version)) {
    errors.push({ field: 'version', message: 'must be set' });
  }
  const parsed: PrivacyNoticeSection[] = [];
  if (!Array.isArray(sections) || sections.length === 0) {
    errors.push({ field: 'sections', message: 'must hold the approved wording' });
  } else {
    sections.forEach((section: unknown, index) => {
      const field = `sections[${String(index)}]`;
      const s = (typeof section === 'object' && section !== null ? section : {}) as Record<
        string,
        unknown
      >;
      if (!nonEmptyText(s.heading))
        errors.push({ field: `${field}.heading`, message: 'must be set' });
      const paragraphs = s.paragraphs;
      if (
        !Array.isArray(paragraphs) ||
        paragraphs.length === 0 ||
        !paragraphs.every((p) => nonEmptyText(p))
      ) {
        errors.push({
          field: `${field}.paragraphs`,
          message: 'must be one or more paragraphs of text',
        });
      } else if (nonEmptyText(s.heading)) {
        parsed.push({ heading: s.heading.trim(), paragraphs: paragraphs.map((p) => p.trim()) });
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      status: 'approved',
      approvedBy: (notice.approvedBy as string).trim(),
      approvedOn: notice.approvedOn as string,
      version: (notice.version as string).trim(),
      sections: parsed,
    },
  };
}
