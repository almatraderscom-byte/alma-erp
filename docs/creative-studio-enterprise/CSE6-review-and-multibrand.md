# Phase CSE6 — Review, Approval, and Multi-brand

## Goal

Add the minimum enterprise collaboration layer suitable for ALMA's real team.

## Deliverables

- Studio roles: Owner, Creator, Reviewer.
- Creator can draft; Reviewer can comment/request changes; only Owner can approve publish-ready state or spend above the configured threshold.
- Asset comments and immutable state transition/audit events.
- Brand profiles for ALMA Lifestyle, ALMA Trading, and CDIT with isolated recipes/assets.
- Existing owner-only behavior remains the default until roles are explicitly assigned.
- No SSO/SCIM or public sharing.

## Exact file allowlist

- `docs/creative-studio-enterprise/CSE6-review-and-multibrand.md`
- `prisma/schema.prisma`
- `prisma/migrations/20260724210000_creative_review_multibrand/migration.sql`
- `src/agent/components/creative-studio/CreativeStudioShell.tsx`
- `src/agent/components/creative-studio/ProjectLibraryView.tsx`
- `src/agent/components/creative-studio/ReviewPanel.tsx`
- `src/agent/components/creative-studio/BrandSwitcher.tsx`
- `src/agent/components/creative-studio/StudioRoleSettings.tsx`
- `src/agent/components/creative-studio/studio-api.ts`
- `src/app/api/assistant/creative-studio/reviews/route.ts`
- `src/app/api/assistant/creative-studio/assets/[id]/state/route.ts`
- `src/app/api/assistant/creative-studio/brands/route.ts`
- `src/app/api/assistant/creative-studio/roles/route.ts`
- `src/lib/creative-studio/studio-access.ts`
- `src/lib/creative-studio/review-workflow.ts`
- `src/lib/creative-studio/__tests__/studio-access.test.ts`
- `src/lib/creative-studio/__tests__/review-workflow.test.ts`

## Acceptance gates

- Role matrix is enforced server-side, not only hidden in UI.
- Direct API tests prove cross-brand and unauthorized state changes fail.
- Draft → changes requested → revised → approved history is immutable and visible.
- Tests, typecheck, build, Preview, and Chrome proof pass.

## Cost ceiling

`$0`.

