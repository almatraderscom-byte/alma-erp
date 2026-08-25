#!/bin/bash
# pm2 entry for the self-hosted turn engine (docs/VPS_MODEL_LOOP.md).
# Sources the engine env, declares itself self-hosted (this is what unlocks
# the AGENT_WORKER_RERUN_CAP_MS slice budget in the chat route), then serves
# the built Next app on the loopback-only engine port.
set -euo pipefail
cd /opt/alma-erp
set -a
source /opt/alma-erp/.env.engine
set +a
export ALMA_SELF_HOSTED_ENGINE=1
export PORT="${ENGINE_PORT:-3100}"
# Loopback only: the engine carries the full secret set and must never be
# reachable from outside the box. The worker talks to it over 127.0.0.1.
exec npx next start --hostname 127.0.0.1 --port "$PORT"
