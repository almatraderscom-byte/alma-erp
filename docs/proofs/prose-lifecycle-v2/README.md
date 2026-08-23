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
- PR-A: https://github.com/almatraderscom-byte/alma-erp/pull/834 (branch
  `claude/ios-agent-reply-persistence-f7ca82`, base `main` @ 21df2bf0).

### 2026-08-23 — simulator proof (native reducer, iPhone 17 Pro Max / iOS 26.5)
`sim-prose-v2-golden-settled.png`: the app launched with `ALMA_PROSE_V2_FIXTURE=1`
replays the golden v2 transcript through the LIVE reducer (not a hand-built block
list). Visible after settlement: lead → "আগে স্টক দেখছি… (২ গুদাম)" (progress, after
tool A started twice) → tool cluster → "এ পর্যন্ত ২টা ধাপ সফল…" (forced update) →
verified final; the superseded draft "কাজ শেষ, সব ঠিক আছে Boss!" is gone;
"🔁 নিজে যাচাই করে ঠিক করেছে" badge present; 15 tokens footer from `done`.

### R-2 — replay ordering + gap repair (handoff F-08; F-09 server half)
- `src/agent/lib/turn-stream-tailer.ts`: subscribe FIRST, buffer live events during
  replay, drain through the deduper, then serial live apply with gap healing from the
  durable log (`gap_detected` / `replay_catchup` / `gap_unhealed` logs). A replay read
  failure ends the stream with `turn_replay_unavailable` instead of a mid-turn live-only tail.
- `src/agent/lib/__tests__/turn-stream-tailer.test.ts`: 9 tests — race-window event
  delivered once; gap healed before the later event; unhealable gap logged + continues;
  overlap dedupe; terminal-in-replay; replay failure; page cap; no-channel poll/settled;
  cursor resume. vitest green, tsc clean.

### R-3 — durability fail-closed (handoff F-09 / F-10 / F-11)
- Inline publisher (`turn-events.ts`): durable append retried (50/200/600 ms); an event
  that cannot be stored is neither published nor counted in `lastSeq`
  (`durabilityHoles()`); `getReplayEvents` opt-in `throwOnError` for the stream route.
- Worker (`run-streamed-turn.mjs`): PostgREST `{ error }` treated as failure (retried);
  `agent_turns.last_seq` bumped after every durable append (duplicate `/turn` requests
  no longer mistake a healthy worker for a dead one; replay paging knows the tail);
  a BullMQ retry resumes seq from the durable max; an upstream stream ending without
  a terminal is reported as `error: turn_stream_ended_without_terminal` — no synthetic
  `done` without a durable assistant message.
- Tests: `turn-event-publisher.test.ts` (+2: transient retry, permanent hole) 8/8;
  new `worker/src/__tests__/streamed-turn-durability.test.mjs` 6/6 (`node --test`);
  `vitest run src/agent/lib/__tests__ src/app/api/assistant` 257 files / 2367 tests green.
