#!/usr/bin/env bash
# Push regression secrets to GitHub Actions (never prints secret values).
# Requires: gh auth login
set -euo pipefail
cd "$(dirname "$0")/.."

GH="$(command -v gh 2>/dev/null || true)"
if [[ -z "$GH" ]]; then
  GH="$(find /tmp -maxdepth 4 -name gh -type f 2>/dev/null | head -1)"
fi
if [[ -z "$GH" || ! -x "$GH" ]]; then
  echo "Install GitHub CLI: https://cli.github.com/ — then: gh auth login"
  exit 1
fi

REGRESSION_BASE_URL="${REGRESSION_BASE_URL:-https://alma-erp-six.vercel.app}"

echo "Setting REGRESSION_BASE_URL repository variable..."
"$GH" variable set REGRESSION_BASE_URL --body "$REGRESSION_BASE_URL" 2>/dev/null || \
  "$GH" secret set REGRESSION_BASE_URL --body "$REGRESSION_BASE_URL"

load_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

load_env .env
load_env .env.local
load_env .env.regression.local

if [[ -f .regression-cookie && -z "${REGRESSION_COOKIE:-}" ]]; then
  REGRESSION_COOKIE="$(tr -d '\n' < .regression-cookie)"
  export REGRESSION_COOKIE
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Setting DATABASE_URL..."
  printf '%s' "$DATABASE_URL" | "$GH" secret set DATABASE_URL
else
  echo "WARN: DATABASE_URL not in env — set manually in GitHub → Settings → Secrets"
fi

if [[ -n "${CRON_SECRET:-}" ]]; then
  echo "Setting CRON_SECRET..."
  printf '%s' "$CRON_SECRET" | "$GH" secret set CRON_SECRET
else
  echo "WARN: CRON_SECRET not in env"
fi

if [[ -f .regression-cookie ]]; then
  echo "Setting REGRESSION_COOKIE from .regression-cookie..."
  "$GH" secret set REGRESSION_COOKIE < .regression-cookie
elif [[ -n "${REGRESSION_COOKIE:-}" ]]; then
  echo "Setting REGRESSION_COOKIE..."
  printf '%s' "$REGRESSION_COOKIE" | "$GH" secret set REGRESSION_COOKIE
elif [[ -n "${REGRESSION_IDENTIFIER:-}" && -n "${REGRESSION_PASSWORD:-}" ]]; then
  echo "Setting REGRESSION_IDENTIFIER + REGRESSION_PASSWORD..."
  printf '%s' "$REGRESSION_IDENTIFIER" | "$GH" secret set REGRESSION_IDENTIFIER
  printf '%s' "$REGRESSION_PASSWORD" | "$GH" secret set REGRESSION_PASSWORD
else
  echo "WARN: No REGRESSION_COOKIE or credentials — see docs/REGRESSION_AUTH_SETUP.md"
  exit 1
fi

echo "Done. Verify with: $GH secret list"
