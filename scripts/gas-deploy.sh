#!/usr/bin/env bash
# Push Apps Script sources, then redeploy the SAME production web-app deployment forever.
# Requires: npm i -g @google/clasp && clasp login (once)
#
# Deployment ID lives in config/gas-production-deployment.txt (one line).
# Override path: GAS_DEPLOYMENT_ID_FILE=/path/to/file
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEPLOY_ID_FILE="${GAS_DEPLOYMENT_ID_FILE:-$ROOT/config/gas-production-deployment.txt}"
RELEASE_FILE="$ROOT/Gas_Release.gs.js"

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp not found. Install: npm i -g @google/clasp" >&2
  exit 1
fi

if [[ ! -f "$DEPLOY_ID_FILE" ]]; then
  echo "Missing deployment id file: $DEPLOY_ID_FILE" >&2
  echo "Copy config/gas-production-deployment.example.txt → config/gas-production-deployment.txt and paste your Web App deployment ID." >&2
  exit 1
fi

DEPLOYMENT_ID="$(grep -v '^[[:space:]]*#' "$DEPLOY_ID_FILE" | head -1 | tr -d '[:space:]')"
if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "Deployment id is empty after stripping comments: $DEPLOY_ID_FILE" >&2
  exit 1
fi

STAMP="$(date -u +%Y-%m-%dT%H:%MZ)"
DESC="Alma ERP deploy ${STAMP}"

if [[ -f "$RELEASE_FILE" ]]; then
  echo "==> Stamp Gas_Release.gs.js → GAS_RELEASE_STAMP = $STAMP"
  perl -pi -e "s/var GAS_RELEASE_STAMP = '[^']*';/var GAS_RELEASE_STAMP = '$STAMP';/" "$RELEASE_FILE"
fi

echo "==> clasp push (sync sources)"
clasp push --force

echo "==> clasp deploy -i \"$DEPLOYMENT_ID\" -d \"$DESC\""
OUT="$(clasp deploy -i "$DEPLOYMENT_ID" -d "$DESC" 2>&1)" || {
  echo "$OUT" >&2
  echo "clasp deploy failed — production URL unchanged." >&2
  exit 1
}
echo "$OUT"

VERSION=""
if [[ "$OUT" =~ Deployed[[:space:]]+[^[:space:]]+[[:space:]]+@([0-9]+) ]]; then
  VERSION="${BASH_REMATCH[1]}"
fi
if [[ -z "$VERSION" ]]; then
  VERSION="$(echo "$OUT" | sed -n 's/^Deployed [^ ]* @\([0-9]*\).*/\1/p')"
fi

BASE_URL="https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec"
echo ""
echo "=== Stable production web app (same forever) ==="
echo "Deployment ID: $DEPLOYMENT_ID"
echo "Clasp version: @${VERSION:-unknown}  (Google internal snapshot id)"
echo "Release stamp: $STAMP  (echoed by api_health.gas_release_stamp)"
echo "Exec URL:      $BASE_URL"
if [[ -n "${VERSION:-}" ]]; then
  echo ""
  echo "Optional — set on Vercel (Settings → Env) after each deploy:"
  echo "  GAS_CLASP_VERSION=${VERSION}"
fi
echo ""
echo "Ensure NEXT_PUBLIC_API_URL (and Vercel env) stays:"
echo "  $BASE_URL"
echo ""
echo "Smoke (public GET, no secret — follows redirects):"
echo "  curl -fsSL \"${BASE_URL}?route=api_health\""
