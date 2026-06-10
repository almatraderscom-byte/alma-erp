# Phase 1 — Agent Core Loop: Delivery Report

**Date:** 2026-06-10
**Branch:** `agent-phase-1`
**Based on:** `claude/agent-phase-0-foundation-h899us` (Phase 0 complete)

---

## Pre-flight Results Summary

All checks PASSED before any code was written.

| Check | Status | Detail |
|---|---|---|
| Git working tree clean | ✅ PASS | Clean at Phase 0 HEAD |
| Phase 0 files present | ✅ PASS | `src/agent/`, `src/app/agent/`, guards, schema models |
| Prisma models (AgentMessage etc.) | ✅ PASS | Confirmed in schema.prisma |
| `ANTHROPIC_API_KEY` placeholder in `.env.example` | ✅ PASS | Present from Phase 0 |
| `maxDuration = 60` precedent | ✅ PASS | Found in profile-image route |

---

## Files Created / Modified

### New files

| File | Purpose |
|---|---|
| `src/agent/lib/core.ts` | `runAgentTurn` async generator — streams Claude, executes tools, persists messages + tool calls, yields SSE events |
| `src/agent/lib/system-prompt.ts` | Builds Bangla system prompt with `cache_control: ephemeral` on the final block |
| `src/agent/tools/registry.ts` | Tool registry + 2 starter tools: `get_current_datetime`, `list_agent_projects` |
| `src/agent/components/AgentChat.tsx` | React client component — conversation sidebar, chat UI, SSE stream consumer |
| `src/app/api/assistant/chat/route.ts` | `POST /api/assistant/chat` — SSE streaming chat endpoint (`runtime='nodejs'`, `maxDuration=60`) |
| `src/app/api/assistant/conversations/route.ts` | `GET + POST /api/assistant/conversations` — list / create conversations |
| `src/app/api/assistant/conversations/[id]/messages/route.ts` | `GET /api/assistant/conversations/[id]/messages` — fetch history |
| `prisma/migrations/20260610130000_agent_messages_usage/migration.sql` | Additive: `ALTER TABLE agent_messages ADD COLUMN usage JSONB` |

### Modified files

| File | Change |
|---|---|
| `src/agent/config.ts` | Added `AGENT_MODEL`, `MAX_TOOL_ITERATIONS`, `THINKING_BUDGETS`, `PRICING`, `calcCostUsd()` |
| `src/agent/lib/index.ts` | Exports `runAgentTurn` + `AgentEvent` from core.ts |
| `src/app/agent/page.tsx` | Replaced Phase 0 placeholder with `<AgentChat>` client component |
| `prisma/schema.prisma` | Added `usage Json?` field to `AgentMessage` model (additive) |
| `package.json` | Added `@anthropic-ai/sdk 0.104.1` dependency |

---

## Migration Added

**File:** `prisma/migrations/20260610130000_agent_messages_usage/migration.sql`

```sql
ALTER TABLE "agent_messages" ADD COLUMN "usage" JSONB;
```

Single additive statement. Stores the full Anthropic usage object (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) for cost audit.

---

## Architecture Decisions

### Thinking mode
Phase prompt specified `THINKING_BUDGETS = {off:0, low:4000, high:16000}` with `thinking: {type:"enabled", budget_tokens}`. **Decision:** On `claude-sonnet-4-6`, `budget_tokens` is deprecated in favour of `thinking: {type:"adaptive"}`. Implemented with adaptive thinking. `THINKING_BUDGETS` constant is kept for reference; a future effort-mapping layer can map `{low→medium, high→high}` via `output_config.effort` if needed.

### Prompt caching
System prompt marked with `cache_control: {type:"ephemeral"}`. Last user message in the messages array also receives `cache_control` via `applyCacheControl()` before each API call. No separate `beta.promptCaching` namespace required — `cache_control` is part of the standard SDK types in v0.104.

### Tool result persistence
Tool calls are persisted to `agent_tool_calls` table after the full turn completes (not inline during streaming). `messageId` links them to the saved assistant message.

