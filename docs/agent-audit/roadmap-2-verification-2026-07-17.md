# Roadmap 2 (Phases 41–48) — live end-to-end verification record

Date: 2026-07-17 · Verifier: Claude (owner-directed merge → deploy → self-verify)
Production: https://alma-erp-six.vercel.app · main @ `6e93f187`

## Deploy path (what actually happened)

- Branch merged to main (fast-forward, branch was a strict superset).
- GitHub outage delayed webhooks; additionally the Mac Mini's git config had no
  `user.email`, so session commits carried `marufbillah@Marufs-Mac-mini.local`
  which **Vercel blocks** ("commit author email is not valid"). Fixed by setting
  repo-level `user.email=almatraders.com@gmail.com` and pushing `6e93f187`.
- Webhook backlog cleared → production deployment Ready; new route answered
  401 (auth required) instead of 404 = deployed. Migrations applied on deploy
  (control-room queries over the three new tables succeeded).

## Live verification (owner's Chrome, production agent chat)

| Check | Phase | Result |
|---|---|---|
| `growth_control_room` | 48 | ✅ Ran on prod; real joined snapshot: GA4 connected (225 sessions/30d), growth brief absent, 0 experiments, CAPI unconfigured (0 events), 3 stale calendar drafts, ৳11 spend/30d, honest per-section states |
| Measurement health gaps | 41/43 | ✅ Live output shows `thin_sample (medium)`, `funnel_break (medium)`, `attribution_uncertain (low)` + delivered-COD-truth-missing — exactly the tested detectors on real data |
| `marketing_capability_audit` | 41 | ✅ 10 checks: 5 proven, **1 broken (IG)**, 4 unsupported — probe-proven matrix with an honest broken state (exit-gate requirement) |
| `utm_build` | 43 | ✅ `utm_source=meta&utm_medium=paid_social&utm_campaign=alma_cod_orders_202607` — convention exact |
| `plan_marketing` without approved brief | 42 | ✅ **Blocked** — "growth brief ছাড়া চলে না" (the planning gate live) |
| Calendar health (stale drafts) | 44 | ✅ 3 stale drafts surfaced with approve/reschedule/cancel advice |
| Internal route auth | 41 | ✅ `/api/assistant/internal/marketing-health` → 401 without bearer (requireAgentEnabled + token gate) |

## Context note (important for using the new tools)

Marketing/growth tools are business-scoped: in the **ব্যক্তিগত (personal)** chat
context the marketing tool group is not loaded (pre-existing tool-group scoping —
`plan_marketing` is equally invisible there). Use the **ALMA Lifestyle** context;
everything resolves there. `growth_control_room`/`browser_diagnose` ride the
live-browser group and are visible more broadly.

## Not exercised live (needs assets/time, by design)

- CAPI test event (`marketing_capi_test_event`) — needs META_PIXEL_ID + an Events
  Manager test code; tool refuses to run without the test code (verified in unit tests).
- Paused campaign staging — needs META_ADS_TOKEN spend intent; validation/idempotency
  covered by unit tests; creation stays approval-carded.
- IG publish — capability audit honestly reports the IG link **broken** on prod today.
