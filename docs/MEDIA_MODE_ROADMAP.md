# Media Mode — CapCut-class AI Video Engine (Roadmap of Record)

Owner ask (2026-08-14): a new **Media (video & audio)** mode inside the agent section that
works like CapCut's AI agent — share an idea (any idea, not just products), the agent
returns a **Video Plan** with model choices and the **exact cost**, the owner approves,
and the agent then generates every asset itself (ElevenLabs audio, images, short video
clips), shows each one in chat as it lands, and finally stitches all the short clips
into one big final video. Reference: owner's screen recording of CapCut AI
(analyzed frame-by-frame 2026-08-14).

## 0. What CapCut does (from the recording — the parity bar)

1. Chat input "Tell me your idea" + photo attach + template picker.
2. Agent replies with a **Video Plan card**: title, `36s | 9:16 | seedance_1.0_fast | en-US`,
   direction tags, narration preview — and **"156 credits needed" BEFORE anything runs**.
3. Plan is conversationally revisable pre-approve: swap model (`seedance_2.5`), change
   language to Bangla, "use my photos in every scene", realism level. Each revision
   **re-quotes** ("Credits returned" → "3390 credits needed").
4. Approve → staged generation, everything visible in chat:
   - **Audio results (15)** — one TTS mp3 per scene (`s01_tts_v1.mp3`), each with
     play / 👍 / 👎 / regenerate / download.
   - **Images one at a time** with a live `Loading… 42%` placeholder, per-image
     regenerate, owner's face composited into every scene.
   - Mid-run pivots honored: owner disliked the Bangla TTS → agent dropped voiceover,
     switched to a music bed, re-quoted, kept going.
5. Full-screen asset viewer: Save / Use in chat / Adjust, thumbnail strip.
6. Final: short clips stitched into the full video.

## 1. What we already have (reuse map — verified in code)

| Need | Existing code |
|---|---|
| Chat cards + SSE | `src/agent/components/AgentThread.tsx` (confirm/ask/model-switch/artifact cards), `agent-event.schema.json` |
| Approval + cost + revise-in-place | `AgentPendingAction` (costEstimate), `actions/[id]/approve|revise`, `AgentConfirmCard.tsx`, `revise-pending.ts` |
| Image gen | `image_gen` job — Nano Banana 2/Pro (`image-action-contract.ts`), Seedream 5.0 Pro via fal (`worker/src/index.mjs`), Grok Imagine |
| TTS | **ElevenLabs fully wired**: `worker/src/tts-elevenlabs.mjs` (eleven_v3, Bangla prep, chunking), cloned owner voice (`elevenlabs-voices.mjs`), Google Chirp3 fallback |
| Music / SFX | `audio_gen` job → `worker/src/audio-lab.mjs` (music, wish_song, owner_voice, sfx) |
| Video clips | `video_gen` job → `worker/src/video-gen.mjs` (Veo 3.1, operation-resume via kv) |
| Multi-clip assembly | `veo-chain.ts` (clip N queues clip N+1, last queues `veoConcat`) |
| Stitch/captions/finish | `worker/src/video-edit.mjs` (ffmpeg xfade/concat/tonemap), `video-captions-overlay.mjs` (Bangla-safe PNG strips), Remotion `FinishOverlay.jsx` |
| Durable multi-step runs | `worker/src/agent-task-runner.mjs` — `workflow_runs` lease + per-node checkpoint + exactly-once effects |
| Job dispatch Vercel→VPS | pending-jobs poll + `job-result` → `job-delivery.ts` (asset lands back in the conversation) |
| Cost | `src/agent/lib/pricing.ts` (+ worker mirror `cost-log.mjs`), `agent_cost_events`, spend buckets image/video/voice |
| Storage | Supabase bucket `agent-files` |

**Genuinely new work:** (a) scene-graph planner + MediaPlan contract, (b) Media plan
card + per-scene asset feed in chat, (c) media render graph orchestrating the existing
jobs with per-asset regenerate, (d) Seedance video via fal (image model fal path already
exists), (e) iOS native mirror (later phase).

## 2. UX flow (web first, agent section)

**Entry — "Media" mode.** Composer "+" menu / mode strip gets a **Media** chip
(pattern: pinned-skill chip in `AgentComposer.tsx`, SK-3). Pinning Media pins the media
toolset + system module; the conversation becomes a media project thread. Also a
dedicated `/agent/media` page listing past projects (like Creative Studio gallery).

**Step 1 — Idea intake.** Owner types/voices any idea in Bangla, optionally attaches
photos (himself, products, references). Head asks at most 1-2 clarifying questions
(duration, platform) ONLY if genuinely ambiguous — CapCut asks almost nothing.

