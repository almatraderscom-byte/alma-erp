# Phase V1 Report — Video ingest + deterministic Recipe Engine

**Date:** 2026-07-05 · **Branch:** `agent-phase-v1` · **Tag:** `pre-agent-phase-v1`

## What shipped

The Studio's Video tab is now a real Video Studio (the OpenCut iframe placeholder is gone).
The owner uploads his 1–2 min phone shoot, taps one Recipe, and the VPS worker cuts it into
ready reels that land in the Gallery — **zero LLM anywhere in the pipeline**.

### Flow

1. **Upload** — browser gets a signed upload URL and PUTs the file (mp4/mov/HEVC, up to
   ~500 MB) STRAIGHT into Supabase storage (`studio-video/uploads/…`). Vercel never sees the
   body. Real progress bar (XHR). Uploads are registered in `agent_kv_settings`
   (`studio_video_upload:<id>`) — no new tables.
2. **Recipe** — hard presets: `family_shoot` (5s clips, 0.5s crossfade), `product_showcase`
   (3s clips, hard cuts), `offer_promo` (2s clips, fastest). Output length 15/30/60s
   (multi-select → one job per reel), aspect 9:16 (default) / 1:1 / 16:9.
3. **Worker** (`video_edit` job, BullMQ queue `video-edit`, ffmpeg on the VPS — free compute):
   download (streamed to disk) → ffprobe → scene detection (`select=gt(scene,0.3)` at 320px,
   cached per source in kv) → **cut plan fetched from the app's pure planner** → trim +
   concat/xfade + HDR→SDR tonemap (iPhone HLG/PQ, zimg fallback) + center-crop + H.264/SDR
   encode → thumbnail → upload `generated/<id>.mp4`.
4. **Progress** — worker writes ধাপ N/M (৫ ধাপ) into the pending-action payload; the Video tab
   and `jobs/[id]` surface it exactly like the family chain. Failures leave the standard P0
   checkpoint; BullMQ retries once before reporting failure.
5. **Gallery + Drive** — reels are normal studio gallery items (`video_edit` type added to the
   gallery route and the Drive archive sweep), playable in the lightbox, downloadable.

### The deterministic heart

`src/lib/creative-studio/video-recipes.ts` — recipes + `planCuts()`, a pure function
(no I/O, no randomness, no clock): scene intervals → clip-sized candidate windows →
evenly-spread selection → crossfade-aware tail trim to hit the target ±1s. The worker calls
`/api/assistant/internal/video-cut-plan` (AGENT_INTERNAL_TOKEN) so the algorithm lives in
exactly ONE place and stays unit-tested.

## Files

**New:** `src/lib/creative-studio/video-recipes.ts`,
`src/lib/creative-studio/__tests__/video-cut-plan.test.ts` (11 tests),
`src/app/api/assistant/creative-studio/video/{route,upload-url/route,run/route}.ts`,
`src/app/api/assistant/internal/video-cut-plan/route.ts`, `worker/src/video-edit.mjs`.

**Modified:** `CreativeStudio.tsx` (VideoStudioView replaces the OpenCut iframe),
`studio-api.ts` (video helpers), `src/agent/lib/storage.ts` (signed upload URL, HEAD info,
delete, bucket limit 100→512 MB), `gallery/route.ts` + `jobs/[id]/route.ts` +
`pending-jobs/route.ts` (+`video_edit`), `worker/src/index.mjs` (queue/worker/dispatch),
`worker/src/schedulers/studio-archive.mjs` (+`video_edit`).

**Migrations:** none (kv registry only — additive rule respected).

## Verification checklist

| Check | Result |
|---|---|
| Cut-planner unit tests (11, fixture timestamps) | PASS |
| Full vitest suite (691 tests) | PASS |
| `tsc --noEmit` | PASS |
| `next build` | PASS (ESLint skipped locally — nested-worktree plugin conflict; runs on Vercel) |
| `node --check` on worker files | PASS |
| `git diff --stat` scope — agent/studio/worker files only, zero ERP files | PASS |
| ffmpeg on VPS | already present (Twilio TTS pipeline uses it); pipeline still preflights `ffmpeg -version` per job |
| Live e2e (sample video → reel on VPS) | requires worker deploy from main — done together with the owner after merge |

## Decisions / ambiguities

- **One job per output length** (not one job with 3 outputs): each reel is its own gallery
  item, retryable alone, and the archive sweep needs no changes.
- **Planner app-side, executor worker-side** — the worker has no test runner, so the pure
  function lives in `src/` under vitest and the worker fetches the plan (same trust boundary
  as pending-jobs/job-result).
- **Scene timestamps cached** in kv (`studio_video_scenes:v1:<path>`) so a 15s+30s+60s run
  detects scenes once, not three times.
- **HDR tonemap fallback**: if the VPS ffmpeg lacks zimg, the render retries without the
  tonemap chain (slightly washed colours beat a dead job). V2's caption work should confirm
  zimg is present.
- **Storage lifecycle**: originals are large; V1 gives the owner a delete button in the Video
  tab and reels go through the existing Drive archive+cleanup. Auto-retention for *originals*
  is deferred to CS4 (roadmap gotcha noted).
