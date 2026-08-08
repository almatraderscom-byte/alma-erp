# ALMA ERP + Personal AI Agent — Project Rules

## Project

- Next.js 14 (App Router) + Supabase Postgres + Vercel (region hnd1 Tokyo). Production: alma-erp-six.vercel.app
- Live business ERP for ALMA Lifestyle / ALMA Trading / CDIT. Owner: Maruf (non-engineer business owner).
- New work: personal AI agent module being built INSIDE this repo, phase by phase (Phase 0 → 8). One phase per session, scoped exactly to the phase prompt file provided.

## Hard Rules (never violate)

1. **THE CALL AUDIO TUNING IS LOCKED. Do not change it, and do not let other work break it.**
   The owner listened to a live call on 2026-07-26 and called the voice **perfect**. That is
   the reference. Everything below is the exact state that produced it, and it is a *frozen
   baseline*, not a starting point for improvement.
   - **Locked values** (all are CODE DEFAULTS — there is deliberately NO env override for any
     of them, so the tuning lives in git and cannot be quietly changed over SSH):
     `SIP_JITTER_FRAMES=12` · `SIP_JITTER_GROW_FRAMES=4` · `SIP_JITTER_MAX_FRAMES=35` ·
     `SIP_TURN_END_MS=60` · `SIP_QUEUE_HIGH_FRAMES=500` · `SIP_QUEUE_LOW_FRAMES=50` ·
     `SIP_BARGE_FADE_FRAMES=2` · `GLIVE_VAD_SILENCE_MS=500` · voice `Charon` (male).
     Locked files: the playout in `worker/src/voice-relay/sip-gateway-service.mjs` and the
     forwarding/VAD in `worker/scripts/gemini-live-bot.mjs`.
   - **What "good" measures as**, from that call — use these numbers to prove nothing broke:
     `underruns ≤ 1 · turn-ends counted separately · cushion ≤ 16f · dropped = 0`.
     Any call whose cushion climbs past 16 frames or whose underruns exceed 1 is a regression.
   - **Never treat the end of a sentence as a dropout.** The queue empties at the end of every
     turn because the model stops for 1.7–2.5 s between turns; counting that as a dry-out is
     what ratcheted the cushion 12 → 32 frames and made the AI answer late. `TURN_END_MS`
     exists solely to tell the two apart. Do not remove it.
   - **Any change that touches voice — a new voice feature, a model swap, a refactor, a
     "small cleanup" near the playout — must state up front that it does not alter the values
     above, and must be proven on a real call before it ships**: place a loopback call to our
     own DID `09649777738`, read the hangup counters, and confirm they still match the
     baseline. Build/typecheck passing is NOT proof for audio.
   - **Changing the audio still requires the owner's ear, one change at a time.** If he calls
     a change worse, revert it immediately — do not iterate on the live line.
1. NEVER modify existing ERP code outside the files listed in the current phase prompt. ERP is live production.
1. NEVER touch `/api/agent/*` routes or their auth (X-ALMA-API-KEY, IP allowlist 31.97.237.40). The Hermes Telegram bot on the VPS depends on them during transition.
1. New agent API routes live ONLY under `/api/assistant/*`.
1. Agent code lives in `src/agent/`, `src/app/agent/`, `src/app/api/assistant/`. One-way dependency: agent may import ERP shared libs; ERP code must NEVER import from `src/agent/`.
1. `AGENT_ENABLED` env flag is the kill switch — every agent route checks it first (via `requireAgentEnabled()`).
1. No secrets in git. `.env.example` placeholders only.
1. Database changes: additive migrations only unless the phase prompt explicitly says otherwise. Use the project's existing migration system — never introduce a new one.
1. Before each phase: create branch `agent-phase-N` + tag `pre-agent-phase-N`. Never merge to main or deploy to production yourself — push the branch for a Vercel preview; the owner tests and approves merge.
1. **BROWSER PROOF BEFORE "DONE" (mandatory, never skip):** after fixing ANY issue or adding ANY feature, Claude must FIRST exercise it live himself in the owner's Chrome browser (Chrome MCP) on the Vercel preview link and capture a screenshot as proof — BEFORE telling the owner it's ready. Build/typecheck passing is NOT proof. If login is required, navigate to the login page and ask the owner to log in (the owner enters credentials — Claude never types them); once logged in, Claude enters the preview link himself and brings back the screenshot. No screenshot of the working feature = not done. Everyone working in this repo must follow this.
1. **iOS SELF-TEST BEFORE ASKING THE OWNER (mandatory for the native iOS app):** the owner's Mac now has a working iOS Simulator (`iPhone 17 Pro Max`, iOS 26.5; udid + passcode in Claude memory `reference_ios_sim_access`). **EXHAUST self-testing before every build: reason through the change, then verify it in the simulator (native UI) and/or Chrome `?native=1` (web UI), fix everything you find, and BATCH ALL fixes into ONE TestFlight build.** The goal is that the owner's next device test finds nothing — one shot, not a drip of small builds. Claude must self-test and MUST NOT burn the owner's time round-tripping small UI/UX issues through TestFlight. Rule of thumb for where to catch things:
   - **Web UI/UX** (anything rendered inside the WebView — page layout, CSS, embed-mode chrome hide/show, headers/banners, element tweaks): verify in the owner's **Chrome with `?native=1`** (e.g. `https://alma-erp-six.vercel.app/orders?native=1`) — his Chrome is already logged in, so this needs no build. The double-header / banner class of issues are catchable here; catch them here.
   - **Native Swift UI** (tab bar, native headers, colors, nav transitions, tab-bar/keyboard overlap, safe-area): build the app for the simulator and screenshot it yourself — `xcodebuild ... -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/alma-sim-dd build`, then `xcrun simctl install/launch` + `xcrun simctl io <udid> screenshot`. Boot with `xcrun simctl boot`; the owner's device udid family is listed via `xcrun simctl list devices`. Enroll/match Face ID and dismiss dialogs via the Simulator app when needed. Fix in the simulator loop until it looks right, THEN ship one TestFlight build.
   - **Only truly hardware-dependent things go to the owner:** real push notifications, real Face ID hardware, and final real-device keyboard/performance feel. Everything else Claude verifies itself first.
   Ship a TestFlight build only after the change is verified in Chrome (web) and/or the simulator (native). Batch fixes into one build; never ship an un-self-tested small UI change and ask the owner to check it.

