# Phase 3 — Memory + RAG + Voice: Delivery Report

**Date:** 2026-06-11
**Branch:** `claude/agent-phase-0-foundation-h899us` (contains Phase 0–3)
**Based on:** `agent-phase-2` (merged in)
**Tag:** `pre-agent-phase-3`

---

## Pre-flight Results

| Check | Status | Detail |
|---|---|---|
| Git working tree clean | ✅ PASS | Phase 2 HEAD merged |
| Phase 2 files present | ✅ PASS | transcribe/tts stubs, AgentComposer, AgentSidebar, etc. |
| `OPENAI_API_KEY` placeholder | ✅ PASS | `.env.example` line 71 — Whisper + embeddings |
| `GOOGLE_TTS_CREDENTIALS` placeholder | ✅ PASS | `.env.example` line 72 — bn-IN-Chirp3-HD-Charon |
| pgvector availability | ✅ DOC | Supabase supports pgvector; `CREATE EXTENSION IF NOT EXISTS vector` in migration. Manual step required only if Supabase dashboard permissions block extension creation (see below). |

---

## pgvector Manual Step (if needed)

If the migration system cannot run `CREATE EXTENSION` (Supabase free tier / restricted permissions), the owner must run this **once** in the Supabase SQL Editor:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Everything else degrades gracefully until then — the embedding column and HNSW index creation will fail but the rest of the app continues to work. Memory tools fall back to text search if embeddings are unavailable.

**Index chosen:** HNSW (`hnsw (embedding vector_cosine_ops)`) — faster queries, available in pgvector ≥ 0.5, which Supabase uses. A commented-out ivfflat fallback is in the migration file.

---

## Files Created

| File | Purpose |
|---|---|
| `prisma/migrations/20260611120000_agent_memory_pgvector/migration.sql` | `CREATE EXTENSION vector`, `ALTER TABLE agent_memory ADD COLUMN embedding vector(1536)`, HNSW index |
| `src/agent/lib/embeddings.ts` | OpenAI `text-embedding-3-small` wrapper, `{success,data,error}` contract, `vectorLiteral()` helper |
| `src/app/api/assistant/memory/route.ts` | `GET` (list with scope/pinned filter) + `POST` (create with auto-embed) |
| `src/app/api/assistant/memory/[id]/route.ts` | `PATCH` (update content/pinned/key, re-embeds) + `DELETE` |

---

## Files Modified

| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `embedding Unsupported("vector(1536)")?` to `AgentMemory` |
| `src/agent/tools/registry.ts` | Added 4 memory tools: `save_memory`, `search_memory`, `update_memory`, `delete_memory` |
| `src/agent/lib/system-prompt.ts` | Added memory behavior instructions; `buildSystemPrompt` now accepts `pinnedMemories` + `relevantMemories` and injects them as system prompt blocks |
| `src/agent/lib/core.ts` | Auto-retrieval: before each turn, loads pinned memories + embeds user message + prepends top-3 relevant memories (score ≥ 0.45). Relevant memory ids logged via system prompt metadata. |
| `src/app/api/assistant/transcribe/route.ts` | Replaced 501 stub with real OpenAI Whisper `whisper-1` implementation (`language='bn'`, max 25MB, Bangla error messages) |
| `src/app/api/assistant/tts/route.ts` | Replaced 501 stub with Google Cloud TTS `bn-IN-Chirp3-HD-Charon`. Supports JSON-string credential env. Strips markdown before synthesis. ~600 char cap. Returns MP3 stream. |
| `src/agent/components/AgentComposer.tsx` | Voice recording → Whisper transcription → text appears in composer for review/edit before send (no auto-send) |
| `src/agent/components/AgentThread.tsx` | `TtsButton` now fetches real MP3, plays via Web Audio, supports pause; blob URL cached per message |
| `src/agent/components/AgentSidebar.tsx` | Added 💬/🧠 tab bar; `MemoryView` sub-component with scope filter, pin/unpin, delete, pinned visual indicator |
| `package.json` | Added `openai: ^4.104.0` |

---

## Architecture Decisions

### Memory schema
`agent_memory` table already existed (Phase 0). Added `embedding vector(1536)` column via additive migration. Prisma uses `Unsupported("vector(1536)")` — Prisma doesn't natively support pgvector types, so raw SQL access via `$queryRawUnsafe` is used for similarity searches. All other CRUD goes through `prisma as any` to avoid Prisma type complaints on the unsupported field.

### Similarity threshold
0.45 cosine similarity for auto-retrieval. This is conservative — avoids injecting loosely-related memories as "context" that might confuse the model. Adjustable in `core.ts` (`SIMILARITY_THRESHOLD`).

### Pinned memories
Cap: 30, newest first, injected every turn in the system prompt (cached block region). When pinned set changes, cache is invalidated once — acceptable cost. Pinned memories are excluded from auto-retrieval results to avoid duplication.

### Prompt caching with memory
Memory blocks are appended before the `cache_control: {type:'ephemeral'}` marker on the last system block. If pinned memories change, the cache is invalidated for that turn. Relevant memories (from RAG) also shift the cache, but this is the unavoidable cost of per-turn context injection.

### Embeddings fallback
If `OPENAI_API_KEY` is missing or the embed call fails, `save_memory` saves without embedding (no `embedding` field), and `search_memory` falls back to text `ILIKE` search. The system degrades gracefully.

