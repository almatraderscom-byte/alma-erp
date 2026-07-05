# Phase A1 Report — Agent chat access + Brand Recipes

**Date:** 2026-07-05 · **Branch:** `agent-phase-a1` · **Tag:** `pre-agent-phase-a1`

## Shipped

1. **`run_creative_studio` head tool** — "ei panjabir baba-chele set banao",
   "offer reel banao", "আমার ভয়েসে বলাও" now work from chat. One tool routes to
   the SAME engines the UI uses: family accuracy chain (all presets incl.
   কাপল/বাবা+মেয়ে), Veo reels (16s+ → multi-clip chain, cost noted), shot-video
   recipe edits (captions/voiceover options), and every Audio Lab action.
   The agent decides nothing creative — presets + Brand Recipe do.
2. **`check_studio_job` + self-verification contract** — the run tool only
   QUEUES; the head must poll check_studio_job and may claim success ONLY on
   `executed` + signed artifact URL (claim-verifier discipline, spelled out in
   both tool descriptions).
3. **Brand Recipe store** (kv `studio_brand_recipe`, owner-tunable, no
   redeploy): defaultFamilyPreset / defaultVideoRecipe / defaultMusicStyle /
   defaultAspect — get/set via the same tool; omitted params fall back to the
   recipe, not the agent's taste.
4. **Catalog cross-link** — 📸 ক্যাটালগ chip in the Studio header opens
   `/agent/catalog-images` (the "one central place" vision; full fold-in noted
   as future work).

## Verification
| Check | Result |
|---|---|
| tools/lib suites 167 · tsc · next build | PASS |
| Live chat run | do together: owner says "বাবা-ছেলে সেট বানাও" with a product photo in chat |
