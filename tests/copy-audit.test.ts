import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ARB-440 acceptance, "Copy audit passes": docs/05 section 2 as a test over every page's
 * visible text, and over every sentence the pages' scripts can show. It fails on
 * scarcity or countdown copy, earnings claims and guarantees, invented social proof,
 * placeholder text, and US spellings, and it checks every page is marked en-GB. What a
 * pattern cannot judge, that each claim is one the product can prove, is the reviewed
 * table in docs/audit/index.md.
 */
const WEB = fileURLToPath(new URL('../apps/web/src/', import.meta.url));

const PAGES = readdirSync(WEB).filter((name) => name.endsWith('.html'));

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** The sentences a script puts on screen: string literals that read as prose. */
function scriptSentences(source: string): string[] {
  const literals = source.match(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g) ?? [];
  return literals
    .map((literal) => literal.slice(1, -1))
    .filter((text) => /^[A-Z][a-z]/.test(text) && text.includes(' '));
}

function scripts(dir: string): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...scripts(path));
    else if (entry.name.endsWith('.js'))
      found.push({ file: path, text: readFileSync(path, 'utf8') });
  }
  return found;
}

const BANNED: [RegExp, string][] = [
  // Scarcity and countdowns (docs/05 2.3; docs/01 H: "no fake scarcity").
  [/\bonly \d+ (left|remaining|spots?|places?|seats?)\b/i, 'scarcity'],
  [/\b(spots?|places?|seats?) left\b/i, 'scarcity'],
  [/\blimited[- ]time\b/i, 'scarcity'],
  [/\b(hurry|act now|last chance|don'?t miss out|while (stocks|supplies) last)\b/i, 'urgency'],
  [/\b(countdown|offer ends|ends (today|tonight|soon))\b/i, 'countdown'],
  // Earnings claims and guarantees (docs/05 2.3).
  [/\bguarantee[ds]?\b/i, 'guarantee'],
  [/\b(make money|passive income|get rich|earn (up to )?(R|\$|USD))\b/i, 'earnings claim'],
  [/\b\d+x (more|your|faster)\b/i, 'unprovable multiple'],
  [/\b(increase|double|triple) your (income|revenue|earnings|profit)\b/i, 'earnings claim'],
  // Invented social proof (docs/01 H: "no fake reviews").
  [/\b(trusted by|as seen (on|in)|testimonials?|5[- ]star|five[- ]star)\b/i, 'social proof'],
  [
    /\b(thousands|hundreds|millions) of (customers|users|freelancers|agencies|clients)\b/i,
    'social proof',
  ],
  [/★/, 'star rating'],
  // Placeholder text.
  [/\b([Ll]orem ipsum|TODO|FIXME|TBD)\b/, 'placeholder'],
];

const US_SPELLINGS =
  /\b(colors?|colored|favorites?|organizations?|organize[ds]?|analyze[ds]?|centers?|centered|behaviors?|catalogs?|canceled|canceling|labeled|labeling|modeling|traveled|gray)\b/i;

describe('the copy audit (docs/05 section 2)', () => {
  it('finds the pages', () => {
    expect(PAGES).toContain('index.html');
    expect(PAGES.length).toBeGreaterThan(15);
  });

  it.each(PAGES)('%s is marked UK English and has no placeholder link', (page) => {
    const html = readFileSync(join(WEB, page), 'utf8');
    expect(html).toMatch(/<html lang="en-GB">/);
    expect(html).not.toMatch(/href="#"/);
  });

  it.each(PAGES)('%s has no scarcity, earnings claim, invented proof or placeholder', (page) => {
    const text = visibleText(readFileSync(join(WEB, page), 'utf8'));
    for (const [pattern, kind] of BANNED) {
      expect(text.match(pattern)?.[0] ?? null, `${kind} in ${page}`).toBeNull();
    }
  });

  it.each(PAGES)('%s is in UK spelling', (page) => {
    const text = visibleText(readFileSync(join(WEB, page), 'utf8'));
    expect(text.match(US_SPELLINGS)?.[0] ?? null, `US spelling in ${page}`).toBeNull();
  });

  it('no script shows a sentence with scarcity, an earnings claim, invented proof or US spelling', () => {
    const problems: string[] = [];
    for (const { file, text } of scripts(WEB)) {
      for (const sentence of scriptSentences(text)) {
        for (const [pattern, kind] of BANNED) {
          if (pattern.test(sentence)) problems.push(`${kind}: "${sentence}" (${file})`);
        }
        const us = sentence.match(US_SPELLINGS);
        if (us) problems.push(`US spelling "${us[0]}": "${sentence}" (${file})`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('would catch each kind it looks for', () => {
    const samples = [
      'Only 3 spots left!',
      'A limited-time offer',
      'Hurry, the offer ends today',
      'Guaranteed wins',
      'Make money while you sleep',
      'Win 10x more jobs',
      'Trusted by thousands of freelancers',
      'Rated ★★★★★',
      'Lorem ipsum',
    ];
    for (const sample of samples) {
      expect(
        BANNED.some(([pattern]) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
    for (const word of ['color', 'organization', 'analyze', 'canceled', 'behavior']) {
      expect(US_SPELLINGS.test(`The ${word} here`), word).toBe(true);
    }
    for (const word of ['colour', 'organisation', 'analyse', 'cancelled', 'behaviour']) {
      expect(US_SPELLINGS.test(`The ${word} here`), word).toBe(false);
    }
  });
});
