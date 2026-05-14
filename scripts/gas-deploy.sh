#!/usr/bin/env bash
# Push local Apps Script sources to Google, then create a NEW deployment version.
# Requires: npm i -g @google/clasp && clasp login (once)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp not found. Install: npm i -g @google/clasp" >&2
  exit 1
fi

echo "==> clasp push"
clasp push --force

DESC="Alma ERP deploy $(date -u +%Y-%m-%dT%H:%MZ)"
echo "==> clasp deploy -d \"$DESC\""
OUT="$(clasp deploy -d "$DESC" 2>&1)" || {
  echo "$OUT" >&2
  echo "clasp deploy failed." >&2
  exit 1
}
echo "$OUT"

# Expected line: Deployed <deploymentId> @<versionNumber>
DEPLOY_ID="$(echo "$OUT" | sed -n 's/^Deployed \([^ ]*\) @.*/\1/p')"
VERSION="$(echo "$OUT" | sed -n 's/^Deployed [^ ]* @\([0-9]*\).*/\1/p')"

echo ""
echo "=== Deployment ==="
echo "Deployment ID: ${DEPLOY_ID:-<parse failed — see line above>}"
echo "Version:       @${VERSION:-?}"
echo "Web app URL:   https://script.google.com/macros/s/${DEPLOY_ID}/exec"
echo ""
echo "Update NEXT_PUBLIC_API_URL in .env.local to the Web app URL, then restart Next.js."
