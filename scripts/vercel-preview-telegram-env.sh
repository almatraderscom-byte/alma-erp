#!/usr/bin/env bash
# One-time: sync core + Telegram env to Vercel Preview (internal testing). Do not commit secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN}"
WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET}"
APP_URL="${NEXT_PUBLIC_APP_URL:-https://alma-erp-six.vercel.app}"

add_preview() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | npx vercel env add "$name" preview --force 2>/dev/null || \
    printf '%s' "$value" | npx vercel env add "$name" preview 2>/dev/null || true
}

# Telegram
add_preview TELEGRAM_BOT_TOKEN "$BOT_TOKEN"
add_preview TELEGRAM_WEBHOOK_SECRET "$WEBHOOK_SECRET"
add_preview NEXT_PUBLIC_APP_URL "$APP_URL"
add_preview TELEGRAM_RATE_LIMIT_PER_MINUTE "12"
add_preview TELEGRAM_DRAFT_LOCK_HOUR_BD "6"

# Build essentials from .env
if [[ -f .env ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^# ]] && continue
    [[ "$line" =~ ^(DATABASE_URL|NEXTAUTH_SECRET|NEXTAUTH_URL|SUPABASE_|RESEND_|EMAIL_FROM|API_SECRET|CRON_SECRET)= ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"
    add_preview "$key" "$val"
  done < .env
fi

echo "Preview env sync attempted."
