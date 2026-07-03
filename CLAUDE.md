# ALMA ERP + Personal AI Agent — Project Rules

## Project

- Next.js 14 (App Router) + Supabase Postgres + Vercel (region hnd1 Tokyo). Production: alma-erp-six.vercel.app
- Live business ERP for ALMA Lifestyle / ALMA Trading / CDIT. Owner: Maruf (non-engineer business owner).
- New work: personal AI agent module being built INSIDE this repo, phase by phase (Phase 0 → 8). One phase per session, scoped exactly to the phase prompt file provided.

## Hard Rules (never violate)

1. NEVER modify existing ERP code outside the files listed in the current phase prompt. ERP is live production.
1. NEVER touch `/api/agent/*` routes or their auth (X-ALMA-API-KEY, IP allowlist 31.97.237.40). The Hermes Telegram bot on the VPS depends on them during transition.
1. New agent API routes live ONLY under `/api/assistant/*`.
1. Agent code lives in `src/agent/`, `src/app/agent/`, `src/app/api/assistant/`. One-way dependency: agent may import ERP shared libs; ERP code must NEVER import from `src/agent/`.
1. `AGENT_ENABLED` env flag is the kill switch — every agent route checks it first (via `requireAgentEnabled()`).
1. No secrets in git. `.env.example` placeholders only.
1. Database changes: additive migrations only unless the phase prompt explicitly says otherwise. Use the project's existing migration system — never introduce a new one.
1. Before each phase: create branch `agent-phase-N` + tag `pre-agent-phase-N`. Never merge to main or deploy to production yourself — push the branch for a Vercel preview; the owner tests and approves merge.
1. **BROWSER PROOF BEFORE "DONE" (mandatory, never skip):** after fixing ANY issue or adding ANY feature, Claude must FIRST exercise it live himself in the owner's Chrome browser (Chrome MCP) on the Vercel preview link and capture a screenshot as proof — BEFORE telling the owner it's ready. Build/typecheck passing is NOT proof. If login is required, navigate to the login page and ask the owner to log in (the owner enters credentials — Claude never types them); once logged in, Claude enters the preview link himself and brings back the screenshot. No screenshot of the working feature = not done. Everyone working in this repo must follow this.
1. **iOS SELF-TEST BEFORE ASKING THE OWNER (mandatory for the native iOS app):** the owner's Mac now has a working iOS Simulator (`iPhone 17 Pro Max`, iOS 26.5). Claude must self-test on it and MUST NOT burn the owner's time round-tripping small UI/UX issues through TestFlight device builds. Rule of thumb for where to catch things:
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

- When a bug is reported: honest root-cause diagnosis FIRST, no code change. Fix only after owner approval.
- Architectural fixes > patches. Confirm before any costly/destructive action.
- Pre-flight checks before code in each phase; if any check fails, STOP and report.
- Verify builds/lint/typecheck pass and run `git diff --stat` scope check before declaring a phase done.
- **Browser proof before presenting:** see Hard Rule above — never declare an issue/feature done without a live Chrome-MCP screenshot from the Vercel preview. Build/typecheck passing is not proof.
- Final report per phase: files created, migrations added, verification checklist PASS/FAIL, ambiguities + decisions made.

## Communication

- Owner is not an engineer: reports should be concise, plain language, no terminal handholding.
- User-facing agent output (runtime): pure Bangla, address owner as "Sir"/"Boss", Islamic guardrails (no haram products/imagery), staff messages in Bangla.
