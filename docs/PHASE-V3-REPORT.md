# Phase V3 Report — Motion templates ("After Effects" layer, Remotion)

**Date:** 2026-07-05 · **Branch:** `agent-phase-v3` · **Tag:** `pre-agent-phase-v3`

## What shipped

The **video twin of the image Finishing tab**: open a finished reel in the
Gallery → "টেমপ্লেট ফিনিশিং" → type দাম/কোড/CTA → the VPS renders animated brand
templates over the reel and it comes back as the item's "টেমপ্লেট সহ" version
(same brandedPath mechanics as image finishing; Drive archive picks it up).

### The five templates (all deterministic code, no LLM anywhere)

| Template | Motion |
|---|---|
| দাম pop-up | spring pop, tilted brand-orange tag, bottom-right |
| প্রোডাক্ট কোড lower-third | slide-in bar with code + name, auto slide-out |
| ALMA লোগো ওয়াটারমার্ক | soft drop-in, top-right, whole reel |
| এন্ড কার্ড | last 2.5s: brand backdrop, logo, code·দাম, CTA pill |
| অফার কাউন্টডাউন | pulsing red badge, বাংলা সংখ্যায় দিন |

### How it works

- **Pure planner app-side** (`src/lib/creative-studio/video-finish.ts`,
  `buildOverlayPlan()` — 5 unit tests): every timing decision (end card owns
  the last 2.5s, price enters at 15%, lower-third 0.5s→4s…) is frame-exact and
  deterministic. The Remotion components only animate what the plan dictates.
- **Remotion on the VPS worker** (`worker/remotion/` JSX + `video-finish.mjs`):
  webpack bundle cached per boot, Chrome Headless Shell pre-warmed at startup;
  renders a TRANSPARENT vp8 webm (React never touches the reel's pixels), then
  ffmpeg composites it over the reel — one encode, audio copied. Bundled Noto
  Sans Bengali via the Remotion public dir (correct Bangla shaping verified by
  a local still render).
- **Job flow**: new `video_finish` pending-action (queue `video-finish`,
  concurrency 1, 30-min lock, attempts 2), ধাপ ১-৪ progress via the same
  tracker, P0 checkpoint on failure. The finish job itself never appears in the
  gallery — its output lands on the SOURCE item as `brandedPath`.

## Files

**New:** `video-finish.ts` + tests, `creative-studio/video/finish/route.ts`,
`worker/remotion/{index,Root,FinishOverlay}.jsx` + `public/NotoSansBengali.ttf`,
`worker/src/video-finish.mjs`.
**Modified:** `pending-jobs/route.ts` (+`video_finish`), `worker/src/index.mjs`
(queue/worker/preflight), `worker/package.json` (+remotion/@remotion/bundler/
@remotion/renderer/react/react-dom), `CreativeStudio.tsx` + `studio-api.ts`
(VideoFinishPanel, টেমপ্লেট সহ/আসল toggle on video lightbox).
**Migrations:** none.

## Verification checklist

| Check | Result |
|---|---|
| Overlay-planner unit tests (5) — all-template bounds, end-card ownership, short-reel shrink, determinism, clamping | PASS |
| Full vitest suite | PASS (727 incl. new; 6 pre-existing agent-tools tests flake ONLY under full-suite CPU load — 5s-timeout borderline, pass in isolation and on clean main; unrelated to V3) |
| `tsc --noEmit` · `next build` · `node --check` worker | PASS |
| **Local Remotion render** — bundle + transparent vp8 render + still frame visually checked (correct Bangla shaping, all templates positioned) | PASS |
| **Live e2e on the VPS (2026-07-05, post-merge)** — all five templates on a real reel, frame-checked: countdown in Bangla numerals + watermark + lower-third + price tag mid-reel, full end card (logo, code·price, CTA pill) at the tail; audio intact | PASS |

## Flags for the owner

- **Remotion license:** Remotion is free for individuals and companies with up
  to 3 people; larger companies need a paid Company License. If ALMA's team
  size crosses that line, a license should be purchased before regular business
  use ($ small, one dev seat). Flagged — owner's call.
- First finish job after a worker deploy pays a one-time cold start (bundle +
  browser download) unless the startup preflight has already finished.
- VPS disk/RAM: +~350 MB node_modules and a headless Chrome during renders;
  concurrency capped at 1 to protect the box.
