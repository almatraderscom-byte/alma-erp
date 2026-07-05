# Phase V4 Report — Generated-reel upgrades (Veo, owner-initiated only)

**Date:** 2026-07-05 · **Branch:** `agent-phase-v4` · **Tag:** `pre-agent-phase-v4`

## What shipped

1. **লম্বা generated রিল (16/24s)** — a multi-clip Veo chain: 2–3 × 8s clips,
   each with its OWN scene-pool scene (variety rule), stitched by the ffmpeg
   worker with a crossfade (`veoConcat` branch — free compute). Same
   assembly-line pattern as the family chain (`veo-chain.ts`, advanced from the
   job-result hook; 2 unit tests with mocked DB). Owner-initiated only —
   **cost is printed on the button itself** (~৳ per option, from the same
   $0.15/s Veo estimate; client-safe `reelCostBdt`).
2. **Family reel one-tap** — every finished studio IMAGE in the Gallery
   lightbox now has রিল ৬s/১৬s/২৪s buttons: the merged family photo becomes a
   moving reel with one tap (server path already existed; 16s+ routes to the
   new chain).
3. **AI হাইলাইট সাজেশন (বিটা, per-run, OFF default)** — Gemini watches a 320px
   5fps proxy of the owner's shoot and suggests up to 8 highlight timestamps.
   They are only ADDED to scdet's cut list — the deterministic planner still
   makes every decision; any failure silently falls back to pure scdet.

## Files

**New:** `src/lib/creative-studio/veo-chain.ts` + `__tests__/veo-chain.test.ts`.
**Modified:** `create-run.ts` (image_to_video ≥16s → chain), `job-result/route.ts`
(veoChain advance hook), `video-recipes.ts` (aiAssist option + `reelCostBdt`),
`video/run/route.ts` (aiAssist passthrough), `worker/src/video-edit.mjs`
(veoConcat branch + aiAssist merge), `worker/src/video-post.mjs`
(`processVeoConcat`, `suggestHighlights`), `CreativeStudio.tsx` + `studio-api.ts`
(reel buttons with ৳ cost, AI-assist checkbox). **Migrations:** none.

## Verification

| Check | Result |
|---|---|
| Veo-chain unit tests (2, mocked DB — clip walk, concat payload, guards) | PASS |
| Studio suite 29 tests · full vitest 728 · `tsc` · `next build` · `node --check` | PASS |
| Free concat e2e on VPS (stitch two existing e2e reels via `veoConcat`) | run post-merge |
| Full Veo-spend e2e (real 16s reel ≈ ৳300) | deliberately NOT auto-run — owner taps the button when he wants; the whole path to Veo (single clips) has been in production for months |

## Notes

- Chain clips appear in the Gallery as they finish, then the stitched reel
  lands as its own item; V2/V3 layers (captions/music/templates) can be applied
  to the stitched reel afterwards like any other video item.
- AI-assist cost: one Gemini Flash video pass on a tiny proxy (~fraction of a
  taka) — only when the owner ticks the box.
