# Creative Studio Program — Full Roadmap (start here)

**Date:** 2026-07-04 · **Owner:** Maruf (non-engineer). Reply in Bangla, concise.
**Goal:** the Studio becomes the ONE place where all business creatives are produced with **zero prompt-hunting** — the owner uploads a product photo or his own shot video, taps one preset, and the system does everything. Hard presets over LLM judgment.

> **How the owner starts a new session:** paste — *"docs/creative-studio-roadmap.md pore phase <X> shuru koro"*. One phase per session.

---

## 0. NON-NEGOTIABLE rules for every phase

1. **No LLM creative judgment.** The owner explicitly does not trust the agent to "catch" what a creative should look like (wasted tokens on retries). Pipelines are deterministic engines with hard-coded recipes; LLM/AI calls only for narrow mechanical sub-tasks (transcribe, TTS, child-garment render, merge with a fixed prompt) — never open-ended creative decisions. AI-assist features ship OFF by default behind an owner toggle.
2. **Variety is mandatory:** no two runs may share the same model pose; backgrounds must always be authentically Bangladeshi. Both come from the deterministic pool in `src/lib/tryon/scene-pool.ts` — extend the pool, never bypass it.
3. Long work (video, chains) runs on the **VPS worker** as `agentPendingAction` jobs (status `approved`, worker polls) — never Vercel functions. Chain steps advance via the `job-result` callback (`advanceFamilyChain` is the pattern to copy).
4. Islamic guardrails on all output (no haram products/imagery, music beds owner-approved); owner-facing text pure Bangla ("Sir"); whole-taka money via `roundMoney`.
5. All CLAUDE.md hard rules apply (agent file boundaries, additive migrations, browser proof before "done" — owner may explicitly defer the live proof, then hard-verify with tests + build instead and test live together later).

## 1. Owner's vision → coverage map (nothing may be dropped)

Every requirement the owner stated, and which phase owns it:

| # | Owner's requirement (his words, condensed) | Phase |
|---|---|---|
| 1 | Studio = central place for ALL creatives; never go outside hunting prompts | all |
| 2 | Product images: family matching / বাবা-ছেলে / মা-মেয়ে as accurate as single try-on, ONE click | ✅ done (family chain) |
| 3 | Supplier gives only the ADULT product photo — system must produce the child version + child model itself | ✅ done (child-garment cache + saved child models) |
| 4 | Default saved models (boy/girl/mother…) so the same faces come back every time, no token waste on retries | ✅ done (strict role models) + CS4 (more presets: couple, বাবা-মেয়ে) |
| 5 | Model pose must CHANGE every run; background always fully Bangladeshi | ✅ done (scene pool) + CS4 (owner weighting) |
| 6 | His own shot 1–2 min videos: a separate section, auto-edited "After Effects level" | V1 + V2 + V3 |
| 7 | Video engine = hard steps inside the engine, **no LLM calls**, filters by video type (family matching shoot vs product shoot) | V1 (recipes) |
| 8 | Templates for video like image Finishing has (motion, price, logo) | V3 |
| 9 | Short generated videos (Veo reels) — better/longer than today's 4–8s | V4 |
| 10 | Agent does everything itself when asked in chat ("agent nijei shob bujhe kore felbe") | A1 |
| 11 | Business grows faster: content produced + posted on schedule with minimal owner effort | A2 |

If a future session finds a requirement here that no phase covers — STOP and flag it to the owner; do not silently drop it.

## 2. Where the work lives (current state — what's DONE)

