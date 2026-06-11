#!/usr/bin/env bash
# Clear failed 20260611200000_agent_phase6_schema and re-apply migrations.
# Run from repo root on VPS: bash scripts/resolve-phase6-migration.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f /opt/alma-erp/worker/.env ]]; then
    DATABASE_URL="$(grep '^DATABASE_URL=' /opt/alma-erp/worker/.env | cut -d= -f2-)"
  elif [[ -f .env ]]; then
    DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: set DATABASE_URL or add it to worker/.env" >&2
  exit 1
fi

export DATABASE_URL

echo "[1/3] Mark failed migration as rolled back..."
npx prisma@6 migrate resolve --rolled-back 20260611200000_agent_phase6_schema

echo "[2/3] Re-apply pending migrations..."
npx prisma@6 migrate deploy

echo "[3/3] Done. Verify with: npx prisma@6 migrate status"
