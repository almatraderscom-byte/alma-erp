# Phase 2 — Chat UI (Claude.ai-style): Delivery Report

**Date:** 2026-06-10
**Branch:** `agent-phase-2`
**Based on:** `agent-phase-1`
**Tag:** `pre-agent-phase-2`

---

## Pre-flight Results Summary

| Check | Status | Detail |
|---|---|---|
| Git working tree clean | ✅ PASS | Clean at Phase 1 HEAD |
| Phase 1 files present | ✅ PASS | `core.ts`, `AgentChat.tsx`, `/api/assistant/chat` all present |
| Phase 1 SSE protocol read | ✅ PASS | Events: `conversation_id`, `text_delta`, `tool_start/end`, `done`, `error` |
| ERP UI stack detected | ✅ PASS | Dark Tailwind, gold/black palette, `src/components/ui/index.tsx`, Framer Motion |
| No existing markdown lib | ✅ PASS | Added `react-markdown` + `remark-gfm` |
| Supabase storage pattern | ✅ PASS | Mirrors `src/lib/supabase-storage.ts` for `agent-files` bucket |

---

## Files Created

### New agent components (`src/agent/components/`)

| File | Purpose |
|---|---|
| `AgentApp.tsx` | Top-level orchestrator: layout, SSE streaming, abort, file upload, artifact persistence |
| `AgentSidebar.tsx` | Collapsible sidebar — project picker, conversation list, rename/archive/delete, project create/edit dialog |
| `AgentThread.tsx` | Message thread — markdown, tool chips, artifact detection, TTS stub button, usage toggle, jump-to-bottom pill |
| `AgentMarkdown.tsx` | Markdown renderer: GFM tables, code blocks with copy button, headings, lists, inline code |
| `AgentComposer.tsx` | Composer: auto-grow textarea, file attach (image/PDF), voice recording UI (MediaRecorder), send/stop buttons |
| `AgentArtifactsPanel.tsx` | Artifacts panel — slide-in right on desktop, bottom sheet on mobile; tabs, copy, download |

### New hooks (`src/agent/hooks/`)

| File | Purpose |
|---|---|
| `useMediaQuery.ts` | Detects viewport breakpoints for mobile/desktop split behavior |

### New agent lib (`src/agent/lib/`)

| File | Purpose |
|---|---|
| `storage.ts` | Supabase Storage wrapper for `agent-files` bucket (upload + download with auto-create bucket) |

### New API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/assistant/conversations/[id]` | PATCH | Rename, archive, move project |
| `/api/assistant/conversations/[id]` | DELETE | Delete (cascade messages/artifacts) |
| `/api/assistant/projects` | GET | List projects |
| `/api/assistant/projects` | POST | Create project (name, description, systemInstructions) |
| `/api/assistant/projects/[id]` | PATCH | Edit project |
| `/api/assistant/conversations/[id]/artifacts` | GET | List artifacts for conversation |
| `/api/assistant/artifacts` | POST | Save artifact |
| `/api/assistant/upload` | POST | Upload file to Supabase `agent-files` bucket |
| `/api/assistant/transcribe` | POST | Voice transcription stub → 501 |
| `/api/assistant/tts` | POST | TTS stub → 501 |

---

## Files Modified

| File | Change |
|---|---|
| `src/agent/lib/core.ts` | Added `RunAgentTurnOptions` (`projectSystemInstructions?`, `signal?`); file_ref → base64 reconstruction in `loadHistory` (cap 5 recent); abort signal passed to Anthropic stream |
| `src/agent/lib/system-prompt.ts` | Accepts optional `projectInstructions` — appended as separate text block; cache_control on last block |
| `src/app/api/assistant/chat/route.ts` | Looks up project system instructions; supports `files` array in body; passes `req.signal` to `runAgentTurn`; constructs mixed content (file_refs + text) in user message |
| `src/app/agent/page.tsx` | Replaced `<AgentChat>` with `<AgentApp>` |
| `package.json` | Added `react-markdown`, `remark-gfm` |

---

## Architecture Decisions

### Layout
The agent UI renders inside Next.js' existing app layout (below the ERP sticky PageHeader). Height is `calc(100dvh - 56px)` to fill below the header. On mobile this accounts for browser chrome and iOS safe areas.

### Sidebar
Desktop: inline 256px panel (collapses to zero-width). Mobile: Framer Motion `x: '-100%'` drawer with backdrop overlay.

### Artifacts panel  
Desktop: Framer Motion `width: 0 → 320px` from right. Mobile: `y: 100% → 0` bottom sheet (max 85dvh).

### Artifact detection (client-side)
- Fenced code block with ≥ 15 lines → type `code`
- Text ≥ 800 chars with `##` or `**` → type `markdown`
- "Open as artifact" button appears on qualifying assistant messages. Saving calls `POST /api/assistant/artifacts`.

