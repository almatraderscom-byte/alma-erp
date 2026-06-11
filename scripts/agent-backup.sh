#!/usr/bin/env bash
# Nightly agent + finance table backup (VPS cron 03:00).
# Retains 14 days gzip dumps in /opt/agent-backups/
set -euo pipefail

BACKUP_DIR="${AGENT_BACKUP_DIR:-/opt/agent-backups}"
RETENTION_DAYS="${AGENT_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/agent_finance_${STAMP}.sql.gz"
LOG="${BACKUP_DIR}/backup.log"

mkdir -p "$BACKUP_DIR"

notify_tier1() {
  local msg="$1"
  echo "$(date -u -Iseconds) FAIL: $msg" >> "$LOG"
  if [[ -n "${NTFY_SERVER:-}" && -n "${NTFY_TOPIC_GENERAL:-}" ]]; then
    curl -fsS -X POST \
      -H "Title: Agent backup failed" \
      -H "Priority: 3" \
      -d "$msg" \
      "${NTFY_SERVER%/}/${NTFY_TOPIC_GENERAL}" || true
  fi
}

if [[ -z "${DATABASE_URL:-}" ]]; then
  notify_tier1 "DATABASE_URL not set"
  exit 1
fi

TABLES=(
  agent_conversations agent_messages agent_tool_calls agent_pending_actions
  agent_projects agent_artifacts agent_memory agent_notifications
  agent_kv_settings agent_staff agent_staff_tasks agent_salah_records
  agent_finance_expenses agent_finance_ledger agent_heartbeats
  messenger_alerts
)

TABLE_ARGS=""
for t in "${TABLES[@]}"; do
  TABLE_ARGS+=" -t ${t}"
done

if ! pg_dump "$DATABASE_URL" $TABLE_ARGS | gzip -9 > "$OUT"; then
  notify_tier1 "pg_dump failed for agent/finance tables"
  rm -f "$OUT"
  exit 1
fi

echo "$(date -u -Iseconds) OK: $OUT ($(du -h "$OUT" | awk '{print $1}'))" >> "$LOG"

find "$BACKUP_DIR" -name 'agent_finance_*.sql.gz' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

# Hermes archival (one-time copy — does not decommission Hermes)
HERMES_SRC="${HERMES_DB_PATH:-/opt/hermes/code/apps/api/.hermes/hermes.db}"
HERMES_DEST="${BACKUP_DIR}/hermes-final/hermes.db"
if [[ -f "$HERMES_SRC" && ! -f "$HERMES_DEST" ]]; then
  mkdir -p "${BACKUP_DIR}/hermes-final"
  cp -a "$HERMES_SRC" "$HERMES_DEST"
  echo "$(date -u -Iseconds) Hermes archive copied to $HERMES_DEST" >> "$LOG"
fi
