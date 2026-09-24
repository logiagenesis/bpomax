import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * ARB-300 acceptance: "no browser automation anywhere in codebase (grep check in CI)".
 * The check is scripts/check-no-browser-automation.sh, run in CI's unit job. Here it runs
 * on this repository, and on throwaway trees with one planted finding each, so a check
 * that stopped finding things would fail too. The driver names and the launch call are
 * assembled at run time, so this file is not itself a finding.
 */
const SCRIPT = resolve(__dirname, '../scripts/check-no-browser-automation.sh');
const PUPPETEER = ['pup', 'peteer'].join('');
const PLAYWRIGHT = ['play', 'wright'].join('');
const LAUNCH = ['chromium', 'launch'].join('.');
const trees: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arb-browser-check-'));
  trees.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function check(root: string): { passed: boolean; output: string } {
  try {
    return { passed: true, output: execFileSync('sh', [SCRIPT, root], { encoding: 'utf8' }) };
  } catch (error) {
    return { passed: false, output: String((error as { stdout?: string }).stdout ?? '') };
  }
}

const ROOT_MANIFEST = JSON.stringify(
  { devDependencies: { [`@${PLAYWRIGHT}/test`]: '^1.57.0', vitest: '^3.2.4' } },
  null,
  2,
);

afterEach(() => {
  for (const root of trees.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the no-browser-automation check', () => {
  it('passes on this repository', () => {
    const result = check(resolve(__dirname, '..'));
    expect(result.output).toContain('No browser automation outside e2e/.');
    expect(result.passed).toBe(true);
  });

  it('allows the end-to-end test runner in the root manifest and in e2e/', () => {
    const root = tree({
      'package.json': ROOT_MANIFEST,
      'e2e/page.spec.ts': `import { test } from '@${PLAYWRIGHT}/test';\nawait ${LAUNCH}();\n`,
      'apps/api/src/index.ts': 'export const x = 1;\n',
    });
    expect(check(root).passed).toBe(true);
  });

  it.each([
    [
      'a driver in a workspace manifest',
      {
        'apps/workers/package.json': JSON.stringify(
          { dependencies: { [PUPPETEER]: '^23' } },
          null,
          2,
        ),
      },
    ],
    [
      'a second driver in the root manifest',
      {
        'package.json': JSON.stringify(
          { devDependencies: { [`@${PLAYWRIGHT}/test`]: '^1', [PLAYWRIGHT]: '^1' } },
          null,
          2,
        ),
      },
    ],
    ['an import in a package', { 'packages/core/src/a.ts': `import x from '${PUPPETEER}';\n` }],
    [
      'a require in a script',
      { 'scripts/grab.cjs': `const { chromium } = require('${PLAYWRIGHT}-core');\n` },
    ],
    [
      'a dynamic import of a sub-path',
      { 'apps/api/src/b.ts': `await import('${PLAYWRIGHT}/lib/server');\n` },
    ],
    ['a browser launched', { 'apps/workers/src/c.ts': `await ${LAUNCH}({ headless: true });\n` }],
  ])('fails on %s', (_what, files) => {
    const root = tree({ 'package.json': ROOT_MANIFEST, ...files });
    const result = check(root);
    expect(result.passed).toBe(false);
    expect(result.output).toMatch(/^Browser automation in (a dependency list|the code)/m);
  });
});
