# Phase V2 Report — Caption + audio layer (still deterministic)

**Date:** 2026-07-05 · **Branch:** `agent-phase-v2` · **Tag:** `pre-agent-phase-v2`
**Builds on:** Phase V1 (PR #243, merged + live-e2e-proven the same day).

## What shipped

The Video Studio's reels can now carry **burned Bangla captions, an owner-approved
music bed (auto-ducked under speech), a Bangla TTS voiceover and ALMA logo
intro/outro** — every layer a hard toggle, zero LLM creative judgment, all
defaults OFF (a plain V1 run is byte-for-byte the same pipeline).

### Layers

1. **বাংলা ক্যাপশন** — the worker sends the reel's SPEECH to
   `/api/assistant/internal/video-captions`: `gpt-4o-transcribe` for accurate text
   (whisper-1 is bad at Bangla) + `whisper-1 verbose_json` for timing; the pure,
   unit-tested `alignCaptions()`/`buildAss()` (src/lib/creative-studio/captions.ts)
   marry them mechanically and return a ready ASS file. Burned with the **bundled
   Noto Sans Bengali** (`worker/assets/fonts/`, OFL license included) via
   `subtitles=…:fontsdir=…` — no VPS font provisioning needed.
2. **মিউজিক বেড** — owner uploads HIS approved tracks (Islamic guardrail: the
   system never fetches music from anywhere), tagged উৎসব/শান্ত/এনার্জেটিক, signed
   direct upload, kv registry. 'অটো' pick = deterministic kv round-robin
   (variety rule — consecutive runs get different beds). Modes: শুটের অডিও /
   শুধু মিউজিক / কথা + মিউজিক (`sidechaincompress` ducking, looped + faded).
3. **ভয়েসওভার** — owner types the line (≤220 chars); rendered by the EXISTING
   Google Bangla TTS (`worker/src/tts.mjs`, bn-IN-Chirp3-HD-Charon). Never
   LLM-written. Captions of a voiceover reel use the owner's exact text
   (`?text=` shortcut — one Whisper pass saved).
4. **লোগো intro/outro sting** — generated ONCE per aspect from the BrandAsset
   logo with the reel's exact encode params, cached in storage
   (`studio-video/stings/`), then **concat-copied** around the reel (roadmap:
   pre-rendered, no per-run rendering). Regenerates only when the logo changes.
5. **রিল কভার picker** — worker extracts 4 candidate frames
   (`generated/<id>-cover-N.jpg`); the Gallery lightbox shows a কভার strip; one
   tap → `video/cover` route sets it as the reel's thumbnail.

### Failure behaviour

Every layer degrades gracefully: a failed caption/music/sting layer ships the
reel WITHOUT that layer and records `postWarnings` in the job result — a reel
without captions beats a dead job. Video stays `-c:v copy` unless captions
force a re-encode (one extra encode max).

## Files

**New:** `captions.ts` + `captions.test.ts` (11 tests), `music-library.ts`,
`internal/video-captions/route.ts`, `creative-studio/music/{route,upload-url}.ts`,
`creative-studio/video/cover/route.ts`, `worker/src/video-post.mjs`,
`worker/assets/fonts/NotoSansBengali.ttf` (+OFL).

**Modified:** `video-recipes.ts` (V2 option types/constants), `video/run/route.ts`
(options validation, music resolve, brand-logo resolve), `gallery/route.ts`
(coverOptions), `worker/src/video-edit.mjs` (post stage, ধাপ ৬টা, covers),
`CreativeStudio.tsx` + `studio-api.ts` (options panel, music library, cover strip).

**Migrations:** none (kv registries only).

## Verification checklist

| Check | Result |
|---|---|
| Caption engine unit tests (11 — alignment, overlap, ASS scaling, Bangla fixtures) | PASS |
| Full vitest suite (712 tests) | PASS |
| `tsc --noEmit` · `next build` · `node --check` worker | PASS |
| `git diff --stat` scope — agent/studio/worker only, zero ERP files | PASS |
| **Live e2e on the VPS (2026-07-05, post-merge)** — voiceover + captions + stings + covers on the real worker; final reel 18.3s (1.2s logo intro + 15s + 1.6s outro), frame-checked | PASS (`postApplied: {captions, voiceover, stings}` all true, `captionRenderer: pango_overlay`, no warnings) |
| Music bed + ducking live test | NOT yet — owner's approved-track library is empty by design; run one after he uploads a track |

## Live-e2e hardening (same day, frame-level checks caught all three)

1. **PR #248** — OpenAI rejects `language:'bn'` on whisper-1 ("Language 'bn' is
   not supported"); timing pass now falls back to prompt-steered auto-detect.
2. **PR #249** — the VPS libass mangles Bangla complex-script shaping (reph/
   conjuncts broken, e-kar on the wrong side). Captions now render as per-cue
   PNG strips via sharp's SVG path (pango/harfbuzz shapes Bangla correctly)
   overlaid by ffmpeg for exactly each cue window; ASS stays as fallback.
3. **PR #250** — `density:96` scaled the strip 1.33× (librsvg's 72dpi baseline)
   pushing text off-frame, and `trim().metadata()` reported pre-trim size so
   auto-shrink never fired. Fixed; final frame check shows the caption centered,
   in-frame, correctly shaped.

## Decisions / ambiguities

- **Caption timing strategy:** whisper-1 is the only Whisper variant returning
  segment timestamps but garbles Bangla; `gpt-4o-transcribe` nails Bangla but
  has no timestamps. Both run (pennies for ≤60s reels) and a pure proportional
  aligner maps good text onto real timing. Deterministic, unit-tested.
- **Captions transcribe the SPEECH source** (original shoot audio or the
  voiceover), never the mixed track — music would pollute Whisper.
- **Voiceover replaces shoot audio** (deterministic rule); music under it ducks.
- **Music-only + captions + silent shoot** → captions skipped with a warning
  (nothing to transcribe) — the deterministic rule, not a guess.
- **OPENAI_API_KEY stays app-side only** — the worker reuses the internal-token
  endpoint pattern (same as pending-jobs/job-result/cut-plan).
