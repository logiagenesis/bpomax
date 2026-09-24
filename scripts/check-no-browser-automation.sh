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