**Step 2 — Video Plan card (the heart).** One `media_plan` pending-action card:

```
🎬 [টাইটেল]                          মোট সময়: 36s | 9:16 | বাংলা
দৃশ্য: 6টি  |  ভিডিও মডেল: Seedance 1.0 Pro (fal)  |  ছবি: Nano Banana Pro
ভয়েস: ElevenLabs v3 (Boss ক্লোন) / মিউজিক: ElevenLabs Music
── প্রতি দৃশ্য: থাম্ব-লাইন (S1…S6): এক লাইনের বর্ণনা + VO স্ক্রিপ্ট preview
── খরচ (exact):
   ছবি 6 × $0.134            = $0.80
   ক্লিপ 6 × 6s Seedance Pro = $4.47
   ভয়েস ~450 chars           = $0.05
   মিউজিক 36s                = $0.20
   স্টিচ+ক্যাপশন (VPS)       = $0.00
   ─────────────────────────────
   মোট ≈ $5.52 (৳675)        [Approve] [আমার মত] [বাতিল]
```

- Every number from `pricing.ts` — no guesses. BDT shown next to USD (kv-set rate).
- **"আমার মত" (revise)** re-plans in place and **re-quotes** — `media_plan` joins
  `revise-pending.ts`. Model swaps (e.g. Veo↔Seedance, voice→music-only) are revisions.
- Approve = the ONLY money gate. Everything after runs without more prompts, but each
  asset stays individually regenerable (regenerates re-check remaining budget).

**Step 3 — Generation feed (CapCut-style, in chat).** The media graph emits SSE
progress + delivers each asset as it completes:

1. **Script & narration lock** (head, already paid — token cost inside plan).
2. **Audio first** (cheap, fast): per-scene VO `s01_vo_v1.mp3` … or music bed —
   each an audio card with play/regenerate/download.
3. **Images next**: per-scene keyframe `s01_img_v1` with live progress %, owner's
   photos composited where the plan says so (existing face/try-on machinery).
4. **Clips**: per-scene image→video (Seedance/Veo) `s01_clip_v1.mp4` — delivered as
   they finish; long videos are always built as short 5-8s scene clips (CapCut same).
5. **Stitch**: ffmpeg concat + xfade + VO/music mix + Bangla captions + finish overlay
   → **final video card** with download/share.

Every asset card: 👍 / 🔁 regenerate (with why-note → prompt tweak) / ⬇️. Regenerate
bumps `v2`, re-runs ONLY that node, and the stitch node waits for the latest versions.

**Step 4 — Review loop.** After final delivery: "কোন দৃশ্য বদলাবো?" — owner says
"S3 আবার বানাও আরো realistic" → single-node re-render → cheap re-stitch (re-stitch is
VPS-only, free). Mid-run pivots (drop VO, music-only) = plan revision + re-quote,
already-made assets are kept, only the delta is billed.

## 3. Data model (additive migration, existing migration system)

```
agent_media_projects   id, conversationId, ownerId, title, status(draft|planned|
                       approved|rendering|review|final|failed|cancelled),
                       planJson (MediaPlan), planRevision, aspect, language,
                       totalEstimateUsd, totalActualUsd, finalAssetPath, timestamps
agent_media_scenes     id, projectId, idx, brief, voScript, imagePrompt, clipBrief,
                       durationSec, status
agent_media_assets     id, projectId, sceneId?, kind(vo|music|sfx|image|clip|stitch|final),
                       version, status(queued|rendering|ready|failed|superseded),
                       jobId, storagePath, mimeType, durationSec?, costUsd,
                       modelId, meta jsonb
```

`workflow_runs` (existing) holds the render graph state; asset rows are the
user-visible ledger the UI reads (project page + chat cards both read these).

## 4. MediaPlan contract (planner output, versioned)

```jsonc
{
  "version": 1,
  "title": "…", "aspect": "9:16", "language": "bn",
  "durationSec": 36,
  "audio": { "mode": "vo|music|vo+music", "voice": "elevenlabs:<voiceId>|owner_clone|google:bn-IN-Chirp3-HD-Charon", "musicBrief": "…" },
  "models": { "image": "gemini-3-pro-image|seedream-5.0-pro|xai_imagine", "video": "seedance-1.0-pro|seedance-1.0-lite|veo-3.1-fast|veo-3.1" },
  "personalization": { "useOwnerPhotos": true, "photoAssetIds": [...] },
  "scenes": [ { "idx": 1, "durationSec": 6, "brief": "…", "voScript": "…", "imagePrompt": "…", "clipBrief": "…", "usesOwnerPhoto": true } ],
  "captions": true,
  "estimate": { "lines": [{"label":"ছবি 6×Nano Banana Pro","usd":0.80}, …], "totalUsd": 5.52, "totalBdt": 675 }
}
```