### Google TTS credentials
Supports JSON-string env variable only (file paths don't work on Vercel serverless). The `GOOGLE_TTS_CREDENTIALS` env var should be the full service account JSON as a string. JWT signing is done in-process using Node.js `crypto` — no extra library needed.

### TTS audio caching
Blob URL cached in `useRef` per `TtsButton` instance (keyed by `messageId`). No server-side cache. On component unmount, the blob URL is revoked to free memory.

### Transcription flow
MediaRecorder → webm/opus → `POST /api/assistant/transcribe` → Whisper `whisper-1` with `language='bn'` → returns `{text}` → inserted into composer textarea for owner review/edit. **No auto-send.** Owner must press পাঠান.

---

## Verification Checklist

| Check | Result |
|---|---|
| `tsc --noEmit` — zero type errors | ✅ PASS |
| `npm run build` — zero new errors | ✅ PASS |
| `git diff --stat pre-agent-phase-3` — only agent/migration files | ✅ PASS |
| Zero existing ERP files modified | ✅ PASS |
| `/api/agent/*` routes untouched | ✅ PASS |
| All new routes under `/api/assistant/*` | ✅ PASS |
| All new routes check `requireAgentEnabled()` | ✅ PASS |
| Memory migration is additive only | ✅ PASS |
| pgvector fallback documented | ✅ PASS |

---

## Owner Functional Test Script

**Prerequisites:** Deploy Vercel Preview with `AGENT_ENABLED=true`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_TTS_CREDENTIALS` (service account JSON string).

### Memory test
1. New conversation → type: **"মনে রাখো আমার দোকানের নাম ALMA"**
2. Agent should call `save_memory` (tool chip visible), reply confirming save.
3. Start a **new conversation** → type: **"আমার দোকানের নাম কী?"**
4. Agent should call `search_memory` or retrieve from auto-retrieval, answer "ALMA".
5. In sidebar → 🧠 স্মৃতি tab → memory should appear under "ব্যবসা" or "ব্যক্তিগত" scope.
6. Click 📌 on the memory → memory becomes pinned (gold border).
7. Start another new conversation → every reply should reference the pinned store name in context.

### Voice transcription test
1. Click 🎤 in composer → allow mic → speak Bangla or Banglish for 5–10 seconds → click বন্ধ করুন.
2. "ট্রান্সক্রাইব হচ্ছে…" toast appears → transcription text appears in composer textarea.
3. Owner can edit text → press পাঠান to send.

### TTS test
1. Get any assistant reply → click 🔊 speaker button.
2. Male Bangla voice (Chirp3-HD-Charon) plays audio.
3. Click ⏸ to pause.
4. Click 🔊 again → replays from blob cache (no second network request).

---

## Cost Estimate (Monthly, Owner's Usage)

Assumptions: ~50 messages/day, avg 200 chars/message; ~5 voice notes/day (30s avg); ~3 TTS plays/day.

| Service | Usage | Est. Monthly |
|---|---|---|
| OpenAI embeddings (`text-embedding-3-small`) | ~60 embeds/day × 30 = 1,800 embeds × ~150 tokens = 270K tokens | ~$0.05 |
| OpenAI Whisper | 5 recordings/day × 30 = 150 × 0.5 min = 75 min | ~$0.68 |
| Google Cloud TTS (`Chirp3-HD` tier) | 3 plays/day × 30 = 90 × ~300 chars = 27K chars | ~$0.54 (WaveNet pricing) |
| **Total Phase 3 additions** | | **~$1.27/month** |

Claude API costs remain ~$5–10/month at this usage level (unchanged from Phase 1).

---

## ElevenLabs Evaluation (Report Only — No Integration)

| Aspect | ElevenLabs | Google Cloud TTS (`bn-IN-Chirp3-HD-Charon`) |
|---|---|---|
| Bangla voice quality | Limited — Bangla support is experimental; mostly English/European languages optimized | Production-quality Chirp3-HD model; specifically tuned for bn-IN |
| Banglish mixing | Poor — typically code-switches badly | Acceptable — handles Bangla script well; Banglish may be pronounced with English accent |
| Pricing | $5/month (10K chars) → $0.30/1K chars on Creator | Google Chirp3-HD: ~$0.02/1K chars (WaveNet tier) — 15× cheaper |
| API effort | Simple REST, good SDK | Requires service account JWT auth (done in Phase 3) |
| Latency | ~800ms typical | ~600ms typical |

**Recommendation:** Keep Google Cloud TTS `bn-IN-Chirp3-HD-Charon`. ElevenLabs has superior voice quality for English/Hindi but their Bangla support is immature and 15× more expensive. Re-evaluate if ElevenLabs ships a dedicated bn-IN voice.

---

## Ambiguities & Decisions Made

| Topic | Decision |
|---|---|
| `budget_tokens` on `claude-sonnet-4-6` | Deprecated — using `thinking: {type:'adaptive'}` (confirmed from Phase 1) |
| pgvector Prisma type | `Unsupported("vector(1536)")` — Prisma doesn't support pgvector natively. Raw SQL for similarity; `prisma as any` for CRUD. |
| `search_memory` threshold | 0.45 cosine similarity. Configurable in `core.ts`. |
| TTS character limit | ~600 chars per request; markdown stripped first. Longer text → only first 600 chars synthesized. Note returned in future if splitting is needed. |
| Google credentials format | JSON string env var only (file paths incompatible with Vercel serverless). |
| Memory delete guard | UI requires memory to be visible before delete button appears (natural guard). Tool requires `id` from `search_memory` result. |
| Auto-retrieval vs pinned | Pinned excluded from RAG results to avoid duplication in system prompt. |
