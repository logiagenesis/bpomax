#!/bin/sh
# ARB-300 acceptance: no browser automation anywhere in the codebase. docs/01 section B:
# Upwork is read through its official API only, and "Never automate a logged-in browser
# session"; the same holds for every marketplace. The one browser driver allowed is
# Playwright's test runner in e2e/, which drives this app's own pages against stand-ins
# and never visits a marketplace.
#
# Usage: sh scripts/check-no-browser-automation.sh [root]   (exit 1 on any finding)
set -eu
root="${1:-.}"
cd "$root"

drivers='@playwright/[a-z-]+|playwright[a-z-]*|puppeteer[a-z-]*|selenium-webdriver|webdriverio|nightmare|cypress|phantomjs[a-z-]*'
status=0

# Dependencies: no driver in any workspace manifest, and none in the root's but the test
# runner the end-to-end tests use.
manifests=$(ls package.json apps/*/package.json packages/*/package.json 2>/dev/null || true)
if [ -n "$manifests" ]; then
  deps=$(grep -nHE "^[[:space:]]*\"($drivers)\"[[:space:]]*:" $manifests |
    grep -vE '^package\.json:[0-9]+:[[:space:]]*"@playwright/test"[[:space:]]*:' || true)
  if [ -n "$deps" ]; then
    echo "Browser automation in a dependency list (only e2e/ may use @playwright/test):"
    echo "$deps"
    status=1
  fi
fi

# Lighthouse (ARB-440) measures this app's own built pages and reaches Chrome through its
# own puppeteer-core, so it too is allowed in the root manifest only.
if [ -n "$manifests" ]; then
  lh=$(grep -nHE '^[[:space:]]*"lighthouse"[[:space:]]*:' $manifests | grep -v '^package\.json:' || true)
  if [ -n "$lh" ]; then
    echo "Browser automation in a dependency list (only the root may use lighthouse, for e2e/lighthouse.mjs):"
    echo "$lh"
    status=1
  fi
fi

# The whole dependency tree (the owner's audit Q-08): a driver may arrive only by these
# three routes, the test runner's own two and Lighthouse's. Any other package that pulls a
# driver in, however deep, is a finding.
if [ -f pnpm-lock.yaml ]; then
  transitive=$(awk -v drivers="^($drivers)$" '
    /^snapshots:/ { in_snapshots = 1; next }
    in_snapshots && /^[^ ]/ { in_snapshots = 0 }
    in_snapshots && /^  [^ ]/ {
      key = $0; sub(/^  /, "", key); gsub(/\047/, "", key); sub(/:.*$/, "", key)
      if (substr(key, 1, 1) == "@") { rest = substr(key, 2); parent = "@" substr(rest, 1, index(rest, "@") - 1) }
      else { parent = substr(key, 1, index(key, "@") - 1) }
      next
    }
    in_snapshots && /^      [^ ]/ {
      dep = $1; sub(/:$/, "", dep); gsub(/\047/, "", dep)
      if (dep ~ drivers) {
        pair = parent ">" dep
        if (pair != "@playwright/test>playwright" && pair != "playwright>playwright-core" && pair != "lighthouse>puppeteer-core")
          print "pnpm-lock.yaml: " parent " depends on " dep
      }
    }
  ' pnpm-lock.yaml)
  if [ -n "$transitive" ]; then
    echo "Browser automation in a dependency list (a driver pulled in by a package other than the test runner or Lighthouse):"
    echo "$transitive"
    status=1
  fi
fi

# Source: no import, require or launch of a browser driver outside e2e/.
dirs=$(for d in apps packages scripts tests; do if [ -d "$d" ]; then echo "$d"; fi; done)
if [ -n "$dirs" ]; then
  code=$(grep -rnE \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dist-demo \
    -e "(from|require\(|import\()[[:space:]]*['\"]($drivers)(/[^'\"]*)?['\"]" \
    -e "(chromium|firefox|webkit)\.launch(Persistent[A-Za-z]*)?\(" \
    $dirs || true)
  if [ -n "$code" ]; then
    echo "Browser automation in the code (only e2e/ may drive a browser, and only this app's pages):"
    echo "$code"
    status=1
  fi
fi

[ "$status" -eq 0 ] && echo "No browser automation outside e2e/."
exit "$status"