Head (Gemini 3.1 Pro) produces this via a `plan_media_video` tool; a pure TS
`estimateMediaPlanCost(plan)` recomputes the estimate server-side (never trust the
LLM's arithmetic) and stamps it on the card. Bangla-facing text passes
`bangla-output-gate.ts`. Islamic guardrails enforced at planner level (no haram
subjects/imagery) — reuse existing constitution module.

## 5. Model matrix (owner-swappable per plan, kv-defaulted)

| Asset | Default | Alternatives | Exact price source |
|---|---|---|---|
| Image | Nano Banana Pro ($0.134/img) | Nano Banana 2, Seedream 5.0 Pro (fal), Grok Imagine | `pricing.ts` (exists) |
| Clip | **Seedance 1.0 Pro via fal** (~$0.62/5s 1080p — verify exact fal rate at M2) | Seedance Lite (cheap), Veo 3.1 Fast $0.15/s, Veo 3.1 | new entries |
| VO | ElevenLabs v3 $0.10/1k chars (owner clone supported) | Google Chirp3 (cheap fallback) | `pricing.ts` (exists) |
| Music | ElevenLabs Music (via audio-lab) | none | exists |
| Planner | head (Gemini 3.1 Pro) | — | token pricing exists |

New video providers follow the `provider-registry.ts` convention: kv feature flag +
env presence + kill switch (`cs_engine_kill:` pattern), pricing entry in `pricing.ts`
AND `worker/src/cost-log.mjs` mirror.

## 6. Render engine

- **One registered graph** `media_render` in `agent-task-runner.mjs` (durable,
  checkpointed, exactly-once): nodes = `vo[i] → img[i] → clip[i]` per scene (audio
  batch fans out first, images next, clips last — matches CapCut's visible order and
  fails cheap-first), then `stitch → captions → finish → deliver`.
- Each node enqueues an existing job type (`audio_gen`/`image_gen`/`video_gen`/
  `video_edit`/`video_finish`) and records an `agent_media_assets` row; `job-result`
  hook advances the graph and delivers the asset card to the conversation.
- **Regenerate** = new asset version node, graph-safe; stitch always consumes the
  newest `ready` version per scene.
- **Budget guard**: graph aborts if actual spend exceeds estimate × 1.25 (kv-tunable),
  and a `media_daily_cap_usd` kv guard (opus-gate pattern) refuses new plans past the
  daily cap. Every provider call logs to `agent_cost_events` with
  `projectId` dedupKeys; project page shows estimate vs actual.
- Vercel never renders: everything >30s runs on the VPS worker (hard rule).

## 7. Phases

**M0 — Foundation (this branch):** migration (3 tables), MediaPlan schema + zod,
`estimateMediaPlanCost` + pricing entries (Seedance fal video, ElevenLabs music line),
`plan_media_video` head tool + `media_plan` pending-action type + card render (web),
revise support, `/agent/media` project list page skeleton. Tool wired into head prompt
+ skill manifest (owner rule: unwired tool = invisible).
**M1 — Render engine:** `media_render` graph + asset rows + per-asset chat delivery +
progress SSE + regenerate single asset + budget guard. Audio+image scenes end-to-end
(clips still Veo-only).
**M2 — Seedance + stitch:** Seedance via fal in `video-gen.mjs` (provider branch +
flag + pricing verified against fal), full stitch (concat/xfade + VO/music mix +
Bangla captions + finish), final delivery, review-loop single-scene re-render.
**M3 — Polish:** template quick-starts, asset viewer page, project gallery, mid-run
pivot revisions, cost dashboard bucket `media`.
**M4 — iOS native mirror:** new card cases in `AssistantSwiftUI.swift` + native media
project screen (sim-verified, one TestFlight batch, owner gate).

Each phase: own branch, tests, Chrome-MCP proof on Vercel preview before "done".

## 8. Hard-rule compliance

- No ERP files touched; all code in `src/agent/`, `src/app/agent/`,
  `src/app/api/assistant/`, `src/lib/creative-studio/` (agent-owned), `worker/src/`.
- No `/api/agent/*`; kill switch `AGENT_ENABLED` respected; additive migrations only.
- Voice-call audio tuning files untouched (this feature is nowhere near SIP playout).
- Money display: `roundMoney` for BDT; USD kept at cents precision internally.
