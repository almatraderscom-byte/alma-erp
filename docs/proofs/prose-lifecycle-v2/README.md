# Prose lifecycle v2 — evidence ledger (PR-A incident fix)

Incident: owner progress replies vanished at the next `tool_start` on iOS/web and
were filtered from cold history (handoff
`docs/handoffs/IOS_AGENT_REPLY_PERSISTENCE_DIAGNOSIS_HANDOFF_2026-08-22.md`,
F-01…F-04). Fix: negotiated typed prose lifecycle (protocol 2), ONE authoritative
settled block document (`usage.presentationV2`), canonical projection v2 (+ derived
v1 for legacy clients), non-destructive iOS/web reducers.

## Phase 0 — shared golden fixture (failing first)
- `src/agent/protocol/fixtures/prose-lifecycle-v2/golden-lead-progress-final.json`
  (iOS bundle copy: `ios/App/AppParityV2Tests/Fixtures/prose-lifecycle-v2-golden.json`,
  byte-identity guarded by `src/agent/protocol/__tests__/prose-lifecycle-fixture-drift.test.ts`).
- Checkpoints asserted per event for: server tracker, web reducer, GET projection v2,
  derived v1 projection, old-client down-projection, same-batch delivery, iOS reducer.

## Test results (recorded as they ran)

### 2026-08-23 — PR-A implementation
- `npx vitest run src/agent` → **646 files, 6710 tests passed** (incl. the new
  `prose-lifecycle.fixture.test.ts` 11, `prose-lifecycle.edge.test.ts` 18,
  `prose-timeline.test.ts` 3, `prose-lifecycle-fixture-drift.test.ts` 2; the
  `visible-progress` + `turn-events` expectations updated for the additive `stage`
  / `agentProseProtocol` fields).
- `npx tsc --noEmit` → clean. `eslint` on every changed file → 0 errors.
- iOS `xcodebuild test … -only-testing:AppParityV2Tests/ProseLifecycleV2Tests
  -only-testing:AppParityV2Tests/AssistantParityV2Tests` on iPhone 17 Pro Max (iOS 26.5)
  → **211 tests, 0 failures** (201 existing reducer/parity tests unchanged + 10 new:
  golden fixture step-wise, one-batch, in-app fixture parity, tool_start never clears
  v2 progress, legacy v1 wipe still intact, verifier hidden-replacement swap, cold
  `presentationV2` decode, snapshot protocol selection, typed wire decode, block-aware
  event buffer).
