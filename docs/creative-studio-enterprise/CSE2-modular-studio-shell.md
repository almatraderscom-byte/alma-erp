# Phase CSE2 — Modular Studio Shell

## Goal

Reduce the single-file UI risk while preserving every existing behavior.

## Deliverables

- Extract the main shell and each primary view into focused components.
- Centralize shared loading, empty, error, confirmation, and Bangla status UI.
- Centralize API response/error handling in the typed Studio client.
- Keep all existing URLs, job payloads, generation behavior, and visual hierarchy unchanged.
- Add contract tests for navigation state and API error normalization.

## Exact file allowlist

- `docs/creative-studio-enterprise/CSE2-modular-studio-shell.md`
- `src/agent/components/creative-studio/CreativeStudio.tsx`
- `src/agent/components/creative-studio/CreativeStudioShell.tsx`
- `src/agent/components/creative-studio/StudioWorkspaceView.tsx`
- `src/agent/components/creative-studio/GalleryView.tsx`
- `src/agent/components/creative-studio/VideoStudioView.tsx`
- `src/agent/components/creative-studio/AudioLabView.tsx`
- `src/agent/components/creative-studio/ModelLibraryView.tsx`
- `src/agent/components/creative-studio/StudioSettingsView.tsx`
- `src/agent/components/creative-studio/StudioUi.tsx`
- `src/agent/components/creative-studio/studio-api.ts`
- `src/lib/creative-studio/__tests__/studio-client-contract.test.ts`

No API, worker, or schema changes are allowed.

## Acceptance gates

- `CreativeStudio.tsx` is a composition shell, not a multi-thousand-line feature container.
- Auto, Advanced, Gallery, Video, Audio, Library, Settings, finishing, retry, feedback, and Drive controls remain live-functional.
- Before/after request payload snapshots match.
- Targeted tests, typecheck, build, Vercel Preview, and Chrome screenshot proof pass.

## Cost ceiling

`$0`.

