# Phase CSE4 — Deterministic Campaign Packs

## Goal

Turn one product and one locked recipe into a complete, cost-controlled campaign pack.

## Deliverables

- Preview manifest before queueing: outputs, engines, stages, estimated time, and hard cost ceiling.
- Default ALMA pack: 4:5 hero, 1:1 post, 9:16 story/reel cover, optional family version, Bangla caption draft, and optional 6-second reel.
- Reuse one approved master where possible; crops/frames/captions are local/free.
- Two preview drafts for selection before expensive video.
- Stage-addressable durable jobs and lineage; rerun only a failed/rejected stage.
- Idempotent pack creation and restart-safe progress.

## Exact file allowlist

- `docs/creative-studio-enterprise/CSE4-campaign-packs.md`
- `src/agent/components/creative-studio/StudioWorkspaceView.tsx`
- `src/agent/components/creative-studio/CampaignPackPanel.tsx`
- `src/agent/components/creative-studio/CampaignPackProgress.tsx`
- `src/agent/components/creative-studio/studio-api.ts`
- `src/app/api/assistant/creative-studio/campaign-packs/route.ts`
- `src/app/api/assistant/creative-studio/campaign-packs/[id]/route.ts`
- `src/app/api/assistant/creative-studio/campaign-packs/[id]/retry/route.ts`
- `src/app/api/assistant/internal/job-result/route.ts`
- `src/app/api/assistant/internal/pending-jobs/route.ts`
- `src/lib/creative-studio/campaign-pack.ts`
- `src/lib/creative-studio/campaign-pack-service.ts`
- `src/lib/creative-studio/__tests__/campaign-pack.test.ts`
- `src/lib/creative-studio/__tests__/campaign-pack-resume.test.ts`
- `worker/src/campaign-pack.mjs`
- `worker/src/index.mjs`
- `worker/src/__tests__/campaign-pack.test.mjs`

No schema change is allowed unless CSE3's stored lineage proves insufficient; if so, stop and revise this prompt before coding.

## Acceptance gates

- Preview total is shown before queueing and the hard cap is enforced server-side.
- Repeated submit with the same idempotency key creates one pack.
- Worker restart resumes without repeating completed paid stages.
- Rejecting one output reruns only its owning stage.
- Preview/browser proof uses an existing product; total paid spend stays at or below `$1`.

## Cost ceiling

`$1`, with owner-visible confirmation before the first paid call.

