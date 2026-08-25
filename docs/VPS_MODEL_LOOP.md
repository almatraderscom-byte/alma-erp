# VPS Model Loop — running turn slices off Vercel entirely

Follow-up to PR #850 (long-job continuation fix). That PR routed report-class
turns to the worker lane, but each SLICE still executed by calling back into
the Vercel chat route — bounded by `maxDuration`. This program removes the
ceiling in two steps.

## V0 — bigger Vercel slices (no new infra)

`maxDuration` on `/api/assistant/chat` is now **1800s** (Pro + Fluid limit), so
a worker-driven slice gets ~1780s instead of ~780s. Nothing to deploy beyond
the app itself. If a Vercel build ever rejects 1800 (plan change), drop it back
to 800 — everything else keeps working.

## V1 — the self-hosted engine (no ceiling at all)

A second copy of the SAME Next app runs on the VPS under pm2
(`alma-agent-engine`, loopback-only port 3200). The worker executes turn
slices against it instead of Vercel:

```
BullMQ long-agent-task ──▶ worker ──POST /api/assistant/chat──▶ engine (127.0.0.1:3200)
                                                    │ (unset WORKER_TURN_ENGINE_URL)
                                                    └────────▶ Vercel app (fallback)
```

- The engine declares `ALMA_SELF_HOSTED_ENGINE=1`; the chat route then gives a
  worker-driven rerun `AGENT_WORKER_RERUN_CAP_MS` (default **1 hour**) per
  slice instead of `maxDuration - 20s`. A cap still exists on purpose: a
  wedged provider stream must end in salvage + a durable hop, never hang a
  worker slot — the #850 hop chain is what makes total runtime unbounded.
- ONLY the turn-slice callback moves (`getTurnEngineUrl()` in
  `worker/src/env.mjs`, used by `worker/src/turn/run-streamed-turn.mjs`).
  Every other worker call (job-result, diagnostics, Telegram) stays on
  `APP_URL`. Clients notice nothing: the durable event log + SSE tail are
  identical.
- `WORKER_TURN_FETCH_TIMEOUT_MS` (default 65 min) must exceed the executing
  side's slice cap — the old fixed 25-minute fetch timeout would have become
  the ceiling itself.

## Rollout (owner + one deploy session)

1. **Owner: create `/opt/alma-erp/.env.engine`** on the VPS with values copied
   from the Vercel project env (Production). Checklist:
   - `DATABASE_URL` — the Supabase **pooler** URL with a WORKING password (the
     copies previously on the box are rotated/dead — copy the current value
     from Vercel, do not reuse local files)
   - `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `NEXTAUTH_SECRET`
   - `AGENT_INTERNAL_TOKEN` (same value the worker already has)
   - `AGENT_ENABLED=true`
   - `APP_URL=https://alma-erp-six.vercel.app` — tools running inside a slice
     (diagnostic tools, `open_live_browser` owner links) build public URLs
     from it; without it they fail with "APP_URL … not configured"
   - Model provider keys the head/tools use: `OPENAI_API_KEY`,
     `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`,
     `OPENROUTER_API_KEY`, `XAI_API_KEY` (copy whichever exist on Vercel)
   - `REDIS_URL` / `LONG_TASK_REDIS_URL` (same as the worker)
   - Tool credentials report-class turns use: `OXYLABS_API_KEY` (web research /
     SEO crawls — without it a site-audit slice degrades to "Oxylabs not
     configured"), plus any other tool keys visible on Vercel
   - Optional: `ENGINE_PORT` (default 3200 — **never 3100**: the voice relay
     binds 0.0.0.0:3100 and the engine would EADDRINUSE against the locked
     voice stack), `AGENT_WORKER_RERUN_CAP_MS`
2. **Deploy**: on the VPS, `bash scripts/vps-engine-deploy.sh`
   (build is the heavy step — the box also runs Asterisk + the worker; the
   script bounds Node's heap at 4 GB; run it off-peak the first time).
3. **Flip the worker**: add `WORKER_TURN_ENGINE_URL=http://127.0.0.1:3200` to
   `/opt/alma-erp/worker/.env`, then `pm2 restart alma-agent-worker` (only the
   worker — the voice apps stay up, per the locked-audio rule).
4. **Verify**: send a report-class message; Vercel logs show the handoff, pm2
   logs (`pm2 logs alma-agent-engine`) show the slice executing locally;
   `/api/build-info` on 127.0.0.1:3200 must match origin/main.

## Rollback

Remove `WORKER_TURN_ENGINE_URL` from the worker env + `pm2 restart
alma-agent-worker` — slices go back to Vercel instantly. `pm2 stop
alma-agent-engine` any time after that. V0 stays regardless.

## Safety notes

- The engine binds **127.0.0.1 only** — it carries the full secret set and
  must never listen publicly. The worker reaches it over loopback.
- The engine serves the same repo the sync timer keeps at origin/main; the
  deploy script refuses a stale checkout.
- Engine slices still write the same durable `agent_turn_events` log through
  the same route code, so replay/recovery and the referencesActive contract
  are untouched.