- **UI:** `src/agent/components/creative-studio/CreativeStudio.tsx` (views: Studio Auto/Advanced · Gallery · Models · Finishing · Video[OpenCut iframe placeholder — replaced in V1]); page `/agent/creative-studio`.
- **Engine:** `src/lib/creative-studio/create-run.ts` (mode routing), `src/lib/tryon/` (art-director prompts, model library w/ roles father/mother/son/daughter, garment classify+cache), FASHN client `src/lib/fashn/`, worker `worker/src/index.mjs` + `worker/src/fashn/` + `worker/src/video-gen.mjs` (Veo 3.1).
- **Finishing (images):** deterministic brand frame (logo + code + hook + price; model_overlay / product_card / lifestyle w/ drag-resize editor) — the UX model V3 copies for video.
- **Gallery:** paginated, thumbs, branded variants, **Google Drive auto-archive** (`worker/src/schedulers/studio-archive.mjs`) — V1 must include videos in both.
- **✅ Family accuracy chain (PR #232, 2026-07-04):** `src/lib/tryon/family-chain.ts` + `scene-pool.ts`. One-tap family shots run as an assembly line: adult FASHN try-on → child-size garment (Gemini, **cached per product+role** in kv `tryon_child_garment:<role>:<path>`) → child FASHN try-on with the SAVED child model (same face every run) → Gemini merge into one BD scene. full_family = two sub-chains + once-only group merge (kv-guarded). Singles get FASHN → BD-background swap. Chain progress surfaces via `jobs/[id]` (ধাপ N/M). Tests: `src/lib/tryon/__tests__/family-chain.test.ts` (8 e2e simulations).
- **Why the chain exists:** suppliers send ONE adult product photo (child piece of matching sets has no photo); the old one-shot Gemini path never received the child model image (worker passes max 2 refs) so every run hallucinated a new child. Root-cause doc'd in PR #232.
- **Pending from owner:** save son + daughter models in the Models tab; live browser test of the chain (deferred, do together).

## 3. Remaining phases (do in this order)

### Phase V1 — Video ingest + deterministic Recipe Engine  ← NEXT
The owner shoots 1–2 min videos on his phone; the system cuts them into reels. **Zero LLM.**
- Video upload (mp4/mov/HEVC from iPhone, ~500 MB): signed upload URL direct to Supabase storage (bypass Vercel body limits), new `video_edit` job type on the worker.
- **Replace the OpenCut iframe** with a real Video section: uploaded-videos list + pick a **Recipe** — hard presets by video type, e.g. `family_shoot` (his family-matching shoots), `product_showcase`, `offer_promo` — each recipe = fixed cut lengths (15/30/60s outputs), transition style, crop rule, output aspect (9:16 default, 1:1/16:9 options).
- Worker pipeline (ffmpeg on VPS, free compute): transcode → scene-change detection (`scdet`) → recipe cut-plan (**pure function — unit-test it like the chain**) → 9:16 center-crop → outputs land in Gallery + Drive archive alongside images.
- Progress/status via the same pending-action tracker (ধাপ N/M style), retry on failure.
- Verification: cut-planner unit tests with fixture timestamps; one sample video end-to-end on the VPS.

### Phase V2 — Caption + audio layer (still deterministic)
- Whisper transcription (mechanical, allowed) → **Bangla captions burned in** (ASS subtitles, brand font/colour from BrandAsset).
- Music beds: owner uploads 5–10 approved tracks tagged by vibe; recipe picks one (round-robin/random — variety rule), audio ducking under speech. Islamic guardrail: owner-approved tracks only.
- Logo intro/outro stings: pre-rendered clips concatenated (ffmpeg concat), no per-run rendering.
- **Bangla TTS voiceover (optional per recipe):** owner types/approves the line; existing Google TTS (bn Chirp3-HD-Charon, already integrated for the agent) renders it; ffmpeg mixes over the music bed. Text comes from the owner or a fixed template — never LLM-written silently.

### Phase V3 — Motion templates ("After Effects" layer)
- **Remotion** renderer on the VPS worker (React-based video templates — fits the stack).
- Templates: price-tag pop-up, product-code lower-third, animated ALMA logo, end-card CTA, offer-countdown badge. Owner fills code/price at finishing time — the **video twin of the image Finishing tab** (same UX: pick template, type values, render).
- Each template is code: deterministic, reusable, unit-testable render props.

### Phase V4 — Generated-reel upgrades (Veo) — owner-initiated only
- **Longer generated reels:** multi-clip Veo 3.1 stitching (2–3 × 6–8s scenes from the same product, ffmpeg concat with recipe transitions) → 15–20s reels; per-scene scene-pool variety; cost shown before run (existing `estimateReelCostUsd`).
- **AI-assist toggle (OFF by default):** optional Gemini video-understanding pass that suggests highlight timestamps for V1's cut-planner on his shot videos — owner enables per run; the deterministic scdet path stays the default. (This is requirement #6's "Google Omni/better model" idea, gated behind the no-LLM rule.)

