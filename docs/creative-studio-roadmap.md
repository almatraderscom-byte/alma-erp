# Creative Studio Program — Full Roadmap (start here)

**Date:** 2026-07-04 · **Owner:** Maruf (non-engineer). Reply in Bangla, concise.
**Goal:** the Studio becomes the ONE place where all business creatives are produced with **zero prompt-hunting** — the owner uploads a product photo or his own shot video, taps one preset, and the system does everything. Hard presets over LLM judgment.

> **How the owner starts a new session:** paste — *"docs/creative-studio-roadmap.md pore phase <X> shuru koro"*. One phase per session.

---

## 0. NON-NEGOTIABLE rules for every phase

1. **No LLM creative judgment.** The owner explicitly does not trust the agent to "catch" what a creative should look like (wasted tokens on retries). Pipelines are deterministic engines with hard-coded recipes; LLM calls only for narrow mechanical sub-tasks (transcribe, child-garment render, merge with a fixed prompt) — never open-ended creative decisions.
2. **Variety is mandatory:** no two runs may share the same model pose; backgrounds must always be authentically Bangladeshi. Both come from the deterministic pool in `src/lib/tryon/scene-pool.ts` — extend the pool, never bypass it.
3. Long work (video, chains) runs on the **VPS worker** as `agentPendingAction` jobs (status `approved`, worker polls) — never Vercel functions. Chain steps advance via the `job-result` callback (`advanceFamilyChain` is the pattern to copy).
4. Islamic guardrails on all output; owner-facing text pure Bangla ("Sir"); whole-taka money via `roundMoney`.
5. All CLAUDE.md hard rules apply (agent file boundaries, additive migrations, browser proof before "done" — owner may explicitly defer the live proof, then hard-verify with tests + build instead and test live together later).

## 1. Where the work lives (current state — what's DONE)

- **UI:** `src/agent/components/creative-studio/CreativeStudio.tsx` (views: Studio Auto/Advanced · Gallery · Models · Finishing · Video[OpenCut iframe placeholder]); page `/agent/creative-studio`.
- **Engine:** `src/lib/creative-studio/create-run.ts` (mode routing), `src/lib/tryon/` (art-director prompts, model library w/ roles father/mother/son/daughter, garment classify+cache), FASHN client `src/lib/fashn/`, worker `worker/src/index.mjs` + `worker/src/fashn/`.
- **✅ Family accuracy chain (PR #232, 2026-07-04):** `src/lib/tryon/family-chain.ts` + `scene-pool.ts`. One-tap family shots run as an assembly line: adult FASHN try-on → child-size garment (Gemini, **cached per product+role** in kv `tryon_child_garment:<role>:<path>`) → child FASHN try-on with the SAVED child model (same face every run) → Gemini merge into one BD scene. full_family = two sub-chains + once-only group merge (kv-guarded). Singles get FASHN → BD-background swap. Chain progress surfaces via `jobs/[id]` (ধাপ N/M). Tests: `src/lib/tryon/__tests__/family-chain.test.ts` (8 e2e simulations).
- **Why the chain exists:** suppliers send ONE adult product photo (child piece of matching sets has no photo); the old one-shot Gemini path never received the child model image (worker passes max 2 refs) so every run hallucinated a new child. Root-cause doc'd in PR #232.
- **Pending from owner:** save son + daughter models in the Models tab; live browser test of the chain (deferred, do together).

## 2. Remaining phases (do in this order)

### Phase V1 — Video ingest + deterministic Recipe Engine  ← NEXT
The owner shoots 1–2 min videos on his phone; the system cuts them into reels. **Zero LLM.**
- Video upload (mp4/mov/HEIC-video from iPhone, ~500 MB): signed upload URL direct to Supabase storage (bypass Vercel body limits), new `video_edit` job type.
- Replace the OpenCut iframe with a real Video section: pick an uploaded video + a **Recipe** — hard presets, e.g. `family_shoot`, `product_showcase`, `offer_promo` — each recipe = fixed cut lengths (15/30/60s), transition style, crop rule, output aspect (9:16 default).
- Worker pipeline (ffmpeg on VPS, free compute): transcode → scene-change detection (`scdet`) → recipe cut-plan (pure function — unit-test it like the chain) → 9:16 center-crop → outputs to gallery.
- Verification: cut-planner unit tests with fixture timestamps; one sample video end-to-end on the VPS.

### Phase V2 — Caption + audio layer (still deterministic)
- Whisper transcription (mechanical, allowed) → **Bangla captions burned in** (ASS subtitles, brand font/colour from BrandAsset).
- Music beds: owner uploads 5–10 approved tracks tagged by vibe; recipe picks one (round-robin/random — variety rule), audio ducking under speech.
- Logo intro/outro stings: pre-rendered clips concatenated (ffmpeg concat), no per-run rendering.

### Phase V3 — Motion templates ("After Effects" layer)
- **Remotion** renderer on the VPS worker (React-based video templates — fits the stack).
- Templates: price-tag pop-up, product-code lower-third, animated ALMA logo, end-card CTA. Owner fills code/price at finishing time — the video twin of the image Finishing tab.
- Each template is code: deterministic, reusable, unit-testable render props.

### Phase CS4 — Image polish + taste weighting (small, can ride along any phase)
- "আবার চালাও" (retry) button on a failed chain step (re-create that step's action, keep artifacts).
- Owner feedback on gallery items (ভালো/বাদ) → **deterministic weighting** of scene-pool entries (favour liked scenes/poses; still random, never LLM-scored).
- Optional: per-scene enable/disable in a settings sheet (kv `studio_scene_weights`).

### Phase A1 — Agent chat access + Brand Recipes
Only after image + video quality is proven to the owner.
- Head tool `run_creative_studio` (thin wrapper over `runCreativeStudio`/`startFamilyChain`) so chat like *"ei panjabir baba-chele set banao"* works; self-verify via claim-verifier before replying.
- **Brand Recipe** store (kv, owner-tunable, no redeploy): preferred scenes subset, default model set, finishing theme, caption tone — the agent picks the recipe, not its own taste.

### Phase A2 — One-tap Campaign packs (endgame)
- Campaign = images (family set) + reels + captions + posting schedule in ONE tap, reusing content-engine approval gates (`gate1/gate2`) — nothing auto-posts without the owner.
- Product auto-pick from ERP data (new arrivals / best-sellers) proposed weekly; owner approves the calendar.

## 3. Cost notes (owner is cost-sensitive)

- Family chain ≈ $0.50–0.70 per finished pair (2× FASHN + 1–2 Gemini), child garment cached after first run; far cheaper than repeated one-shot retries.
- V1/V2 editing = ffmpeg on VPS → ~zero marginal cost; Whisper pennies/min; Veo reels stay owner-initiated only.
- Remotion renders on VPS → free compute.

## 4. Gotchas

- FASHN try-on keeps the **model photo's background** — that's why singles need the rescene step; never remove it thinking it's redundant.
- The merge step must reuse the SAME `SceneRef` as its inputs (one scene per chain) or lighting won't match.
- `getModelByRole` falls back to the default ADULT model when a role is missing — the chain deliberately bypasses that with strict `listModelsByRole` checks + `FamilyChainModelError`. Keep it strict.
- Native iOS app loads live production in WebViews — studio changes reach the app on web deploy (service-worker refresh caveat; see `docs/ios-native-frame-handoff.md` §6).
- Worker deploy is auto via `deploy-worker.yml` on main; pm2 app `alma-agent-worker`.