## ERP Conventions (must follow)

- Money: whole-taka arithmetic only, via `roundMoney` in `src/lib/money.ts`. Never raw floats for currency.
- Currency BDT (AED secondary in personal finance), timezone Asia/Dhaka.
- Payroll/wallet logic is sensitive (recently fixed: salary_payment is a debit). Do not refactor ERP financial code unprompted.

## Agent Architecture (locked decisions — do not re-litigate)

- **Head model:** `gemini-3.1-pro` (Gemini 3.1 Pro, direct Google API) — owner decision 2026-07: the business is small, so the head runs on Gemini for cost; the earlier "keep the head on Claude" rule is suspended for now. Wiring lives in `head-router.ts`: `HEAVY_HEAD_MODEL_ID` (default `gemini-3.1-pro`) picks the head, and `ANTHROPIC_HEAD_DOWN` (default ON) transparently redirects any explicitly-picked Claude head to Gemini. Full conversation history retained (compaction is a far-off cost safety valve only — `conversation-compact.ts`). Claude can return later by flipping those two env vars — do not delete the Anthropic paths.
- **Router-worker (multi-model):** the head delegates discrete sub-tasks to specialist sub-agents via the tier router (`src/agent/lib/models/`: `registry.ts`, `tier-router.ts`, `routing-config.ts`, `subagent.ts`, `specialist-roles.ts`, `adapters/`). Owner decision 2026-07: the old "CRITICAL tier hard-guarded to Claude Sonnet" rule is **suspended for now** (business is small) — **Gemini 3.1 Pro replaces Sonnet** wherever Sonnet was the answer. The code guard (`assertCriticalTierUsesClaude` + `CRITICAL_SPECIALIST_ROLES` on the finance `analyst` role) still exists in `tier-router.ts`; a phase may relax it to Gemini when it touches that file — that is sanctioned, not a regression. Everything else is **NON-critical** by deliberate owner decision: staff/`ops`, orders coordination, research, marketing and content run on **DeepSeek** (`or-deepseek-v4-flash`) to cut cost, while **`cs` (customer service) runs on Qwen** (`or-qwen3-max`) — it is customer-facing, so the stronger Bangla quality is worth the higher cost. HEAVY / LIGHT tiers run cheaper models (OpenRouter DeepSeek / Gemini / Qwen). OpenRouter failures fall back to native Gemini. Customer-facing Bangla quality stays gated via `bangla-output-gate.ts`; the head (owner-facing) runs on Gemini 3.1 Pro.
- **Worker context:** workers are stateless and task-scoped — they receive a self-contained brief and return a summary. The head keeps all conversation + memory state and is the **only** writer of memory and owner-facing actions.
- **Opus 4.8 escalation:** rare high-risk / big-money decisions only, daily-capped, owner-tunable (`opus-gate.ts` + `routing-config.ts`).
- **Model allocation is owner-tunable via `agent_kv_settings` (no redeploy);** `models/registry.ts` is the single source of truth (the head itself is env-tuned: `HEAVY_HEAD_MODEL_ID` / `ANTHROPIC_HEAD_DOWN`). Customer-facing output quality stays gated via `bangla-output-gate.ts`.
- Self-verification loop: call tool → verify result → then reply. Never claim success without verification (`claim-verifier.ts`).
- Voice: Whisper API (transcription), Google TTS bn-IN-Chirp3-HD-Charon (male Bangla). Images: Nano Banana Pro / 2 via direct Google API. Facebook: direct Meta Graph API (no Composio).
- Push: Telegram primary, ntfy critical alerts, Twilio calls (8kHz mono WAV) for rare escalation only.
- Memory/RAG: Supabase pgvector (Phase 3). Long agentic tasks (>30s) go to VPS worker queue (Redis), never Vercel functions.
- Durable job queues for long operations — never in-memory only.