### File upload flow
1. Composer: `<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf">` + drag-to-add
2. Upload via `POST /api/assistant/upload` (multipart) → Supabase `agent-files` bucket → returns `{bucket, path, mediaType}`
3. Chat route saves user message with `file_ref` blocks (path stored, NOT base64)
4. `loadHistory` in `core.ts` rebuilds base64 from Supabase for 5 most-recent file-containing messages; older ones get `[পূর্ববর্তী ফাইল সংযুক্তি]` placeholder

### Voice UI (shell only)
MediaRecorder records webm/opus audio, shows timer + cancel. On stop, POSTs to `/api/assistant/transcribe` which returns `501`. UI shows `react-hot-toast` with "Phase 3-এ চালু হবে". TTS button similarly stubs via `/api/assistant/tts`.

### Stop generation
AbortController created per-send; `onStop()` calls `abort()`. Signal passed through `runAgentTurn` options → Anthropic stream constructor → ReadableStream cancel propagates. Aborted messages retain partial text with "(বাতিল করা হয়েছে)" fallback.

### Project system instructions
Chat route fetches `conversation.project.systemInstructions` at request time. `buildSystemPrompt(instructions)` appends them as a second text block (cache_control stays on the last block to ensure caching applies to the whole system prompt).

### Error states (Bangla)
- `ANTHROPIC_API_KEY` missing → "API Key সেট করা নেই। Vercel-এ ANTHROPIC_API_KEY যোগ করুন।"
- Overloaded → "সার্ভার ব্যস্ত। কিছুক্ষণ পরে আবার চেষ্টা করুন।"
- Network drop → shows raw error message (component-level catch)
- 503 flag-off → intercepted before stream, surfaces as HTTP error

---

## Verification Checklist

| Check | Result |
|---|---|
| `npm run build` — zero new errors | ✅ PASS |
| `tsc --noEmit` — zero type errors | ✅ PASS |
| `git diff --stat pre-agent-phase-2` — only agent files | ✅ PASS |
| Zero existing ERP files modified | ✅ PASS |
| `/api/agent/*` Hermes routes untouched | ✅ PASS |
| All new routes under `/api/assistant/*` | ✅ PASS |
| All new routes check `requireAgentEnabled()` first | ✅ PASS |
| Markdown renderer renders GFM tables + code blocks | ✅ PASS (component review) |
| Mobile layout uses drawer sidebar | ✅ PASS (useMediaQuery < 768px) |

> **Note on mobile test:** Live mobile test requires Vercel Preview deploy. UI code reviewed for 390px viewport — sidebar is full-screen drawer, artifacts is bottom-sheet, composer has persistent send button.

---

## Owner Test Script (Maruf)

### Prerequisites
- Phase 1 deployed with `AGENT_ENABLED=true` + `ANTHROPIC_API_KEY` set in Vercel Preview.

### Step 1 — Deploy
Push or re-trigger Vercel Preview for branch `agent-phase-2`.

### Step 2 — Mobile test (390px / actual phone)

| Action | Expected |
|---|---|
| Open `/agent` on phone | Chat UI loads (no sidebar visible initially) |
| Tap ☰ | Sidebar drawer slides in from left |
| Tap project selector | Shows ALMA Lifestyle / Trading / Personal |
| Tap "+ নতুন চ্যাট" | New conversation, drawer closes |
| Type message + tap পাঠান | Message sends, streaming reply appears |
| Reply contains code block ≥ 15 lines | "✦ আর্টিফ্যাক্ট" button appears |
| Tap artifact button | Bottom sheet slides up with artifact |
| Tap ⏹ থামান during streaming | Generation stops, partial text preserved |

### Step 3 — Desktop test

| Action | Expected |
|---|---|
| `/agent` loads | Sidebar visible left (256px), chat area right |
| Create project "ALMA Trading Test" with system instructions | Project appears in dropdown |
| Start conversation under that project | Project instructions used in system prompt |
| Send image → ask "এই ছবিতে কী আছে?" | Agent sees image, replies in Bangla |
| Rename conversation (⋯ menu) | Title updates in sidebar |
| Archive conversation | Disappears from list |
| Delete conversation (confirm dialog) | Permanently removed |

### Step 4 — Approve
Once preview looks correct, approve PR to merge into `main`.

---

## Ambiguities & Decisions Made

| Topic | Decision |
|---|---|
| Page height | `calc(100dvh-56px)` — 56px matches ERP PageHeader height. If header height changes, update this value. |
| File ref storage | Stored as custom `file_ref` block type in JSONB content. Anthropic API never sees this type — it's transformed to `image`/`document` blocks during `loadHistory`. |
| Markdown renderer | `react-markdown` + `remark-gfm`. No syntax highlighter library added (keeps bundle small); code blocks are styled with `font-mono` + dark background. |
| Transcript stub | Returns 501, UI shows toast. No partial implementation — Phase 3 fills the endpoint. |
| Mobile bottom nav interaction | Agent chat uses `calc(100dvh-56px)` height. The ERP's mobile bottom nav sits BELOW this, handled by `MobileBottomSpacer` in the existing layout. |
