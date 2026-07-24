# Phase CSE7 — Distribution, Performance, and Final Hardening

## Goal

Close the loop from approved asset to measured business result and certify the full program.

## Deliverables

- Owner-approved Meta schedule/publish flow using the existing direct Graph API path.
- Dry-run preview, idempotent publish key, retry safety, and visible delivery receipt.
- Pull reach/engagement/ad metrics into asset/campaign attribution.
- Deterministic winner feedback updates recipe/scene weights; no autonomous creative judgment.
- Storage retention after verified Drive archive, with safe defaults and owner control.
- End-to-end browser/API/queue/data tests for the critical Studio journeys.
- Load test Gallery/project queries and queue admission; document thresholds.
- Observability for queue age, worker heartbeat, provider error rate, spend, QC rate, archive lag, and publish failures.
- Recovery runbook and final certification matrix.

## Exact file allowlist

- `docs/creative-studio-enterprise/CSE7-distribution-and-hardening.md`
- `docs/creative-studio-enterprise-final-certification.md`
- `prisma/schema.prisma`
- `prisma/migrations/20260724220000_creative_distribution_attribution/migration.sql`
- `src/agent/components/creative-studio/ProjectLibraryView.tsx`
- `src/agent/components/creative-studio/PublishPanel.tsx`
- `src/agent/components/creative-studio/PerformanceView.tsx`
- `src/agent/components/creative-studio/StudioSettingsView.tsx`
- `src/agent/components/creative-studio/studio-api.ts`
- `src/app/api/assistant/creative-studio/publish/route.ts`
- `src/app/api/assistant/creative-studio/performance/route.ts`
- `src/app/api/assistant/creative-studio/retention/route.ts`
- `src/lib/creative-studio/publish-service.ts`
- `src/lib/creative-studio/performance-attribution.ts`
- `src/lib/creative-studio/retention-policy.ts`
- `src/lib/creative-studio/__tests__/publish-service.test.ts`
- `src/lib/creative-studio/__tests__/performance-attribution.test.ts`
- `src/lib/creative-studio/__tests__/retention-policy.test.ts`
- `worker/src/schedulers/studio-archive.mjs`
- `worker/src/schedulers/creative-performance.mjs`
- `worker/src/index.mjs`
- `worker/src/__tests__/studio-archive-retention.test.mjs`
- `scripts/creative-studio-e2e.mjs`
- `scripts/creative-studio-load-test.mjs`

## Acceptance gates

- Publish dry-run and one controlled live receipt prove idempotency; no duplicate post on retry.
- Performance metrics map back to the exact campaign pack and asset version.
- Retention never deletes an original until Drive archive verification is durable.
- Full targeted tests, typecheck, build, load thresholds, Vercel Preview, and Chrome end-to-end proof pass.
- Final certification lists every phase, migration, cost, receipt, known limitation, and rollback.

## Cost ceiling

`$1`; live Meta publishing requires the owner's explicit in-phase confirmation.

