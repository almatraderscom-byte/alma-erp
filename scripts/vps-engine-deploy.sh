#!/bin/bash
# VPS model-loop engine deploy (docs/VPS_MODEL_LOOP.md).
#
# Runs ON the VPS in /opt/alma-erp (which already tracks origin/main via the
# sync timer — this script never switches branches). Builds the Next app and
# (re)starts the self-hosted turn engine under pm2 as `alma-agent-engine`.
#
# Prerequisites (one-time, owner-provided):
#   /opt/alma-erp/.env.engine  — see docs/VPS_MODEL_LOOP.md for the checklist
#
# Usage on the VPS:
#   bash scripts/vps-engine-deploy.sh
set -euo pipefail

cd /opt/alma-erp

ENV_FILE=/opt/alma-erp/.env.engine
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: $ENV_FILE missing — create it from the checklist in docs/VPS_MODEL_LOOP.md" >&2
  exit 1
fi

# Refuse a stale OR dirty checkout: the engine must serve exactly what main
# serves. Commit-id equality alone would still compile locally modified
# tracked files (Codex P2 #852).
git fetch origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "FATAL: /opt/alma-erp is not at origin/main — let the sync timer catch up (or git pull) first." >&2
  exit 1
fi
# Tracked files only: the threat is MODIFIED reviewed code being served as
# main. Untracked files (notably the required /opt/alma-erp/.env.engine, now
# also gitignored) must not fail every documented first deploy (Codex P1 #852).
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "FATAL: /opt/alma-erp has local modifications to tracked files — the engine must build pristine origin/main:" >&2
  git status --porcelain --untracked-files=no >&2
  exit 1
fi

# Engine env loads FIRST: npm ci's postinstall runs `prisma generate`, and
# prisma/schema.prisma resolves env("DATABASE_URL") — with no ambient value a
# documented first deploy died before the build began (Codex P1 #852).
set -a; source "$ENV_FILE"; set +a

echo "==> npm ci"
npm ci --no-audit --no-fund

echo "==> prisma generate"
npx prisma generate

echo "==> next build (this is the heavy step)"
# The box also runs Asterisk + the worker; keep Node's heap bounded but real.
# Same cache cleanup as the canonical `npm run build`: a poisoned Turbopack
# cache can fail otherwise-valid builds (next.config.js note; Codex P2 #852).
rm -rf .next/cache/.tsbuildinfo .next/cache/eslint .next/cache/turbopack
NODE_OPTIONS="--max-old-space-size=4096" npx next build

# Stamp the BUILT commit beside the build artifacts. The start script exports
# it as ALMA_ENGINE_BUILD_SHA, so /api/build-info reports the sha this .next
# was actually built from — even after the checkout advances — which is what
# the worker's drift guard and the health check below verify (Codex #852).
BUILT_SHA="$(git rev-parse HEAD)"
printf '%s' "$BUILT_SHA" > .next/ALMA_ENGINE_BUILD_SHA

echo "==> (re)start alma-agent-engine on port ${ENGINE_PORT:-3100}"
pm2 delete alma-agent-engine >/dev/null 2>&1 || true
pm2 start scripts/vps-engine-start.sh --name alma-agent-engine --time
pm2 save

echo "==> health check (must report the built commit, not just HTTP 200)"
sleep 5
HEALTH="$(curl -sf "http://127.0.0.1:${ENGINE_PORT:-3100}/api/build-info")"
echo "$HEALTH" | head -c 200 && echo
if ! printf '%s' "$HEALTH" | grep -q "$BUILT_SHA"; then
  echo "FATAL: engine /api/build-info does not report the built commit $BUILT_SHA — stale or misconfigured build" >&2
  exit 1
fi
echo "OK — now set WORKER_TURN_ENGINE_URL=http://127.0.0.1:${ENGINE_PORT:-3100} in /opt/alma-erp/worker/.env and: pm2 restart alma-agent-worker"
