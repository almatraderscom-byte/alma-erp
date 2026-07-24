# Phase CSE5 — Editing and Voice

## Goal

Provide the focused editing capabilities that improve output most, without building a full nonlinear editor.

## Deliverables

- Transcript/timing editor for captions and voiceover.
- Timeline-lite controls: trim, reorder, crop, safe-zone preview, per-track volume, caption placement, and cover selection.
- Dubbing and voice-change jobs with clear provider/cost estimate.
- Voice clone lifecycle: consent record, immutable versions, active version, audit history, and provider deletion/revocation.
- Cloned owner voice remains owner-only and cannot enter autonomous/customer-facing paths.
- Partial rerender of captions/audio/cover without regenerating visual source.

## Exact file allowlist

- `docs/creative-studio-enterprise/CSE5-editing-and-voice.md`
- `prisma/schema.prisma`
- `prisma/migrations/20260724200000_creative_voice_lifecycle/migration.sql`
- `src/agent/components/creative-studio/VideoStudioView.tsx`
- `src/agent/components/creative-studio/AudioLabView.tsx`
- `src/agent/components/creative-studio/TimelineLite.tsx`
- `src/agent/components/creative-studio/TranscriptEditor.tsx`
- `src/agent/components/creative-studio/VoiceLibrary.tsx`
- `src/agent/components/creative-studio/studio-api.ts`
- `src/app/api/assistant/creative-studio/audio/route.ts`
- `src/app/api/assistant/creative-studio/voices/route.ts`
- `src/app/api/assistant/creative-studio/voices/[id]/route.ts`
- `src/app/api/assistant/creative-studio/video/finish/route.ts`
- `src/lib/creative-studio/audio-lab.ts`
- `src/lib/creative-studio/voice-policy.ts`
- `src/lib/creative-studio/video-edit-contract.ts`
- `src/lib/creative-studio/__tests__/voice-policy.test.ts`
- `src/lib/creative-studio/__tests__/video-edit-contract.test.ts`
- `worker/src/audio-lab.mjs`
- `worker/src/elevenlabs-voices.mjs`
- `worker/src/video-edit.mjs`
- `worker/src/video-finish.mjs`
- `worker/src/index.mjs`
- `worker/src/__tests__/voice-lifecycle.test.mjs`

## Acceptance gates

- A fixture video can be trimmed/reordered/cropped and caption timing edited without regenerating source.
- A cloned voice version can be activated, revoked, and deleted from the provider with a durable audit record.
- Direct API attempts to use owner voice outside owner Studio context fail.
- Paid preview stays at or below `$1` and is confirmed before queueing.
- Tests, typecheck, build, Preview, and Chrome proof pass.

## Cost ceiling

`$1`.

