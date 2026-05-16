#!/usr/bin/env bash
# Smoke-test public GAS GET routes + optional Next /api/health (prod URL).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set -a
[[ -f .env.local ]] && . ./.env.local
set +a

BASE="${NEXT_PUBLIC_API_URL:?Set NEXT_PUBLIC_API_URL in .env.local}"

pretty() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

echo "=== api_health"
curl -fsSL "${BASE}?route=api_health" | pretty

echo ""
echo "=== core reads (business-scoped)"
set +e
for qs in \
  "route=products" \
  "route=stock" \
  "route=orders&business_id=ALMA_LIFESTYLE" \
  "route=finance&business_id=ALMA_LIFESTYLE" \
  "route=hr_payroll&business_id=ALMA_LIFESTYLE" \
  "route=audit_log&business_id=ALMA_LIFESTYLE&limit=3"; do
  echo "-- ${qs}"
  if ! curl -fsSL "${BASE}?${qs}" | head -c 400 | pretty; then
    echo "[FAIL] ${qs}"
  fi
  echo ""
done
set -e

echo "=== invoices (next_invoice_num)"
curl -fsSL "${BASE}?route=next_invoice_num" | pretty

NEXT="${NEXT_PUBLIC_APP_URL:-}"
echo ""
if [[ -n "${NEXT}" ]]; then
  echo "=== Next /api/health → ${NEXT}/api/health"
  curl -fsSL "${NEXT}/api/health" | pretty || echo "(Next health unreachable)"
else
  echo "(Skip Next /api/health — set NEXT_PUBLIC_APP_URL to hit deployed Vercel)"
fi
