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
- iOS re-run after the verification-row mirror (commit c6433252):
  `ProseLifecycleV2Tests` 10/10 (`xcodebuild-test-4.log`). Note for the rig: the
  simulator's Face ID *Enrolled* toggle makes the app-lock prompt block the XCTest
  host ("test runner hung before establishing connection") — keep it OFF for unit runs.

### 2026-08-23 — web E2E on the PR-A preview (owner logged in; Chrome `?native=1`)
Preview: `alma-erp-git-claude-ios-agent-reply-pe-4fee1e-maruf-s-projects2.vercel.app`,
conversation `21fc9c93-ad82-4418-9009-1ae391cee8cf`, prompt
"অর্ডার আর স্টক দুটোই চেক করে ছোট রিপোর্ট দাও" (DeepSeek V4 Flash head, 8 steps, 4m13s).
- LIVE: the opening line and the progress line "Boss, অর্ডার আর স্টক দুটোই চেক করছি — আগে
  pending orders ও sales দেখে নিচ্ছি।" stayed on screen across the following tool starts
  (execute_plan ×2, find_tool, get_orders…) — screenshots taken at 38s / 48s / 57s / 1m27s.
- DONE: settled message kept both progress lines + the verified final; the superseded draft
  (reason `rewrite`) hidden; "🔁 নিজে যাচাই করে ঠিক করেছে" badge shown.
- COLD (GET `/messages`, message `2cbbe6bc…`): `usage.presentationV2.blocks` =
  `[progress/committed, progress/committed, draft/superseded(rewrite), final/committed]`;
  `presentationV2.protocol = 2`, fingerprint `fc6c1d51`, prose = 2 progress + 1 final;
  derived v1 `presentation` prose states `[progress, progress, final]`. After a full page
  reload the same blocks render between the tool rows.
- Note: the first line was committed as `progress` (the model spoke it in the same round as
  its first tool call, so no `preamble` marker) — visually identical; old clients drop it
  exactly as before (no regression).
- Observed, NOT caused by this change (pre-existing plan/continuation path): after the turn,
  the server auto-continuation ran 12 hops in ~14 s (19:41:49–19:42:03), each
  "⚠️ Plan তৈরি হয়েছে, কিন্তু step tracker verify করা যায়নি…", then "hop limit reached".
  Flagged to the owner for a separate fix (30 s hop delay not honoured; `execute_plan`
  absent from the head's tool list).

### R-1 — identity (handoff F-12 / F-05) + combined iOS run on the stacked top
- `done.messageId` / `turn_snapshot.assistantMessageId` / turn-status `assistantMessageId`
  bind the streaming tail (`serverId`); the settle merge pairs by that exact id first,
  positional pairing is only the legacy fallback; a tool-only tail survives a poll
  (retained by content, not by `text` alone).
- iOS unit tests on the stacked top (R-1 ⊃ R-4 ⊃ R-3 ⊃ R-2 ⊃ PR-A), full `AppParityV2Tests`
  target, serial (`-parallel-testing-enabled NO`, `test-without-building`):
  **415 tests, 0 failures** (`xcodebuild-test-7.log`) — includes ProseLifecycleV2Tests 10,
  ProseRetentionTests 2, ProseIdentityTests 3 and the 400 pre-existing tests.
- Rig trap: with Xcode's parallel testing a second simulator ("ALMA Integration Verify")
  hosted the test app and died before XCTest connected ("Test crashed with signal kill
  before establishing connection"); run serially on the explicit device.

### 2026-08-23 — Codex review round (all five PRs), fixed on the stacked branches
- #834 P1 ×2 → 9c19bfa8 (v2 stream-error block; protocol stamp is part of negotiation).
- #836 P1 + P2 → fail-closed catch-up + contiguity check (tailer suite 12/12).
- #837 P1 → terminal counts only once durable; job rejects when none can be stored (worker 8/8).
- #838 P1 → compaction index map remaps the document anchors (presentation 57/57).
- #839 P1 + P2 → no positional fallback for a tail that knows its id; identity adopted in
  every terminal polling path. iOS full `AppParityV2Tests` on the stacked top (serial, second
  simulator): **416 tests, 0 failures** (`xcodebuild-test-8.log`).

### 2026-08-23 — Codex round 2, fixed on the stacked branches
- #834 P1 → 58edc767: the negotiated protocol is stamped when the turn ROW is created (every creation
  path), so a durable tail / turn-status never sees an unstamped v2 turn.
- #836 P1 → 487182b0: the pre-replay live subscription is bounded by a deadline (unreachable Redis
  must not hold back the durable replay and the polling fallback).
