# Phase 41 — Marketing baseline: capability matrix + measurement truth

Date: 2026-07-17 (Asia/Dhaka) · Branch: `claude/agent-roadmap-marketing-phases-161d84`
Status: read-only audit infrastructure shipped. No external platform was written to.

## What shipped

| Piece | Where |
|---|---|
| Capability audit (probe-proven statuses) | `src/agent/lib/marketing/capability-audit.ts` |
| Measurement health (funnel/data-gap assessment) | `src/agent/lib/marketing/measurement-health.ts` |
| Internal health endpoint | `GET /api/assistant/internal/marketing-health` (Bearer `AGENT_INTERNAL_TOKEN`, `requireAgentEnabled()` first) |
| Head tool | `marketing_capability_audit` in `src/agent/tools/marketing-tools.ts` |
| Tests | `src/agent/lib/__tests__/marketing-capability-audit.test.ts` |

## Capability matrix contract

Statuses: `read` / `draft` / `stage` / `write-confirmed` / `unsupported` / `broken` / `unknown`.

Hard rules encoded in `deriveStatus()` and enforced by tests:

- Env variable present ≠ green. Configured-but-unprobed = `unknown`; configured-but-probe-failed = `broken`.
- Only a successful live read-only probe grants `read` (or `stage` where an approval-carded write path already exists in code).
- `write-confirmed` can never be produced by this audit — it requires a real approved write verified end-to-end (later phases).

Probed assets (each with exact scope):

- Meta: both FB page tokens (`debug_token`), ad account (`act_*` read), pixel/dataset read, Instagram professional account link (via Lifestyle page).
- Google: GSC connection + property list, GA4 property + 7-day `runReport` probe.
- Website: HEAD probe on `WEBSITE_BASE_URL` / `NEXT_PUBLIC_WEBSITE_URL`.
- WhatsApp Cloud + GBP: env-checked only → honestly reported `unknown` (no safe probe wired in this phase), never green.

## Baseline funnel + unit-economics data dictionary

All money BDT whole-taka (`roundMoney`); timezone Asia/Dhaka.

| Field | Source | Trust |
|---|---|---|
| `erp.orders` | `getAgentOrdersSummary('week')` via `gatherMarketingReportData` | observed |
| `erp.delivered` | order byStatus delivered | observed / `null` = unknown |
| `erp.revenueBdt` | order summary revenue, whole taka | observed |
| `paid.spendBdt` | Meta insights via `fetchActiveCampaignMetrics` | observed when readable |
| `analytics.sessions` / `keyEvents` | GA4 `runReport` probe | observed when connected |
| CAC / LTV / ROAS | **not emitted** | never invented; requires Phase 43 event join |

Gap detectors (tested pure functions): thin sample (≥ max(3, days/2) needed), COD funnel break (orders>0, delivered=0 over ≥7d), missing analytics vs spend, missing spend vs orders, attribution uncertainty (no event-level join until Phase 43).

## Hard-coded Meta API version call sites (migration input for Phase 45)

`META_VERSION_CALL_SITES` in `capability-audit.ts` is the canonical list — 23 files hard-code `v21.0` today, including `src/agent/lib/meta.ts`, `meta-ads.ts`, `meta-audiences.ts`, `meta-instagram.ts`, `ads/insights.ts`, CS messenger libs, WA cloud API, and 10 worker scripts.

Migration plan (Phase 45, do not blind-bump):

1. Check the then-current supported versions from Meta's official changelog at implementation time.
2. Introduce one central `metaGraphBase()` (Phase 45 `meta-version.ts`), env-overridable, default = a version verified supported.
3. Move call sites to the central helper one file at a time with contract tests against fixtures.
4. Worker `.mjs` files get the same via a small shared constant (worker cannot import TS libs).

## Honest current-state notes

- Instagram publish path today is single-image only; Reels/video unsupported until Phase 46.
- No Pixel/CAPI dedup pipeline exists yet (Phase 43). Attribution is directional.
- WhatsApp/GBP marked `unknown` — proof requires probes not shipped in this phase.

## Proof status

Owner instruction for this branch: no Vercel deploys during the build; combined owner verification at the end. Chrome preview proof for the health matrix is therefore deferred to the final verification round — see `docs/proofs/agent-phase-41/README.md`. Local verification: vitest + full `tsc --noEmit` pass.
