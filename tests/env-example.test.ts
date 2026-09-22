import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ARB-004 acceptance: "every variable in 01-J present in .env.example".
 *
 * Rather than trust a hand comparison, this reads section J of the spec and checks
 * .env.example against it, so the two cannot drift apart unnoticed.
 */
const spec = readFileSync(new URL('../docs/01-MASTER-BUILD-PROMPT.md', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

function sectionJ(): string {
  const start = spec.indexOf('## J. Environment variables');
  const end = spec.indexOf('## K.', start);
  expect(start, 'section J not found in docs/01').toBeGreaterThan(-1);
  expect(end, 'section K not found in docs/01').toBeGreaterThan(start);
  return spec.slice(start, end);
}

/** Env var names are SCREAMING_SNAKE_CASE; every name in section J contains an underscore. */
function namesIn(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])].sort();
}

const specNames = namesIn(sectionJ());
const exampleNames = namesIn(
  envExample
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n'),
);

describe('.env.example', () => {
  it('reads a non-trivial variable list out of docs/01 section J', () => {
    expect(specNames.length).toBeGreaterThan(20);
  });

  it('declares every variable named in docs/01 section J', () => {
    const missing = specNames.filter((name) => !exampleNames.includes(name));
    expect(missing, `missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('declares no variable that docs/01 section J does not name', () => {
    const extra = exampleNames.filter((name) => !specNames.includes(name));
    expect(extra, `not in docs/01 section J: ${extra.join(', ')}`).toEqual([]);
  });

  it('ships with the outbound safety gate off', () => {
    expect(envExample).toMatch(/^LIVE_MODE=false$/m);
  });
});
