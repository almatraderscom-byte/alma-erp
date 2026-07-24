# Phase CSE1 — Trust and Reliability

## Goal

Make the current Studio truthful and safe to operate before adding new creation features.

## Required root-cause checks before code

1. Reproduce Gallery's first-page-only behavior and trace both client and API pagination.
2. Confirm why the health UI reports `Worker সাড়া নেই`: stale/absent heartbeat, wrong key, wrong threshold, or actual outage. Recent completed jobs alone are not proof of current health.
3. Trace how provider/API failures become raw JSON or `429` text in tiles/toasts.
4. Trace every action available on a QC-failed preview and define the server-side publishability rule.
5. Trace Audio Lab's estimate and queue order; no job may be queued before owner confirmation.

## Deliverables

- Server-side Gallery query with stable cursor/page semantics, accurate `hasMore`, bounded limits, and filters for media type, state, QC, product code/text, and test artifacts.
- Gallery UI search, filters, loading skeleton, empty state, load-more, and a visible result count.
- Separate states: `Draft`, `QC failed`, `Ready`. QC-failed artifacts remain viewable/downloadable for diagnosis but cannot be finished, turned into a reel, or marked publish-ready.
- Friendly Bangla provider/error mapping. Raw JSON and internal stack/provider payloads never render to the owner.
- Audio and other paid actions show estimate and explicit confirm **before** queue insertion. A configurable per-run hard cap blocks accidental spend.
- Worker health reports `সচল`, `দেরি`, `অফলাইন`, or `অজানা`, includes last-seen time, and never labels an unknown heartbeat as a confirmed outage.
- Production/e2e sample artifacts are hidden by default with an explicit “টেস্ট দেখুন” filter.
- Regression tests for Gallery query/filter semantics, QC action guard, error mapping, cost-confirm ordering, and health-state classification.

## Exact file allowlist

- `docs/creative-studio-enterprise-roadmap.md`
- `docs/creative-studio-enterprise/CSE1-trust-and-reliability.md`
- `src/agent/components/creative-studio/CreativeStudio.tsx`
- `src/agent/components/creative-studio/studio-api.ts`
- `src/app/api/assistant/creative-studio/audio/route.ts`
- `src/app/api/assistant/creative-studio/finish/route.ts`
- `src/app/api/assistant/creative-studio/gallery/route.ts`
- `src/app/api/assistant/creative-studio/health/route.ts`
- `src/app/api/assistant/creative-studio/run/route.ts`
- `src/app/api/assistant/creative-studio/video/finish/route.ts`
- `src/app/api/assistant/creative-studio/video/run/route.ts`
- `src/lib/creative-studio/gallery-query.ts`
- `src/lib/creative-studio/studio-errors.ts`
- `src/lib/creative-studio/studio-health.ts`
- `src/lib/creative-studio/studio-policy.ts`
- `src/lib/creative-studio/__tests__/gallery-query.test.ts`
- `src/lib/creative-studio/__tests__/studio-errors.test.ts`
- `src/lib/creative-studio/__tests__/studio-health.test.ts`
- `src/lib/creative-studio/__tests__/studio-policy.test.ts`
- `worker/src/heartbeat.mjs` (only if diagnosis proves the producer is wrong)
- `worker/src/index.mjs` (only if diagnosis proves heartbeat wiring is wrong)
- `worker/src/__tests__/heartbeat.test.mjs` (only with a worker heartbeat change)

No schema migration is allowed in CSE1.

## Diagnosis record (2026-07-24)

- The API's earlier in-memory truncation is already fixed on current `main`, but the Web Gallery still always requests page 1 and discards pagination metadata.
- Non-video provider errors pass from `result.error` to the tile; only the video-specific path is sanitized.
- UI actions and finishing/reel server routes check execution state, not explicit QC failure.
- Audio Lab inserts an approved job before returning the cost displayed by the toast.
- Studio health reads the turn-consumer KV heartbeat instead of the canonical `agent_heartbeats.queue-consumer` heartbeat posted by the worker.
- Test/e2e artifacts are not excluded by the Gallery query.

## Acceptance gates

- Page 2+ assets are reachable without duplicates or gaps.
- Search/filter results are server-filtered and totals are truthful.
- QC-failed asset publish/finish/reel calls return a guarded Bangla error even if the UI is bypassed.
- Audio queue count does not change before confirmation.
- A simulated stale heartbeat and a truly missing heartbeat render different states.
- Targeted tests, `npm run type-check`, and `npm run build` pass.
- Vercel Preview is exercised in owner Chrome and screenshot proof covers Gallery, QC guard, cost confirm, and health state.

## Cost ceiling

`$0`. Use existing assets and fixture/error simulations. Do not trigger a paid generation.
