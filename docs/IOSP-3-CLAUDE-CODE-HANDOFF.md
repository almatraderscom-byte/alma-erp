# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-3 only

Copy into a fresh session. Authorizes **IOSP-3 only** (one roadmap phase per session). IOSP-0/1/2 complete — see `docs/IOSP-{0,1,2}-*.md`.

---

You are taking over at **IOSP-3 — Shared data/cache and view-lifetime foundation**.

## Required reading (completely, first)

1. `CLAUDE.md` (highest authority)
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md` §8 Phase IOSP-3, §7 gates, §10 perf framework, §12 safety
3. `docs/IOSP-0-BASELINE-REPORT.md` §7 (request/idle baselines to beat) + `docs/IOSP-2-PHASE-REPORT.md`
4. `ios/App/App/AlmaAPI.swift` (the shared API client — where single-flight/TTL lands), representative screen VMs (`DashboardSwiftUI.swift`, `OrdersSwiftUI.swift`), image usage (`AsyncImage` sites)

## Authorization

IOSP-3 only. End with a phase report + IOSP-4 handoff, then stop. No TestFlight (programme policy: technical checkpoint after IOSP-4, final after IOSP-9).

## IOSP-3 goal and work (roadmap §8)

Stop avoidable reloads without changing business-data semantics:
- request single-flight/dedup (coalesce concurrent identical GETs);
- conservative per-resource TTL / stale-while-revalidate;
- preserve root + high-frequency pushed view models; retain previous content during refresh (no blank flash);
- image memory/disk cache + safe prefetch;
- centralize loading/error/empty-state presentation;
- **never** cache sensitive mutations or approval decisions as if confirmed; preserve whole-taka money rules and auth boundaries.

## Exit criteria

Repeated warm navigation doesn't refetch unchanged data; concurrent identical GETs coalesce; mutation success invalidates only the right resources; stale/offline content is visibly labelled and never mistaken for fresh approval state; measured request-count + route-to-content improvement vs the IOSP-0 baseline (116 reqs/5-min idle; note most of that is the 3s intercom poll → that specific poll is IOSP-4, so measure the *navigation* refetch reduction here, not the idle poll).

## Verification (build success is NOT proof)

Extend the existing DEBUG env-gated self-test harness in `AppDelegate.swift` (`ALMA_NAV_SELFTEST` pattern) to exercise repeated warm navigations and concurrent GETs; prove coalescing + no-refetch via `com.almatraders.erp.perf` `api.request` signposts (count before/after) captured with `log show --signpost`; screenshot content retained during refresh. Use the clean Pro Max sim `9E51818A-…` (re-enroll Face ID after reboot: `notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` + `-p …enrollmentChanged`, match `-p com.apple.BiometricKit_Sim.pearl.match`). **Never** touch the other session's iPhone 17 Pro `5F79315F-…`; print the destination UDID before every simctl/xcodebuild. Owner rule: Claude doesn't hand-drive the sim UI — use the harness + signposts + timed screenshots; tap-only checks → Bangla owner checklist.

## Safety and branch rules

- Live production ERP. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free numeric pair — verify first (expect **agent-phase-20** + `pre-agent-phase-20`).
- Never touch `/api/agent/*` or its auth; no financial semantics; whole-taka rules intact; no secrets; additive migrations only (none expected).
- Do not merge/deploy/TestFlight. If any web/API file changes, Vercel preview + owner-Chrome proof is mandatory (IOSP-3 may need none).

## Deliverables

Files changed; cache/single-flight design; before/after request-count table; proof paths; PASS/FAIL vs exit criteria; branch/commit; risks; IOSP-4-only handoff. Stop after IOSP-3.

---
