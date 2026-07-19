# Phase 63 — Activate the marketing operating system

Branch: `agent-phase-63` (stacked) · Tag: `pre-agent-phase-63`
Goal: turn the marketing tool collection into a weekly owner-approved loop.

**Reality of this phase:** most of Phase 63 is *onboarding* that structurally requires the owner — real facts, an approved brief, production secrets, and a Meta-UI relink. Claude cannot self-complete or honestly verify those. So this phase delivers the one large, fully-verifiable code win now (GAP-11) and hands the owner an exact onboarding checklist for the rest, rather than shipping unverifiable scaffolds into a live worker.

## Delivered + fully verified — GAP-11: Meta Graph version centralization

The root cause the audit missed: the version resolver already existed but lived under `src/agent/lib/marketing/`, and the **one-way dependency rule forbids ERP (`src/lib/*`, `src/app/*`) from importing `src/agent`** — so those files *had* to hard-code the version. Fixed by moving the canonical resolver to the ERP-shared layer.

- **`src/lib/meta-version.ts` (new)** — canonical resolver (`metaGraphVersion`, `metaGraphBase`, `classifyMetaError`), imports nothing from `src/agent`.
- **`src/agent/lib/marketing/meta-version.ts`** — now re-exports it (all 4 existing agent importers + the existing test keep working unchanged).
- **`worker/src/meta-version.mjs` (new)** — worker mirror (same default; workers can't import TS).
- **All 30 literals across 20 files migrated** to `metaGraphBase()` — agent libs, CS/WA messaging, ads, financial-intelligence, weekly-strategic, fb-token-health route, and 8 worker `.mjs` files. **Zero literals remain.**
- Default preserved at `v21.0` (no blind-bump); `META_GRAPH_VERSION` env pins a version repo-wide without edits.

**Verification (Claude's end):**
- `tsc --noEmit` = 0 errors; `node --check` passes on all 9 worker `.mjs`.
- Full agent suite **182 files / 2310 tests PASS**; existing `meta-version.test.ts` green via re-export.
- New parity test locks **worker default === TS default** and that `metaGraphBase()` still returns exactly `https://graph.facebook.com/v21.0` by default (behaviour-preserving — no live URL changed).
- Behaviour-preserving by construction: the migration only replaces a literal with a resolver whose default is that same literal.

## Owner-gated activation (cannot be done or verified by Claude) — the onboarding checklist

These are the real Phase 63 loop items. Each needs an owner action Claude is forbidden from doing (entering secrets, approving, Meta-UI permission changes):

1. **Growth Brief** — Claude runs the capability/measurement audit and drafts a versioned brief, but the owner must supply the missing facts (focus products, real margin/COGS boundary, stock, target customer, objective, budget ceiling, offer rules, forbidden claims) and **explicitly approve the exact version**. Until then `plan_marketing` correctly stays blocked and the content engine correctly skips.
2. **Meta Pixel / CAPI secrets** — owner provides `META_PIXEL_ID` / `META_DATASET_ID` / `META_CAPI_TOKEN` (production, outside Git). Only then can a test event be sent + deduped, and only then is a worker event producer worth wiring (it would no-op without them). *Not scaffolded blindly into the live worker scheduler — that would be untestable code in production.*
3. **Instagram Professional link** — repaired through the owner's Meta UI; Claude never enters password/MFA or changes account permissions.
4. **3 experiments** — depend on the approved brief; created once (1) lands.

The production-truth panel (Phase 61) already shows each of these as `off`/`unknown` with the exact blocker, so progress is visible.

## Definition-of-Done status (honest)

| Item | Level reached | Blocker |
|---|---|---|
| GAP-11 version centralization | 1–3 ✅ (self-verified); 4–5 ⏳ owner deploy | — |
| Growth Brief | 0 | owner facts + approval |
| CAPI producer | 0 | owner Pixel/dataset + token |
| Instagram | 0 | owner Meta-UI relink |
| Experiments | 0 | blocked on the brief |

`Implemented` is not reported as `Live`. No secret, spend, post, or message effect was performed.
