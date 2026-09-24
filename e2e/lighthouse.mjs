// ARB-440 acceptance: "Lighthouse ≥ 90 on all categories". Runs Lighthouse against the
// built public pages (apps/web/dist, from `pnpm build:web:e2e`), served from disk by a small
// static server, in the Chromium the end-to-end tests use. It visits only this app's own
// pages (D-066: e2e/ is the one place a browser is driven). Exits 1 when any page scores
// below 90 in any category, and prints every score either way.
//
// Usage: node e2e/lighthouse.mjs [page.html ...]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';

const DIST = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const PAGES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['index.html', 'signup.html', 'login.html', 'privacy.html', 'terms.html'];
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const MINIMUM = 0.9;
const DEBUG_PORT = 9333;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** @param {string} line */
const log = (line) => process.stdout.write(`${line}\n`);

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  const file = normalize(join(DIST, path === '/' ? 'index.html' : path));
  if (!file.startsWith(DIST.endsWith(sep) ? DIST : `${DIST}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Hashed assets never change; pages are revalidated, as a host would serve them.
      'cache-control': file.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
  args: [`--remote-debugging-port=${DEBUG_PORT}`],
});

let failed = false;
try {
  for (const page of PAGES) {
    const result = await lighthouse(`${origin}/${page}`, {
      port: DEBUG_PORT,
      output: 'json',
      logLevel: 'error',
      onlyCategories: CATEGORIES,
    });
    const categories = result?.lhr.categories ?? {};
    const scores = CATEGORIES.map((key) => [key, categories[key]?.score ?? 0]);
    const low = scores.filter(([, score]) => score < MINIMUM);
    log(
      `${low.length ? 'FAIL' : 'ok  '} ${page.padEnd(14)} ${scores
        .map(([key, score]) => `${key} ${Math.round(score * 100)}`)
        .join(', ')}`,
    );
    for (const [key] of low) {
      const audits = (categories[key]?.auditRefs ?? [])
        .map((ref) => result.lhr.audits[ref.id])
        .filter(
          (audit) =>
            audit &&
            audit.score !== null &&
            audit.score < 1 &&
            audit.scoreDisplayMode !== 'informative',
        );
      for (const audit of audits.slice(0, 8)) log(`       ${key}: ${audit.id} — ${audit.title}`);
    }
    if (low.length) failed = true;
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