### Phase CS4 — Image polish + taste weighting (small, can ride along any phase)
- **New pair presets on the chain:** couple (husband+wife — two adults, no child-garment step), বাবা+মেয়ে (father_daughter). Trivial with the existing chain machinery.
- "আবার চালাও" (retry) button on a failed chain step (re-create that step's action, keep artifacts).
- Owner feedback on gallery items (ভালো/বাদ) → **deterministic weighting** of scene-pool entries (favour liked scenes/poses; still random, never LLM-scored); per-scene enable/disable sheet (kv `studio_scene_weights`).
- Child-garment cache management: view/regenerate a cached child garment from the gallery if a bad one ever gets cached.

### Phase A1 — Agent chat access + Brand Recipes
Only after image + video quality is proven to the owner.
- Head tool `run_creative_studio` (thin wrapper over `runCreativeStudio`/`startFamilyChain`/video recipes) so chat like *"ei panjabir baba-chele set banao"* or *"ei video ta offer reel banao"* works; self-verify via claim-verifier before replying (never claim success without the artifact).
- **Brand Recipe** store (kv, owner-tunable, no redeploy): preferred scenes subset, default model set, finishing theme, caption tone, music vibe — the agent picks the recipe, not its own taste.

### Phase A2 — One-tap Campaign packs (endgame)
- Campaign = images (family set) + reels + captions + posting schedule in ONE tap, reusing content-engine approval gates (`gate1/gate2`) — nothing auto-posts without the owner.
- Product auto-pick from ERP data (new arrivals / best-sellers) proposed as a weekly content calendar; owner approves the calendar, system executes it.
- Publishing: Facebook pages via existing direct Meta Graph API path; Instagram optional if the page's IG account is linked (same API family). WhatsApp status/catalog — optional later, existing `wa` lib.

## 4. Cost notes (owner is cost-sensitive)

- Family chain ≈ $0.50–0.70 per finished pair (2× FASHN + 1–2 Gemini), child garment cached after first run; far cheaper than repeated one-shot retries.
- V1/V2/V3 editing & rendering = ffmpeg/Remotion on VPS → ~zero marginal cost; Whisper pennies/min; TTS pennies/run.
- Veo reels (V4) stay owner-initiated with cost preview; AI-assist toggle costs shown before enabling.

## 5. Gotchas

- FASHN try-on keeps the **model photo's background** — that's why singles need the rescene step; never remove it thinking it's redundant.
- The merge step must reuse the SAME `SceneRef` as its inputs (one scene per chain) or lighting won't match.
- `getModelByRole` falls back to the default ADULT model when a role is missing — the chain deliberately bypasses that with strict `listModelsByRole` checks + `FamilyChainModelError`. Keep it strict.
- Native iOS app loads live production in WebViews — studio changes reach the app on web deploy (service-worker refresh caveat; see `docs/ios-native-frame-handoff.md` §6).
- Worker deploy is auto via `deploy-worker.yml` on main; pm2 app `alma-agent-worker`. ffmpeg + (V3) Remotion must be provisioned on the VPS — check before first video phase ships.
- iPhone videos are HEVC/HDR — always transcode to H.264/SDR first or captions/filters will shift colours.
