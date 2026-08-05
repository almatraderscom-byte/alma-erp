# Phase CSE3 — ALMA Content OS

## Goal

Organize creation around business projects, products, brands, reusable recipes, and traceable assets.

## Deliverables

- Additive Project, Project Asset, Asset Version/Lineage, Brand Profile, Brand Recipe, and Asset Tag records.
- Project switcher and project-scoped asset library with folders/tags.
- Read-only ERP product picker that fills product code, name, price, and available source image without editing ERP records.
- Owner-locked Brand Recipes: scene subset, model roles, finish theme, caption tone, aspect pack, music vibe, QC level, and spend ceiling.
- Every new asset records source asset(s), recipe version, provider/engine, job, cost, QC, and created-by.
- Existing unassigned assets remain visible under a safe “Legacy” collection.

## Exact file allowlist

- `docs/creative-studio-enterprise/CSE3-content-os.md`
- `prisma/schema.prisma`
- `prisma/migrations/20260724190000_creative_content_os/migration.sql`
- `src/agent/components/creative-studio/CreativeStudioShell.tsx`
- `src/agent/components/creative-studio/ProjectBar.tsx`
- `src/agent/components/creative-studio/ProjectLibraryView.tsx`
- `src/agent/components/creative-studio/ProductPicker.tsx`
- `src/agent/components/creative-studio/BrandRecipeEditor.tsx`
- `src/agent/components/creative-studio/studio-api.ts`
- `src/app/api/assistant/creative-studio/projects/route.ts`
- `src/app/api/assistant/creative-studio/projects/[id]/route.ts`
- `src/app/api/assistant/creative-studio/projects/[id]/assets/route.ts`
- `src/app/api/assistant/creative-studio/products/route.ts`
- `src/app/api/assistant/creative-studio/recipes/route.ts`
- `src/app/api/assistant/creative-studio/recipes/[id]/route.ts`
- `src/lib/creative-studio/project-contract.ts`
- `src/lib/creative-studio/project-service.ts`
- `src/lib/creative-studio/brand-recipe.ts`
- `src/lib/creative-studio/__tests__/project-contract.test.ts`
- `src/lib/creative-studio/__tests__/brand-recipe.test.ts`

## Acceptance gates

- Additive migration applies cleanly and leaves existing Studio data intact.
- Owner can create a project, pick an ERP product, lock a recipe, tag an existing/new asset, and inspect lineage/version history.
- Another user's project cannot be read or mutated by direct API calls.
- Targeted tests, typecheck, build, Preview, and Chrome proof pass.

## Cost ceiling

`$0`.

