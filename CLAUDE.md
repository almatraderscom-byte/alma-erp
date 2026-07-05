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

### Parallel work with sub-agents (owner rule, 2026-07-05 — mandatory)

When a request contains MULTIPLE independent tasks/issues, do NOT work them one-by-one (a serial session that takes 1–2 hours blocks the owner's day):

1. **Fan out:** spawn one sub-agent per independent sub-task (Task/Agent tool), all in ONE message so they run concurrently. Give each a tight, self-contained brief — exact files, exact goal, exact return format — so it burns few tokens and can't wander.
2. **Never idle:** while sub-agents run, the main session keeps working its own share of the tasks (or preps the next step — builds, deploys, verification setup). Waiting silently is forbidden.
3. **Verify everything yourself:** a sub-agent's "done" is NOT done. The main session must verify each result itself (read the diff, build/typecheck, sim/Chrome screenshot per the browser-proof rule) BEFORE reporting to the owner. Any mistake found = fix it (or re-dispatch) before confirming.
4. **Careful scoping:** sub-agents must respect every Hard Rule above (no ERP edits outside scope, no secrets, gated changes only). Never let two sub-agents edit the same file — split by file/area to avoid conflicts; the main session integrates.
5. **Goal: wall-clock ≈ the slowest single item, not the sum** — and fewer tokens than one long meandering session, because each brief is small and focused.

- When a bug is reported: honest root-cause diagnosis FIRST, no code change. Fix only after owner approval.
- Architectural fixes > patches. Confirm before any costly/destructive action.
- Pre-flight checks before code in each phase; if any check fails, STOP and report.
- Verify builds/lint/typecheck pass and run `git diff --stat` scope check before declaring a phase done.
- **Browser proof before presenting:** see Hard Rule above — never declare an issue/feature done without a live Chrome-MCP screenshot from the Vercel preview. Build/typecheck passing is not proof.
- Final report per phase: files created, migrations added, verification checklist PASS/FAIL, ambiguities + decisions made.

## Communication

- Owner is not an engineer: reports should be concise, plain language, no terminal handholding.
- User-facing agent output (runtime): pure Bangla, address owner as "Sir"/"Boss", Islamic guardrails (no haram products/imagery), staff messages in Bangla.
