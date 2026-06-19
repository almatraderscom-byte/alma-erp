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

## ERP Conventions (must follow)

- Money: whole-taka arithmetic only, via `roundMoney` in `src/lib/money.ts`. Never raw floats for currency.
- Currency BDT (AED secondary in personal finance), timezone Asia/Dhaka.
- Payroll/wallet logic is sensitive (recently fixed: salary_payment is a debit). Do not refactor ERP financial code unprompted.

## Agent Architecture (locked decisions — do not re-litigate)

- **Head model:** `claude-sonnet-4-6` (default), direct Anthropic API, adaptive extended thinking, prompt caching, full conversation history (compaction is a far-off cost safety valve only — `conversation-compact.ts`). Keep the head on Claude — native caching is the main cost lever; never put the head on a non-caching provider.
- **Router-worker (multi-model):** the head delegates discrete sub-tasks to specialist sub-agents via the tier router (`src/agent/lib/models/`: `registry.ts`, `tier-router.ts`, `routing-config.ts`, `subagent.ts`, `specialist-roles.ts`, `adapters/`). CRITICAL tier (ERP / finance / staff / CS / orders / salah / scheduler) is **hard-guarded to Claude only** (`assertCriticalTierUsesClaude`); HEAVY / LIGHT tiers may run on cheaper models (OpenRouter / Gemini; Qwen / DeepSeek optional) for non-critical execution. OpenRouter failures fall back to native Gemini → Claude.
- **Worker context:** workers are stateless and task-scoped — they receive a self-contained brief and return a summary. The head keeps all conversation + memory state and is the **only** writer of memory and owner-facing actions.
- **Opus 4.8 escalation:** rare high-risk / big-money decisions only, daily-capped, owner-tunable (`opus-gate.ts` + `routing-config.ts`).
- **Model allocation is owner-tunable via `agent_kv_settings` (no redeploy);** `models/registry.ts` is the single source of truth. Customer-facing output stays on Claude until cheap-model Bangla quality is validated (`bangla-output-gate.ts`).
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
- Final report per phase: files created, migrations added, verification checklist PASS/FAIL, ambiguities + decisions made.

## Communication

- Owner is not an engineer: reports should be concise, plain language, no terminal handholding.
- User-facing agent output (runtime): pure Bangla, address owner as "Sir"/"Boss", Islamic guardrails (no haram products/imagery), staff messages in Bangla.
