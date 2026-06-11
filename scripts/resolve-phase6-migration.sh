#!/usr/bin/env bash
# Clear failed 20260611200000_agent_phase6_schema and re-apply migrations.
# Run from repo root on VPS: bash scripts/resolve-phase6-migration.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

strip_quotes() {
  local v="$1"
  v="${v%\"}"; v="${v#\"}"
  v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

load_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    export DATABASE_URL="$(strip_quotes "$DATABASE_URL")"
    return 0
  fi

  local f line key val
  for f in "$ROOT/.env" "$ROOT/worker/.env" "$ROOT/.env.local" /opt/alma-erp/.env /opt/alma-erp/worker/.env; do
    [[ -f "$f" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?DATABASE_URL= ]] || continue
      val="${line#DATABASE_URL=}"
      val="${val#export DATABASE_URL=}"
      val="$(strip_quotes "$val")"
      if [[ -n "$val" ]]; then
        export DATABASE_URL="$val"
        echo "Using DATABASE_URL from $f"
        return 0
      fi
    done < "$f"
  done
  return 1
}

if ! load_database_url; then
  echo "ERROR: DATABASE_URL not found." >&2
  echo "Add to /opt/alma-erp/.env or /opt/alma-erp/worker/.env:" >&2
  echo '  DATABASE_URL="postgresql://postgres.<ref>:<pass>@db.<ref>.supabase.co:5432/postgres"' >&2
  echo "(Use direct :5432 host for migrate — not the pooler :6543)" >&2
  exit 1
fi

echo "[1/3] Mark failed migration as rolled back..."
npx prisma@6 migrate resolve --rolled-back 20260611200000_agent_phase6_schema

echo "[2/3] Re-apply pending migrations..."
npx prisma@6 migrate deploy

echo "[3/3] Done."
npx prisma@6 migrate status
