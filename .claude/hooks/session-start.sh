#!/bin/bash
# Prepares Claude Code cloud sessions: dependencies, the gitleaks binary the
# husky pre-commit hook requires, and a full build (cli.test.ts needs the SPA).
# Local sessions are untouched. Idempotent.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# npm ci: installs exactly what package-lock.json pins and never rewrites it
# (npm install did, dropping fields the container's npm does not write).
npm ci --no-audit --no-fund

# gitleaks: pinned release, verified against its published SHA-256.
GITLEAKS_VERSION=8.24.3
GITLEAKS_SHA256=9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c
if ! gitleaks version 2>/dev/null | grep -qx "$GITLEAKS_VERSION"; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/gitleaks.tgz" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  echo "$GITLEAKS_SHA256  $tmp/gitleaks.tgz" | sha256sum -c -
  tar -xzf "$tmp/gitleaks.tgz" -C "$tmp" gitleaks
  install -m 0755 "$tmp/gitleaks" /usr/local/bin/gitleaks
fi

# Bundles + webview SPA, so dist/-based tests (cli.test.ts, claude-hook.test.ts) run.
node esbuild.js
npm run build:webview