## Workflow Rules

## Two-Mac Git Sync (mandatory — Mac Mini + MacBook)
- At the START of every session: run `git pull` on the current branch first, so this Mac has the latest work from the other Mac before doing anything.
- At the END of every session (and before I switch to the other Mac): commit all changes and `git push` to GitHub. Never leave finished work unpushed.
- If there are uncommitted or unpushed changes when we stop, remind me before finishing.

## iOS TestFlight Build Gate (mandatory — root cause of builds 63–69 losing features)
- **Every TestFlight build MUST come from a clean, pushed, main-current checkout.** Builds 63–69 each dropped previously-shipped features because they were archived from Mac-local state (uncommitted / unpushed / behind origin/main). Proof: the last build number ever committed to git is 62.
- **Run `bash scripts/ios-build-preflight.sh` BEFORE every Archive.** It hard-fails on: dirty tree, unpushed commits, checkout missing origin/main work, or a non-main branch (preview override: `ALMA_PREFLIGHT_ALLOW_BRANCH=1`). It also stamps the commit SHA into Info.plist (`ALMAGitCommit`) so every .ipa is traceable to one commit.
- **The build-number bump is a commit**: bump `CURRENT_PROJECT_VERSION`, commit (`chore(ios): bump build to N`) and push BEFORE uploading. Build number in git must always equal the number on TestFlight.
- If preflight fails, fix the git state — never archive around it.

### Sub-agents (use sparingly — Explore only; owner rule, updated 2026-07-06)

- Do NOT fan out work across sub-agents by default. Work the tasks yourself in the main session, one focused thread — even when a request has multiple issues.
- Use a sub-agent ONLY when genuinely needed, and then prefer the read-only **Explore** agent for broad codebase searches (locating files/symbols/usages across many places) where you only need the conclusion, not a hand-off of the work.
- Never delegate edits, implementation, or verification to sub-agents — the main session does the work and owns the browser/sim proof.

- **Codex review-bot comments are a PRE-MERGE gate on every PR (owner rule 2026-07-29, severity rule 2026-07-30):** after pushing a PR, wait for and check the Codex bot's review comments (`chatgpt-codex-connector`), triage them yourself, and reply on the PR with what was fixed/why anything was deferred — WITHOUT waiting to be asked. **P0 and P1 findings block the merge and are fixed on the same branch immediately (anything the bot ranks above P1 is a fortiori blocking). P2 findings do NOT block a release the owner is waiting on** — log them on the PR as deferred, resolve the threads, merge, and ship the fixes in the next batch. **P3 and anything milder: acknowledge in the PR reply and resolve; fixing is optional (fold into a related batch if trivial, otherwise drop).** The severity ladder is exhaustive on purpose — that is what terminates the review loop (the bot finds new low-severity edges every round on fresh code). If the bot comments only after a merge already happened, ship P0/P1 fixes as an immediate follow-up PR.
- When a bug is reported: honest root-cause diagnosis FIRST, no code change. Fix only after owner approval.
- Architectural fixes > patches. Confirm before any costly/destructive action.
- Pre-flight checks before code in each phase; if any check fails, STOP and report.
- Verify builds/lint/typecheck pass and run `git diff --stat` scope check before declaring a phase done.
- **Browser proof before presenting:** see Hard Rule above — never declare an issue/feature done without a live Chrome-MCP screenshot from the Vercel preview. Build/typecheck passing is not proof.
- Final report per phase: files created, migrations added, verification checklist PASS/FAIL, ambiguities + decisions made.

## Communication

- Owner is not an engineer: reports should be concise, plain language, no terminal handholding.
- User-facing agent output (runtime): pure Bangla, address owner as **"Boss" ONLY — "Sir"/"স্যার" banned** (owner rule 2026-07-07, TTS accent), no emoji in voice/TTS output, Islamic guardrails (no haram products/imagery), staff messages in Bangla.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