- #837 P1 → 19b20470 + 2a38a550: a missing durable terminal is repaired — inline publisher
  (`finish()` writes a repair row) and worker (`repairMissingTerminal`); fixture exhausts the
  8-attempt terminal budget.
- #838 P1 + P2 → 076a4418: a terminal-only replay (`error: turn_replay_unavailable`, or a log holding
  only `done`) settles the frozen partial instead of blanking it; prose whose anchors were dropped by
  compaction keeps DOCUMENT order (rides with the next anchored block).
- #839: no new findings.

### 2026-08-23 — Codex round 3 (six P1), fixed on the stacked branches
- #834 P1 → 0bd2d658 `ProseLifecycleTracker.salvage(text, { suffix })`: the error-salvage document
  carries the persisted failure/continue warning (own `final` block; a replaced salvage text retires
  the streamed blocks, reason `salvage`; a tool-only turn gets the warning as its only prose).
  presentation suite on PR-A: 55/55.
- #836 P1 → d9adf87c: the subscribe deadline timer is cleared once the race settles — the round-2
  deadline had flipped `subscribeTimedOut` AFTER a successful subscribe and frozen every tail 1.5 s
  in. tailer suite 14/14 (new: live events delivered well past the deadline).
- #837 P1 ×3 → 3d7519a0: a lost terminal enqueues a `repair-terminal` BullMQ job (attempts 10,
  backoff, deterministic id) carrying the REAL `done`/`error`; `repairMissingTerminal()` returns an
  outcome, PUBLISHES the repaired row on the turn channel (subscribed tails never poll), and a failed
  repair fails the delivery / the repair job. worker durability 15/15; whole worker suite 150/150.
- #839 P1 → `applyTerminalStatusIdentity(_:matchedOurTurn:)`: an assistant id is adopted only from a
  terminal status positively matched to our turn; the unmatched fallback settles without it.
  iOS full `AppParityV2Tests` on the stacked top (serial, fresh device "ALMA Codex Tests"):
  **418 tests, 0 failures** (`xcodebuild-test-12.log`). tsc clean; targeted vitest (presentation, tailer, turn-events, turn-status, publisher, fixture drift, visible-progress) 11 files / 101 tests green.
- Rig: "ALMA Integration Verify" (946F7780) killed the test host even serially; a freshly created
  iPhone 17 Pro Max device ran the same build fine — keep a dedicated clean test device.

### 2026-08-23 — Codex round 4 (seven P1), fixed on the stacked branches
- #834 P1 ×2 → 81928aba: `salvage()` now QUEUES the supersede/start/commit events and
  `drainQueued()` hands them out — the chat route emits them before the terminal `error`, the
  runner yields them on the deadline path — so the live reducers land on the transcript a reload
  shows; the deadline-abort salvage (gate replacement / lane settlement blocker) goes through the
  tracker for v2, so the persisted document carries the blocker. presentation suite 57/57 (new:
  live reducer == document after salvage; v1 queues nothing).
- #836 P1 → 87f74e46: the tailer hands the subscribe attempt an `AbortSignal` and aborts it when
  the deadline wins; `subscribeTurnEvents` disconnects the client on abort (no infinite reconnect
  loop per stream during a Redis outage). tailer suite 15/15 (hung attempt aborted; a won race
  never aborted).
- #837 P1 ×2 → e5da6648: a repaired terminal counts only once PUBLISHED (bounded in-process publish
  retries; an unpublished repair reports `failed` so the job retries, and `already_terminal`
  republishes the existing terminal — tails dedupe by seq); a terminal is found with
  `in('type', ['done','error'])`, not "last row", so `done` + `conversation_compacted` is no longer
  mis-repaired. worker durability 18/18; whole worker suite 153/153.
- #838 P1 → 0ca2ae8c: the native-loop act-now retry appends `{ t: 'verify' }` to the timeline
  (cold history keeps the row like the steering/verifier retries).
- #839 P1 → the status-polling path decides adoption with
  `isTerminalForOurTurn(requireEvidence: true)` through `applyTerminalStatusIdentity` — a
  concurrent turn's terminal settles the UI but never lends its assistant id. Unit test
  `testPollingMatchRequiresTurnIdOrSendTimeEvidence` (debug seams for currentTurnId / the match).
  iOS full `AppParityV2Tests` on the stacked top (fresh device "ALMA Codex Tests"):
  **419 tests, 0 failures** (`xcodebuild-test-13.log`). tsc clean; targeted vitest 12 files / 124 tests.
- Full `src/agent` vitest on the stacked top: 6726 pass, 17 fail in 6 files (vision/simulate tool
  routing, tool-search deferral, dynamic toolset, behaviour-parity, style-gate) — the SAME files
  fail on a clean `origin/main` checkout (10/40 in those files), i.e. pre-existing, environment
  dependent, untouched by this stack.