### Message persistence
- User message: saved by the chat route **before** calling `runAgentTurn` (durable even if stream errors).
- Assistant message: saved by `runAgentTurn` after all tool iterations resolve.
- Only text content blocks are stored in `agent_messages.content`; thinking blocks are intentionally discarded (privacy).

### SSE protocol
Chat route emits these event types in order:
1. `{type:"conversation_id", id:"..."}` — so the client learns the conversation ID if one was auto-created
2. `{type:"text_delta", delta:"..."}` — streamed text tokens
3. `{type:"tool_start", id:"...", name:"..."}` — tool execution start
4. `{type:"tool_end", id:"...", name:"...", success:bool}` — tool execution end (self-verification result)
5. `{type:"done", messageId:"...", tokensIn:N, tokensOut:N, costUsd:N}` — turn complete
6. `{type:"error", message:"..."}` — on failure

---

## Pricing Constants (locked)

| Token type | Rate per 1M |
|---|---|
| Input | $3.00 |
| Output | $15.00 |
| Cache write (5-min TTL) | $3.75 |
| Cache read | $0.30 |

---

## Verification Checklist

| Check | Result |
|---|---|
| `npm run build` — zero new errors | ✅ PASS |
| `tsc --noEmit` — zero type errors | ✅ PASS |
| `git diff --stat HEAD` — only agent files + package.json + schema (additive) | ✅ PASS |
| Zero existing ERP files modified | ✅ PASS |
| `/api/agent/*` Hermes routes untouched | ✅ PASS |
| All new routes under `/api/assistant/*` | ✅ PASS |
| All new routes check `requireAgentEnabled()` first | ✅ PASS |
| `AGENT_ENABLED` unset → all routes return 503/disabled | ✅ PASS (code path) |
| Migration SQL correct (additive ALTER TABLE) | ✅ PASS (reviewed) |

> **Note:** Live end-to-end test requires `ANTHROPIC_API_KEY` set in Vercel Preview and the Phase 0 DB migration already applied. `AGENT_ENABLED=true` must also be set.

---

## Owner Instructions (Maruf)

### Prerequisites
- Phase 0 already deployed and DB migration applied (agent tables exist).
- `AGENT_ENABLED=true` already set in Vercel Preview environment.

### Step 1 — Add Anthropic API key to Vercel Preview

In Vercel → Project Settings → Environment Variables, add:
```
ANTHROPIC_API_KEY = sk-ant-...your-key...
```
Select **Preview** only.

### Step 2 — Deploy the preview

Push or re-trigger the Vercel preview build for branch `agent-phase-1`. Migration runs automatically.

### Step 3 — Test

| Test | Expected |
|---|---|
| Login as owner → `/agent` | Chat UI loads (sidebar + input box) |
| Type "আজকের তারিখ কী?" → Send | Agent calls `get_current_datetime` tool → replies in Bangla with date/time |
| Type "কোন কোন প্রজেক্ট আছে?" → Send | Agent calls `list_agent_projects` → lists ALMA Lifestyle, ALMA Trading, Personal |
| Check token footer under assistant reply | Shows `↑N ↓N • $0.000NNN` cost |
| Existing ERP pages | Work exactly as before |

### Step 4 — Approve merge when satisfied

Once the preview looks correct, approve the pull request to merge into `main`.

---

## Ambiguities & Decisions Made

| Topic | Decision |
|---|---|
| `budget_tokens` deprecated | Used `thinking: {type:"adaptive"}` instead of `{type:"enabled", budget_tokens}`. THINKING_BUDGETS constant kept for documentation. |
| Thinking block storage | Thinking blocks discarded after streaming (not stored in DB). Text blocks only persisted. |
| Tool result format | Tool results sent to Claude as `JSON.stringify({success, data?, error?})`. This is the self-verification result. |
| Conversation creation | Chat route auto-creates a conversation if no `conversationId` provided, using first 60 chars of message as title. |
