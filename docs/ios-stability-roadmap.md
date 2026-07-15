# ALMA ERP — Native iOS Agent Stability, Streaming & Scroll Roadmap

**Audience:** Claude Code / senior iOS + backend engineer  
**Repository:** `https://github.com/almatraderscom-byte/alma-erp`  
**Audited commit:** `cb48cecb229e469d3c623e072e27fda6d831efa1`  
**Audit date:** 2026-07-14 (Asia/Dhaka)  
**Primary native file:** `ios/App/App/AssistantSwiftUI.swift`  
**Model constraint:** Keep Grok 4.20 as the head model. This roadmap is an architecture/client reliability change, not a model change.

---

## PROGRESS TRACKER (Claude updates this after every phase)

**STATUS: ROADMAP COMPLETE — final sim hard-check PASSED 2026-07-14. TestFlight build gated on the OWNER's explicit confirmation (his rule).**

**Working branch:** `claude/alma-ios-stability-roadmap-f74eca`
**Deep-audit against repo:** DONE 2026-07-14 at `d94c199c` (2 commits after the audited `cb48cecb`; both touched agent cost badge/LISTEN mode only — every roadmap claim still holds). Verification details in the Audit Annex at the bottom of this file.

| Phase | Scope | Status |
|---|---|---|
| Phase 0 | Instrumentation: signposts, debug row overlays, stress fixture | ✅ DONE 2026-07-14 |
| Phase 1 (PR 1) | Recovery hotfix: transport classification, lifecycle observers, immediate foreground recovery, visible resume tail, ID-map hygiene | ✅ DONE 2026-07-14 (sim-verified e2e) |
| Phase 1.4 (PR 2) | Scroll/layout gap fix + single scroll-debounce task | ✅ DONE 2026-07-14 (100-round scroll stress clean) |
| Phase 2 (PR 3) | Event parity + robust SSE parser + buffered reducer | ✅ DONE 2026-07-14 (split → PR 3b) |
| Phase 3 (PR 4) | Idempotent durable turn backend (Prisma migration, command endpoint, durable events for inline, replay cursor, richer status) | ✅ DONE 2026-07-14 |
| Phase 3 native (PR 5) | Native migration to canonical durable turn + recovery descriptor | ✅ DONE 2026-07-14 (kill/relaunch e2e proven) |
| PR 3b | Monolith extraction (transport layer), renderer fast-path, 30fps clocks, native model-switch card | ✅ DONE 2026-07-14 |
| Phase 4 (PR 6) | Pagination, delta sync, poll pause, metrics, tests, CI gates | ✅ DONE 2026-07-14 |

### Phase 0 + 1 completion notes (2026-07-14)

- **Phase 0 shipped:** `AlmaTurnLog` os_signposts (`turn.submit/firstEvent/transportDisconnected/foreground/reconnectStarted/terminal/messagesReconciled/background`, `message.rowHeightChanged`); `ALMA_DEBUG_ROWS=1` per-row overlay (id/role/height/blocks/live + height-change signpost); `ALMA_ASSISTANT_FIXTURE=1` stress fixture (40 mixed rows, 2,000+ char interleaved reply, 1,000-delta live tail through the real mutation helpers). `stream.bufferFlush` lands with the Phase-2 event buffer (no buffer exists yet).
- **Phase 1 shipped:** `TurnFailureKind` classifier (all user-facing errors now Bangla); transport interruption freezes the partial tail, sets `reconnecting`, shows "কাজ চলছে — সংযোগ ফিরছে…" glyph/text-only and hands off to recovery — never a raw toast; `UIApplication` background/foreground/didBecomeActive observers (registered once, token-boxed deinit cleanup; also fixed the pre-existing duplicate auth-observer registration); `recoverTurnState()` single-flight immediate status fetch with 1s→3s backoff+jitter, visible `ensureStreamingTail()` on resume (P0-C), our-turn-vs-stale-turn heuristic via `lastSendAt`/`startedAt` (Phase 3 replaces with clientMessageId), bounded no-turn proof → Bangla failure without losing the optimistic user row; empty placeholder tails removed / partial-tail blocks cleared on terminal reconcile (1.5); `localIdByServerId` cleared on `openConversation()`/`newChat()` (P1-E).
- **Sim e2e proof:** send → background (Settings) mid-turn 10s → foreground: no English toast, live activity + token/step counter visible ~1.5s after return, turn streamed on and settled with cost badge. Fixture + debug overlay verified. Prod head model pill read "Auto · Grok 4.20" — roadmap model note confirmed live.
- **Deferred bits:** selectable-text-view count in overlay (blocks count is the proxy). Observation for Phase 2: the STREAMING blocks view showed a repeated prose line around a deadline-continue turn (persisted view rendered clean) — investigate during reducer work.

### Phase 1.4 / PR 2 completion notes (2026-07-14)

- **Root cause identified (code-level):** `AlmaSelectableRichText.sizeThatFits` returned `nil` for nil-width proposals. LazyVStack issues nil-width estimation passes as rows enter/leave the viewport; the `nil` fell back to UIKit intrinsic sizing of a 0pt-wide `UITextView` → one-word-per-line layout → a viewport-sized phantom height cached by the lazy layout for that row = the giant gap.
- **Fix set shipped:**
  - `sizeThatFits` now answers EVERY proposal: real widths are cached (content-hash × rounded-width × Dynamic Type category, 64-entry bound), nil-width passes reuse the last real layout width (first-ever pass measures at screen−32); `widthTracksTextView`, vertical hugging/compression `.required`, `invalidateIntrinsicContentSize()` on content change.
  - Long-answer collapse cap `? 340 : .infinity` → `? 340 : nil` (no greedy `.infinity` inside the lazy list; the two remaining `.infinity` sites are the side drawer + activity sheet, outside the chat list).
  - `messages.count` autoscroll now respects `nearBottom` (server merges/polls never yank the owner off older content); the owner's OWN send scrolls via a dedicated `ownSendTick` signal.
  - `scheduleScrollToBottom` = ONE stored cancelable debounce task (old generation-counter fan-out removed).
  - `mergeServerMessages` applies in a `Transaction(disablesAnimations:)` — reconciliation height changes never animate mid-scroll.
- **Sim verification:** `ALMA_ASSISTANT_SCROLLTEST=1` — 100 top↔bottom round-trips during + after the 1,000-delta fixture stream with `ALMA_DEBUG_ROWS` overlays: no blank gap in any screenshot; signpost audit over the full run shows **zero rows with <200 chars reserving >400 pt** (no phantom heights); tail heights strictly proportional to content (h=3117@5044ch → h=4154@6056ch settle); real prod conversation re-checked clean after (bubble hugging intact).
- **Residual:** the original gap was device-reported; owner's next TestFlight device pass is the final confirmation. Debug overlays (`ALMA_DEBUG_ROWS=1`) remain available if it ever reappears.

### Phase 2 / PR 3 completion notes (2026-07-14)

- **2.1 Typed contract:** `AgentTurnEvent` Swift enum (19 cases + `.unknown` with `stream.unknownEvent` telemetry) mirrors `core.ts` + route envelope events; wire DTO extended with every missing field; machine-readable schema at `src/agent/protocol/agent-event.schema.json` (documents the three-place update rule).
- **2.2 Robust SSE parser:** `AlmaSSEParser` — byte-level line split, `data:` with/without space, CRLF+LF, multi-line data joined per spec, `:` comment keepalives, `id:`/`retry:`/`event:` fields accepted, trailing event without final blank line, malformed JSON → `stream.malformedEvent` telemetry without killing the stream. Voice console kept per-event delivery (TTS latency) on the same parser via a DTO-callback variant.
- **2.3 `AgentEventBuffer` actor:** decode runs off-main; adjacent text/thinking deltas coalesce ~40ms (25 applies/s ceiling); control events flush pending deltas first (exact chronology); `stream.bufferFlush` metrics. `refreshPhases` now runs ONCE per flush instead of once per token (P1-A fixed).
- **Event parity shipped (P0-E closed):** `personal_mode` (stored), `subagent_start/end` (native "সহকারী: <role>" activity rows), `verification_retry` (web parity: draft cleared + "নিজের উত্তর যাচাই করে ঠিক করে নিচ্ছি (n/m)…"), `model_switch_required` (truthful Bangla notice; native approval card = tracked follow-up), `conversation_compacted` (follows new conversation id), `done` usage → live tokens/cost on the tail + `needContinue` → bounded auto-continue (8, resets on manual send, web-parity text), `tool_end.screenshot` (noted in row preview; inline image = follow-up), confirm/ask-card dedupe guards for replay-safety.
- **Sim verification:** EVENTTEST canned wire (CRLF + no-space data + keepalives + multi-line + unknown + trailing done) rendered subagent row, tool row, prose, mid-turn ask card and live cost badge on screen; `stream.unknownEvent: future_event_xyz` telemetried, stream survived. Real prod turn through the new buffered pipeline streamed and settled cleanly (thinking/tool rows + answer + cost badge).
- **Deferred to PR 3b:** monolith split (2.5), full 2.4 renderer work (markdown parse now capped at flush cadence ≤25/s — the 8–10/s throttle + settle-only full parse + single shimmer clock remain), native model-switch approval card, tool-screenshot inline rendering, blocks-vs-prose duplicate investigation.

### Phase 3 / PR 4 completion notes (2026-07-14)

- **3.1 Migration** `20260914120000_agent_turn_idempotency` (additive; IF NOT EXISTS): `client_message_id`, `user_message_id`, `assistant_message_id`, `last_seq` (default −1), `execution_mode`, `updated_at` + unique `(conversation_id, client_message_id)` + key index. Auto-applies on the next Vercel build via migrate-on-deploy.
- **3.2 Idempotency:** `findOrCreateTurnByClientMessageId` (DB-constraint-backed, race returns the winner); `/chat` gates on the key BEFORE conversation creation/message persist (fresh-chat retry can't orphan a conversation) and returns `202 {duplicate:true, …snapshot}` instead of re-executing; `/turn` accepts new conversations + key with the same duplicate semantics. Legacy bodies unchanged.
- **3.3 Execution handoff:** `/turn` re-dispatches a DEAD direct run (running, `lastSeq<0`, >15s) to the worker — old turn cancelled and the idempotency key MOVES to the replacement turn in one transaction. Deviation from the roadmap's same-turnId ideal: same-row handoff can't be made race-free with the polled `cancelRequested` flag (two executors could interleave on one row); key-transfer preserves every invariant the client sees (key → one live execution). Client resubmission of the prompt is gone either way.
- **3.4 Durable inline events:** `createTurnEventPublisher` — durable row first, Redis publish second, `lastSeq` bump third (worker's order); serialized write chain off the SSE hot loop; text/thinking deltas coalesced (350ms / 2000 chars); wired into `/chat` SSE via `emit()` (envelope + turn + compacted + error events). Worker path untouched (it mirrors itself). Worker duplicate user-message fixed via `turn.userMessageId` guard on internal calls; `linkTurnUserMessage`/`linkTurnAssistantMessage` set exact message linkage.
- **3.5 Replay:** stream route takes `?afterSeq=` / `Last-Event-ID` (frames now carry `id: <seq>`), emits a `turn_snapshot` hello, page-caps at 5000 with `replay_continue`, `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no`.
- **3.6 Status:** turn-status returns `lastSeq`, `updatedAt`, `assistantMessageId`, `executionMode`.
- **Tests:** publisher coalescing/chronology/oversize-flush/lastSeq + cursor deduper + fail-open replay (`turn-event-publisher.test.ts`); full agent-lib suite 268/268 green; `tsc --noEmit` clean.
- **Note:** the web/native clients don't send `clientMessageId` yet — that's PR 5 (native migration). Until then the new paths are dormant-but-live: inline turns already write durable events and richer status.

### Phase 3 native / PR 5 completion notes (2026-07-14)

- **clientMessageId end-to-end:** every native send generates a UUID key (ChatBody + /turn TurnBody). Prod-verified: turn row carries the app's UUID, 1 turn + 1 user message per key.
- **Resend race gone (P0-D closed):** the 15s watchdog fallback no longer re-POSTs the prompt as a new job — it asks /turn (idempotent) for THE turn and tails its durable stream; /chat's 202 duplicate-snapshot answer (`AssistantNet.DuplicateTurn`) is caught and observed, never re-executed.
- **Durable-tail recovery:** `recoverTurnState` now attaches `/turn/:id/stream` (full replay + live) instead of blind status-polling — the missed activity timeline (thinking/tools/cards/prose) REPLAYS and continues live; status polling remains the fallback. Full replays rebuild the tail authoritatively (wipe fires on the stream's `turn_snapshot` hello, so a failed attach keeps the frozen partial). `turn_snapshot`/`replay_continue` handled; `id:<seq>` cursor tracked (SeqBox) and stamped into the descriptor on background.
- **RecoverableTurn descriptor (roadmap 4.3):** persisted to UserDefaults on turn_id, cleared only on terminal reconcile/explicit cancel; `bootstrap()` follows it after relaunch — even into a different conversation than the active-pointer.
- **Sim e2e proof (prod backend):** (1) normal send → DB row `client_message_id=230E72B6…`, inline, linked; (2) **KILL mid-turn → relaunch** → full activity timeline replayed + turn continued live (~১২৬ টোকেন counter) → settled with cost badge; DB: `turns_for_key=1`, `user_msgs_in_conv=1`, `last_seq=15`, assistant linked. Fresh-conversation recovery included (test ran on a new chat).
- **Note:** a parallel session's turns (other code paths) show `execution_mode=null` — expected; only turns through the updated routes carry the new fields.

### PR 3b + Phase 4 / PR 6 completion notes (2026-07-14)

**PR 3b:**
- First monolith extraction (2.5): `AssistantTransport.swift` — diagnostics, failure classifier, wire DTO, typed `AgentTurnEvent`, `AlmaSSEParser`, `AgentEventBuffer`, `AssistantNet` (493 lines); registered in pbxproj; remaining view/VM split continues in later passes (each must compile alone).
- 2.4 remainder: markdown segmentation fast-path for fence/table-free streaming prose; ALL shimmer/spinner `TimelineView(.animation)` clocks bounded to 30fps (LOCKED visuals unchanged).
- Native `model_switch_required` approval card (`AgentModelSwitchCardView`) + `ChatBody.resume{}` — the paused turn resumes on premium/fallback from the phone (was a "go to web" toast).
- Blocks-dup verdict: wire-level repetition from the agent's deadline wrap-up; client faithful, persisted view clean → server-behavior item for the Grok roadmap program. `tool_end.screenshot` inline image deferred (needs signed-URL fetch design); event captured + row-noted since PR 3.

**Phase 4 / PR 6:**
- 4.1 backend: `?limit` (latest-N), `?before` (older page), `?since` (delta poll) on the messages route via pure `buildMessagesPagePlan` (unit-tested, capped 200, legacy default untouched).
- 4.1 native: initial load = latest 50; "আরও পুরনো মেসেজ" button prepends pages (non-animated, anchor restored, dedupe-guarded against un-upgraded servers); quiet poll = `since` delta (empty ≈ free) with a full-window true-up every 5th tick; merge preserves the paginated prefix; cursors reset per conversation.
- 4.2: polling pauses while backgrounded (foreground observer already syncs immediately on return).
- 4.3: `turn.foregroundRecoveryMs` latency metric + `sync.deltaNew`/`sync.olderPage` signposts (contents never logged).
- 4.4: protocol-layer assertions runnable on-screen via `ALMA_ASSISTANT_UNITTEST=1` (parser matrix, event mapping, classifier, buffer chronology) — an XCTest target needs shared-pbxproj surgery best done in Xcode, flagged as owner follow-up; backend suite 274/274 green.
- 4.5: `ios-simulator.yml` now triggers on PRs touching `ios/**`, the protocol schema, turn plumbing, or the Prisma schema (path-scoped — unrelated PRs never bill a Mac runner).

### FINAL HARD-CHECK on the complete build (2026-07-14, PRs #351/#353/#355 all merged, backend live on prod)

| # | Check | Result |
|---|---|---|
| 1 | Protocol unit assertions (`ALMA_ASSISTANT_UNITTEST=1`) — parser matrix, event mapping, classifier, buffer chronology | ✅ 14/14 on-screen |
| 2 | Canned-wire event test (subagent rows, multi-line data, unknown-event telemetry, ask card, live cost) | ✅ |
| 3 | 100-round scroll stress over 1,000-delta fixture + row-height audit | ✅ zero phantom heights, stressDone |
| 4 | Real prod turn (new pipeline) — stream, settle, cost badge; DB row carries app's clientMessageId, inline, linked | ✅ |
| 5 | Background mid-turn → foreground — no English toast, live state, settle | ✅ |
| 6 | KILL mid-turn → relaunch — descriptor recovery, timeline replayed, settled | ✅ |
| 7 | Pagination on a REAL 81-message thread — window reconciles `count=50` (not 81), "আরও পুরনো মেসেজ" at top, delta poll quiet at idle | ✅ |
| 8 | Idempotency global audit — keys with >1 turn in prod | ✅ 0 |
| 9 | Old long conversation renders (cards resolved, no gaps) | ✅ |

Definition-of-done items still OWNER-side: real-device TestFlight pass (one batched build — awaiting owner confirmation), real push/Face ID/keyboard feel. Remaining engineering follow-ups (non-blocking): XCTest target via Xcode, continued view/VM extraction, tool-screenshot inline image, web client adopting clientMessageId.

---

## 0. Claude Code: read this first

The owner is seeing two production-device failures:

1. While scrolling the native iOS chat, a very large unexplained vertical blank gap can appear between turns. Content below the gap still exists.
2. A server-side agent turn correctly continues after the app is backgrounded, but when the owner reopens the app the native UI shows `The network connection was lost.`, displays no useful running state for several seconds, and only shows the final answer roughly 15–20 seconds later.

Do not treat these as cosmetic-only bugs. They come from four coupled architectural problems:

- unstable dynamic row measurement/reconciliation in the SwiftUI message list;
- every SSE delta mutating large observable value types on `MainActor`;
- no explicit foreground/background turn recovery state machine;
- two competing execution paths (`/api/assistant/chat` and fallback `/api/assistant/turn`) instead of one idempotent durable turn.

Implement this roadmap in small, testable PRs. Do not rewrite everything in one PR. Phase 1 is a production hotfix; Phases 2–4 are the permanent architecture.

### Locked product requirements

- Grok 4.20 remains the head model.
- A turn must continue server-side when the app backgrounds, suspends, loses network, or is killed.
- Returning to the app must never show a raw transport error if the server turn is still running.
- Returning to the app must immediately show a useful state such as `কাজ চলছে — সংযোগ ফিরছে…`; never a blank wait.
- Never execute the same owner message twice because of reconnect, retry, timeout, or worker handoff.
- Preserve the current ALMA aura and native design language.
- No full glass card around normal assistant turns.
- Shimmer must remain glyph/text-only. Never add a shimmering background.
- Do not remove approval/ask cards, tool rows, selectable text, copy, listen, cost, or activity details.

---

## 1. Evidence from the supplied device screenshots

### Screenshot A — giant scroll gap

Observed:

- A settled assistant footer is visible near the top.
- The next visible owner message/activity content is far below it.
- Approximately a viewport-sized empty region is reserved between real rows.
- The gap is not the intended 18–26 pt message spacing.
- The composer and floating controls remain attached, so this is message-content layout/scroll state, not the whole screen failing to render.

Likely code paths:

- `ScrollView` + `LazyVStack` in `AssistantScreen`.
- dynamic `AgentMessageRow` height.
- UIKit-backed `AlmaSelectableRichText` (`UIViewRepresentable` wrapping a non-scrolling `UITextView`).
- `AgentTurnBlocksView`, which can create multiple separately measured selectable prose views inside one message row.
- server reconciliation replacing message values while preserving local row IDs.

### Screenshot B — background return error

Observed:

- The owner sends a new turn.
- On return, native UI shows the raw English toast `The network connection was lost.`
- The final answer later appears without the owner resending the task.

This proves the server-side continuation works. The failure is native transport interpretation and recovery UX:

- the direct URLSession SSE connection is dropped/suspended;
- `runTurn` catches it as a generic failure and assigns `errorToast`;
- the server continues and persists the assistant reply;
- the native UI later discovers it through the 12-second message poll / 3-second turn-status loop;
- therefore the user sees an error, a dead interval, and then a delayed success.

The app-wide `ConnectivityBeacon` does not solve this. A background-suspended SSE connection can fail while `NWPathMonitor` reports a valid network path. Transport recovery must live in the assistant turn state machine.

---

## 2. Current architecture map

### 2.1 Native iOS

`ios/App/App/AssistantSwiftUI.swift` currently contains, in one ~6,100-line file:

- wire DTOs and SSE event DTO;
- URLSession streaming and multipart network code;
- the `@MainActor @Observable AssistantVM`;
- send, fallback, stop, resume and polling logic;
- message merge/reconciliation;
- Markdown parsing;
- UIKit selectable rich text;
- all message/activity/card rendering;
- scroll tracking and composer;
- sidebar, memory, artifacts, plan drive, voice/dictation and TTS integration.

This makes state transitions hard to prove and makes UI regressions easy to introduce while fixing unrelated behavior.

### 2.2 Direct turn path

1. Native optimistically appends `local-*` user and `stream-*` assistant rows.
2. Native POSTs `/api/assistant/chat` and waits for SSE.
3. A 15-second first-event watchdog cancels the client request if no event was seen.
4. Native may POST the same task to `/api/assistant/turn` as a worker fallback.
5. Direct server execution deliberately continues after client disconnect.
6. Direct events are not written to `agent_turn_events`; only worker turns have durable replay.

### 2.3 Worker turn path

- `/api/assistant/turn` creates an `AgentTurn`, enqueues BullMQ work, and returns `turnId`.
- Worker calls `/api/assistant/chat?stream=true` internally.
- Worker stores sequenced events in `agent_turn_events` and publishes Redis events.
- `/api/assistant/turn/:id/stream` replays stored events and tails Redis.

This path has the right replay concept, but it is only the fallback path. The client cannot rely on it for every turn.

### 2.4 Recovery today

- `bootstrap()` calls `resumeRunningTurnIfAny()` only on screen bootstrap/conversation open.
- `AssistantSwiftUI.swift` has no assistant-specific `willEnterForeground` / `didBecomeActive` observer.
- A resumed turn polls status every 3 seconds but does not create/restore a streaming assistant tail.
- Quiet polling runs every 12 seconds and reloads the complete message history.
- A dropped direct stream has no `lastSeq`, replay cursor, or immediate reconnect route.

---

## 3. Root-cause findings

### P0-A — Expected disconnect is surfaced as a failure

Current behavior in `AssistantVM.runTurn`:

- only `CancellationError` and auth errors are treated specially;
- `URLError.networkConnectionLost`, `URLError.cancelled`, `notConnectedToInternet`, `timedOut`, and background suspension land in the generic catch;
- generic catch sets the raw localized string in `errorToast`.

If `currentTurnId` exists, these errors usually mean **the UI transport disconnected**, not that the agent turn failed. The server route explicitly keeps the turn alive.

### P0-B — No immediate foreground recovery

The native assistant does not observe foreground/active lifecycle changes. Therefore it waits for whichever timer wakes first. On the current code this is often the 12-second poll plus fetch/render time, matching the reported 15–20-second delay.

### P0-C — Resume path has no visible tail

`resumeRunningTurnIfAny()` sets `isStreaming = true` and `thinkingLive = true` but does not call `ensureStreamingTail()`. The UI's working indicator is attached to a streaming message row. A running turn can therefore have no row on which to display progress, producing an empty/dead interval.

### P0-D — The first-event fallback can duplicate work

The 15-second watchdog assumes that no first SSE event means the direct turn did not start. That assumption is unsafe:

- auth, conversation lookup/create, message persistence, attachment vision and other pre-stream work occur before the response body emits the first SSE frame;
- the user message may already be stored before timeout;
- the direct route may create its turn just after `/turn` tries to cancel existing running turns;
- the worker internal call persists the same user message again;
- a fresh conversation cannot use the fallback because `/turn` currently requires an existing `conversationId` that the client has not received yet.

Cancellation by conversation is not an idempotency guarantee. This must be replaced by a single server-owned turn creation operation and a client-generated idempotency key.

### P0-E — Native event parity is incomplete

The server/web event set includes behavior the native switch silently ignores:

- `personal_mode`
- `subagent_start`
- `subagent_end`
- `verification_retry`
- `model_switch_required`
- `compact_suggested`
- `conversation_compacted`
- `done.needContinue`
- `done.messageId`, tokens/cache/cost during live completion
- tool screenshot and several card metadata fields

This is why web can show activity that native never displays. The default switch currently hides protocol drift instead of reporting it.

### P1-A — Every token performs too much MainActor work

`AssistantNet.streamEvents` awaits an `@MainActor` callback for each decoded event. For each delta the native code may:

- find the streaming message by scanning the array;
- concatenate Swift strings;
- copy/replace timeline and block arrays;
- rebuild phases by walking the timeline;
- rebuild Markdown segments for the full accumulated reply;
- invalidate a large observable message value;
- trigger a scroll scheduling task;
- redraw one or more `TimelineView` shimmers.

The web client already coalesces text/thinking deltas with `requestAnimationFrame`. Native needs an equivalent event buffer.

### P1-B — Scroll gap: high-confidence layout instability

The exact device-only gap must be proven with signposts and row-bound overlays, but the repository has a strong regression candidate:

- `AlmaSelectableRichText` was recently introduced as a dynamic-height `UITextView` inside `LazyVStack`.
- It calculates height in `sizeThatFits` on demand and has no coordinator-level width/content height cache or explicit intrinsic-size invalidation.
- settled interleaved replies can contain several separate `UITextView` instances.
- message reconciliation replaces the value backing a stable outer row ID, sometimes swapping live SwiftUI text/blocks for persisted UIKit-backed text.
- Lazy stacks estimate/cache dynamic child heights while rows enter and leave the viewport.
- some message content uses `.frame(maxHeight: .infinity)` inside a vertical scroll hierarchy.
- rapid streaming, settle merge, selectable-view replacement and auto-scroll can all occur during the same layout window.

This combination can leave a stale reserved row height or visible scroll offset after content changes. Do not “fix” it with a negative padding or a global fixed row height.

### P1-C — Scroll tasks are coalesced logically, not physically

`scheduleScrollToBottom` creates a new sleeping Task for every text change. Old tasks wake and exit by checking a generation number, but they still exist and wake on `MainActor`. Use one cancelable debounce task.

### P1-D — Full-history polling scales poorly

Every 12 seconds, `/conversations/:id/messages` returns the complete conversation. Native decodes it, reconstructs cards/tools, and replaces the entire `messages` array. Long conversations make network, decode, reconciliation and dynamic-height recalculation progressively slower.

### P1-E — Local/server ID mapping leaks across conversations

`localIdByServerId` is not cleared in `openConversation()` or `newChat()`. Even if UUID collisions are unlikely, the map grows indefinitely and makes reconciliation state conversation-unsafe.

### P2 — Test and observability gaps

- Native CI only performs a manual simulator compile.
- No native reducer/SSE contract tests were found.
- No XCUITest covers background/foreground, network loss, dynamic row height, long streaming, scroll anchoring or event parity.
- There are no native signposts for first event, delta flush, row height, reconnect or final reconciliation.

---

## 4. Target architecture

### 4.1 One durable turn, one execution

Every web/iOS/Android turn should use one flow:

1. Client generates `clientMessageId` (UUID) before send.
2. Client POSTs a turn command once.
3. Server transactionally creates/finds conversation, idempotently stores the user message, and creates/finds exactly one `AgentTurn`.
4. Server immediately returns `202` with `conversationId`, `turnId`, `userMessageId`, and stream URL/cursor information.
5. Server decides inline versus VPS worker. The client never resubmits the prompt to switch execution environments.
6. Both inline and worker execution write the same sequenced durable event log.
7. Client connects/reconnects using `turnId` and `afterSeq`/`Last-Event-ID`.
8. On terminal event the client reconciles the persisted assistant message once.

Suggested response:

```json
{
  "conversationId": "...",
  "turnId": "...",
  "userMessageId": "...",
  "status": "running",
  "lastSeq": -1
}
```

### 4.2 Native turn state machine

Create an explicit state enum instead of several loosely related booleans:

```swift
enum TurnUIState: Equatable {
    case idle
    case submitting(clientMessageId: UUID)
    case connecting(turnId: String)
    case streaming(turnId: String, lastSeq: Int)
    case backgroundRunning(turnId: String, lastSeq: Int)
    case reconnecting(turnId: String, lastSeq: Int, attempt: Int)
    case awaitingPersistence(turnId: String)
    case completed(turnId: String, messageId: String?)
    case failed(TurnFailure)
    case canceled(turnId: String?)
}
```

Derived UI properties (`isStreaming`, stop button, live label, composer disabled state) must come from this state. Do not maintain independent booleans that can contradict one another.

### 4.3 Recovery descriptor

Persist a small non-sensitive descriptor when a turn starts:

```swift
struct RecoverableTurn: Codable {
    let conversationId: String
    let turnId: String
    let clientMessageId: UUID
    let localAssistantId: String
    var lastSeq: Int
    let startedAt: Date
}
```

Store it in memory and `UserDefaults` so process termination can recover. Clear it only after a terminal status and successful message reconciliation, or explicit cancel.

### 4.4 Event reducer and buffered UI snapshots

- Decode network bytes off-main.
- Feed decoded events into an `actor AgentEventBuffer`.
- Coalesce adjacent `text_delta` and `thinking_delta` events for 33–50 ms.
- Flush pending deltas before control events such as `tool_start`, cards, `done`, or `error` so chronology remains exact.
- Apply one reducer snapshot on `MainActor` per flush, not one per token.
- Unknown events must produce telemetry in debug/release logs; never silently disappear.

Target visible update rate: 20–30 UI updates/second maximum. This is visually continuous and far cheaper than token-rate updates.

### 4.5 Stable message identity

- Use server `messageId` as canonical identity whenever known.
- Track optimistic identity with `clientMessageId`, not positional “last user/last assistant” matching.
- Keep a stable reference-type message node or an ID-keyed store so updating the tail does not recreate every settled message value.
- Only the active assistant tail may mutate during streaming.
- Reconcile individual rows; never replace the full array for a small status change.
- Clear all optimistic ID maps on conversation switch/new chat.

---

## 5. Phase-by-phase implementation plan

## Phase 0 — Reproduce and instrument before changing layout

**Goal:** prove which row owns the giant height and capture lifecycle timing.

### Tasks

1. Add debug-only row overlays showing:
   - message ID suffix;
   - role;
   - measured row height;
   - block count;
   - selectable-text view count;
   - streaming/settled status.
2. Add `os_signpost` intervals/events:
   - `turn.submit`
   - `turn.firstEvent`
   - `turn.transportDisconnected`
   - `turn.foreground`
   - `turn.reconnectStarted`
   - `turn.terminal`
   - `turn.messagesReconciled`
   - `message.rowHeightChanged`
   - `stream.bufferFlush`
3. Add a debug fixture that creates:
   - 40 mixed user/assistant rows;
   - a 2,000+ character assistant answer;
   - interleaved thinking/tool/prose blocks;
   - selectable Bangla/Banglish text;
   - a live tail receiving 1,000 small deltas.
4. Reproduce on the same major iOS version/device class as the owner. Test scroll up/down during stream and immediately after settle reconciliation.

### Exit criteria

- The debug overlay identifies the specific row/view reserving the blank height.
- Timeline logs explain the 15–20-second background-return delay.
- Instrumentation is debug-gated and does not expose prompt/tool contents.

---

## Phase 1 — Production hotfix: no raw error, no blank recovery, stable scroll

This phase should ship before the backend durable-turn migration.

### 1.1 Classify transport errors

Add a typed classifier:

```swift
enum TurnFailureKind {
    case transportInterrupted
    case offline
    case authentication
    case server(status: Int)
    case protocolViolation
    case terminalAgentError
}
```

When a stream throws and `currentTurnId != nil` or the conversation's latest turn is running:

- do not set the raw error toast;
- do not mark the assistant turn failed;
- freeze the partial content;
- keep/create the streaming tail;
- transition to `.reconnecting` or `.backgroundRunning`;
- show `কাজ চলছে — সংযোগ ফিরছে…` immediately;
- start immediate status recovery.

Only show a failure after the server reports `error/canceled`, a non-retryable HTTP error occurs, or bounded recovery proves no turn exists.

Map all user-facing errors to Bangla/Banglish. Preserve technical error/code in logs only.

### 1.2 Add assistant lifecycle observers

Observe at least:

- `UIApplication.didEnterBackgroundNotification`
- `UIApplication.willEnterForegroundNotification`
- `UIApplication.didBecomeActiveNotification`

Rules:

- background: record recovery descriptor; stop UI animation clocks where appropriate; do not cancel server work;
- foreground: cancel stale poll sleeps and run recovery immediately;
- didBecomeActive: if the prior recovery was interrupted, run an idempotent recovery call again;
- remove observers/cancel tasks when the screen/store is destroyed.

Do not register duplicate observers every time `bootstrap()` runs.

### 1.3 Immediate recovery algorithm for current backend

Until all turns have durable event replay:

1. Immediately fetch `/turn-status` on foreground; do not wait for the 12-second timer.
2. If `running`:
   - ensure a visible assistant streaming tail exists;
   - poll status with 1-second initial cadence, exponential backoff capped at 3 seconds, plus jitter;
   - optionally fetch messages when `updatedAt`/assistant message availability can change, but avoid full fetch every second.
3. If terminal:
   - fetch messages immediately;
   - reconcile final assistant row;
   - remove reconnect label only after the row appears.
4. If status request transiently fails:
   - keep reconnect UI;
   - retry; do not show a false terminal error.

This alone should change the owner's experience from “error + nothing + result” to “work continues/reconnecting + result”.

### 1.4 Fix layout/scroll gap safely

Apply the proven root-cause fix after Phase 0 instrumentation. The expected fix set is:

1. Replace unbounded row modifiers:
   - remove `.frame(maxHeight: .infinity)` from message content in the vertical chat scroll;
   - use `.fixedSize(horizontal: false, vertical: true)` for naturally sized text content;
   - use explicit fixed/capped heights only for intentionally collapsed long answers.
2. Stabilize `AlmaSelectableRichText`:
   - create a `UITextView` subclass with reliable `intrinsicContentSize` for a known width;
   - set `textContainer.widthTracksTextView = true`;
   - disable internal scrolling;
   - set vertical content hugging/compression priorities;
   - invalidate intrinsic size only when attributed content, trait collection, dynamic type size, or effective width changes;
   - cache measured height by `(contentHash, roundedWidth, contentSizeCategory)` in the Coordinator;
   - never return a stale height measured for a different width;
   - prevent recursive SwiftUI layout invalidation.
3. Avoid many UIKit text views per one message where possible:
   - settled interleaved prose should be combined into the minimum number of selectable views consistent with activity/card ordering;
   - do not split every line into a separate `UITextView`.
4. Preserve scroll anchor during reconciliation:
   - if user is near bottom, retain bottom distance and scroll once after the transaction;
   - if user is reading older content, capture the top visible message ID/offset and restore it after height changes;
   - never force bottom scroll while `nearBottom == false`.
5. Keep stable outer row identity:
   - never use random `.id(UUID())` to force a refresh;
   - if an inner renderer must be recreated, use a deterministic content/layout revision on the inner view only.
6. Replace `bottomScrollGeneration` task fan-out with one stored `scrollDebounceTask` that is canceled before scheduling the next scroll.
7. Perform server-message merge in one non-animated transaction; do not animate layout changes caused by authoritative reconciliation.

### 1.5 Reconciliation hotfixes

- Clear `localIdByServerId` in `openConversation()` and `newChat()`.
- Do not pair by “last assistant after last user” when a stable client ID can be available.
- Never retain an empty local assistant tail after a server terminal reply is present.
- Never replace rich streamed text with a thinner persisted row.
- Do not retain stale `blocks` from a local row when the canonical server message represents a different turn.

### Phase 1 acceptance criteria

- Background/foreground during a running turn never shows `The network connection was lost.`.
- A running/reconnecting indicator appears within 300 ms of foreground activation.
- If the server already finished, final content appears within 2 seconds on a normal connection.
- If still running, partial content remains and the UI shows a truthful live state.
- No viewport-sized blank gap after 100 repeated up/down scrolls during and after streaming.
- User reading position does not jump to bottom when reading older content.
- Stop still cancels the server turn when `turnId` exists.

---

## Phase 2 — Native event contract, reducer and performance

### 2.1 Create one authoritative event contract

`src/agent/lib/core.ts` currently defines the most complete `AgentEvent`. Make it the canonical source and add a machine-readable schema, for example:

- `src/agent/protocol/agent-event.schema.json`
- generated/validated TypeScript discriminated union
- Swift `AgentEvent` enum with associated payload structs

Do not keep an “all optional fields” Swift struct indefinitely. A discriminated enum makes missing required fields fail clearly.

Include every current event:

- conversation/turn metadata events added by the route;
- model info/switch;
- thinking/text;
- tool start/end including screenshot;
- subagent start/end;
- artifact;
- confirm/ask cards and all metadata;
- verification retry;
- compact/compacted;
- done usage/needContinue;
- terminal error.

Add a compatibility `.unknown(type:raw:)` case that logs telemetry and preserves stream continuity.

### 2.2 Robust SSE parser

Replace the exact `line.hasPrefix("data: ")` parser with a small tested SSE parser that supports:

- `data:` with or without one space;
- CRLF and LF;
- multiple `data:` lines in one event;
- comment keepalives;
- optional `id:` and `retry:` fields;
- trailing event without final blank line;
- malformed JSON telemetry without killing unrelated later events;
- cancellation without converting it to agent failure.

### 2.3 Event batching

Implement `AgentEventBuffer` actor:

- append text/thinking chunks;
- flush at most every 33–50 ms;
- flush immediately before control events;
- preserve strict sequence order;
- reject/dedupe event sequence `<= lastSeq`;
- expose buffer depth and flush duration metrics.

Avoid rebuilding phases from the full timeline on every thinking chunk. Update the active phase/activity block incrementally. Recompute the full derived model only on settle or debug invariant check.

### 2.4 Lightweight streaming renderer

- While streaming, render accumulated prose with a lightweight text path.
- Throttle Markdown segmentation/parsing to at most 8–10 times/second, or perform full Markdown conversion only on settle.
- Maintain the required glyph-only shimmer but avoid multiple independent 60-fps clocks. Use one environment/live animation clock or a lower bounded refresh rate.
- Settled content may use the full selectable rich-text renderer.
- Cache attributed Markdown by message content revision and color/dynamic-type traits.

### 2.5 Split the monolith

Suggested files:

```text
ios/App/App/Assistant/
  AgentEvent.swift
  AgentSSEParser.swift
  AgentStreamClient.swift
  AgentEventBuffer.swift
  AssistantTurnStateMachine.swift
  AssistantMessageStore.swift
  AssistantMessageReconciler.swift
  AssistantLifecycleController.swift
  Views/AssistantScreen.swift
  Views/AgentMessageList.swift
  Views/AgentMessageRow.swift
  Views/AgentRichTextView.swift
  Views/AgentActivityViews.swift
  Views/AgentCardViews.swift
```

Keep `AssistantSwiftUI.swift` as a temporary compatibility entry point while moving code. Each extraction PR must compile before the next extraction.

### Phase 2 acceptance criteria

- Native has an explicit handler/test for every server event.
- 1,000 one-character deltas produce at most roughly 20–30 observable UI commits per second.
- No dropped/reordered prose, thinking, tool, card, subagent, or terminal events.
- Main-thread p95 frame work stays below 12 ms during the stress fixture on the target device class.
- Long responses do not get progressively more laggy.

---

## Phase 3 — Permanent backend: canonical durable turn

### 3.1 Database migration

Extend `AgentTurn` with fields similar to:

```prisma
clientMessageId    String?   @map("client_message_id")
userMessageId      String?   @map("user_message_id")
assistantMessageId String?   @map("assistant_message_id")
lastSeq            Int       @default(-1) @map("last_seq")
executionMode      String?   @map("execution_mode") // inline | worker
updatedAt          DateTime  @updatedAt @map("updated_at")

@@unique([conversationId, clientMessageId])
```

Exact nullability should support safe rollout. Migration must be additive and backward compatible.

### 3.2 Idempotent command endpoint

Refactor `/api/assistant/turn` or introduce a versioned endpoint that:

- accepts new or existing conversations;
- accepts `clientMessageId`;
- creates the conversation if necessary;
- stores the owner message once;
- creates/returns one turn once;
- returns immediately before vision/model/tool work;
- on retry with the same idempotency key returns the existing turn instead of creating another message/turn.

Use a transaction and a database uniqueness constraint. In-memory locks are insufficient in serverless deployments.

### 3.3 Server-owned execution selection

The server decides inline vs worker based on policy/health/expected duration. Handoff must transfer the existing `turnId`; it must never require the client to resend the original message.

Remove the client-side 15-second “cancel direct then rerun prompt” behavior after all clients migrate. A connection timeout may reconnect to the same turn only.

### 3.4 Durable events for every execution mode

Extract a shared event publisher used by inline and worker turns:

1. atomically allocate/increment `seq` per turn;
2. append `agent_turn_events` first;
3. publish live event second;
4. update `AgentTurn.lastSeq`;
5. persist terminal message ID/status.

Do not let inline serverless events remain ephemeral.

### 3.5 Replay endpoint

Enhance `/api/assistant/turn/:id/stream`:

- accept `afterSeq` or `Last-Event-ID`;
- replay only newer events;
- dedupe replay/live overlap;
- immediately emit a connection/turn snapshot if useful;
- return terminal replay then close cleanly;
- include `Cache-Control: no-cache, no-transform`;
- consider `X-Accel-Buffering: no` for compatible proxies;
- authorize ownership of the turn/conversation;
- cap replay pages for pathological turns while allowing cursor continuation.

### 3.6 Richer status endpoint

Return:

```json
{
  "status": "running",
  "turnId": "...",
  "lastSeq": 123,
  "assistantMessageId": null,
  "startedAt": "...",
  "updatedAt": "..."
}
```

This lets native distinguish “stream quiet but alive” from “stale/ghost” and fetch the exact final row.

### Phase 3 acceptance criteria

- The same `clientMessageId` submitted 20 times creates one user message and one turn.
- Network switch, app suspension and reconnect never create another execution.
- Inline and worker turns both replay missed events.
- Killing and reopening the app restores the exact running turn and partial activity.
- Fresh-conversation turns recover as reliably as existing-conversation turns.

---

## Phase 4 — Message pagination, observability and CI gates

### 4.1 Paginate messages

Change message history API to support:

- initial latest 30–50 messages;
- `before` cursor to load older rows when scrolling up;
- `after`/`since` cursor or revision for new/changed rows;
- exact-message fetch by ID after terminal turn.

Native should prepend older pages while preserving the visible anchor. The 12-second full-history replacement must stop being the primary consistency mechanism.

### 4.2 Consolidate polling

Use one lifecycle-aware sync coordinator for:

- active turn;
- new messages;
- open tasks;
- plan drive;
- presence.

Do not let several independent tasks concurrently reload and mutate the same chat state. Pause nonessential polling while backgrounded and resume immediately/once when active.

### 4.3 Metrics

Record, without prompt contents:

- submit-to-turn-ID latency;
- turn-ID-to-first-event latency;
- foreground-to-recovery-state latency;
- foreground-to-first-replayed-event latency;
- foreground-to-final-message latency;
- reconnect attempts;
- duplicate/dropped sequence count;
- unknown event types;
- event buffer depth/flush time;
- message row height changes over a threshold;
- scroll anchor corrections;
- terminal status/message reconciliation mismatch.

Tag logs with `conversationId`/`turnId` hashes or IDs according to existing privacy policy. Never log message text, reasoning, tool secrets, cookies, or auth headers.

### 4.4 Automated tests

#### Swift unit tests

- every event fixture decodes into the correct case;
- unknown event remains nonfatal;
- SSE LF/CRLF/multiline/trailing/keepalive parsing;
- reducer chronology and adjacent-delta coalescing;
- duplicate/out-of-order sequence handling;
- transport error classification;
- state-machine transitions;
- message reconciliation by client/server IDs;
- scroll debounce owns only one task.

#### Backend tests

- idempotent turn creation under concurrent requests;
- fresh/existing conversation behavior;
- inline-to-worker handoff keeps same turn;
- replay/live overlap dedupe;
- terminal event/status/message ID consistency;
- cancel during inline and worker execution;
- auth cannot stream another owner's turn.

#### XCUITest/device scenarios

1. Send, background before `turnId`, return.
2. Send, background after `turnId`, return while running.
3. Return after turn already completed.
4. Kill process while running, relaunch.
5. Switch Wi-Fi → 4G during text streaming.
6. Toggle airplane mode briefly and recover.
7. Scroll 100 times during 1,000-delta response.
8. Settle/merge while reading a message in the middle.
9. Long Bangla answer with selectable text and Dynamic Type sizes.
10. Tool + subagent + confirmation + ask-card event sequence.
11. Server terminal error vs transport interruption.
12. Stop, background, and reopen; canceled work must not resurrect.

### 4.5 CI

- Run iOS simulator build automatically for PRs touching `ios/**`, assistant protocol, turn routes or Prisma turn schema.
- Run Swift unit tests on those PRs.
- Keep expensive full UI tests nightly/manual plus a small blocking smoke subset.
- Upload diagnostic screenshots/logs on failure.

---

## 6. File-by-file change map

| File/current area | Required change |
|---|---|
| `ios/App/App/AssistantSwiftUI.swift` | Extract transport/state/reducer/layout; add lifecycle recovery; remove per-event MainActor mutations; stabilize list/row measurement. |
| `ios/App/App/AlmaAPI.swift` | Reuse shared request/auth policy; add typed transport classification and request metrics; avoid conflicting assistant sessions. |
| `ios/App/App/ConnectivityBeacon.swift` | Keep for genuine app-wide offline UX, but do not use it as turn completion truth. Optionally publish connectivity state to recovery coordinator. |
| `src/agent/lib/core.ts` | Remain canonical semantic `AgentEvent`; align schema and clients. |
| `src/app/api/assistant/chat/route.ts` | Separate command acceptance/persistence from execution; eventually stop being the client turn-creation SSE endpoint; publish durable events. |
| `src/app/api/assistant/turn/route.ts` | Accept new chats and idempotency key; return turn immediately; never duplicate message. |
| `src/app/api/assistant/turn/[id]/stream/route.ts` | Cursor replay for every turn, richer SSE semantics and headers. |
| `src/app/api/assistant/conversations/[id]/turn-status/route.ts` | Return last sequence, update time and final assistant message ID. |
| `src/agent/lib/turn-status.ts` | Idempotent create/find; richer lifecycle snapshot; transactional terminal linkage. |
| `src/agent/lib/turn-events.ts` | Shared sequence publisher/replay helpers for inline and worker execution. |
| `worker/src/turn/run-streamed-turn.mjs` | Consume existing turn only; use shared event semantics; do not create/store the owner message again. |
| `prisma/schema.prisma` | Add idempotency/recovery/sequence/message-link fields and indexes. |
| `.github/workflows/ios-simulator.yml` | Add PR triggers/path filters and Swift tests. |

---

## 7. Invariants Claude Code must enforce

Write these as assertions/tests where possible:

1. One `clientMessageId` maps to at most one owner message and one turn.
2. A reconnect never executes model/tool work; it only observes the existing turn.
3. UI transport state is not server turn state.
4. A transport interruption cannot become a red error while server status is running.
5. Exactly one assistant tail represents a running turn in one conversation.
6. Every event sequence is applied at most once and in order.
7. A terminal event is not considered fully presented until its persisted assistant message is reconciled.
8. Settled rows do not mutate during a different active turn.
9. Conversation switch cancels local stream/recovery tasks without canceling server work unless explicitly requested.
10. User scroll position is preserved across non-user-initiated reconciliation.
11. No message row may reserve unexplained vertical space; measured height must equal visible content plus documented padding.
12. Unknown protocol events are observable in telemetry and nonfatal.

---

## 8. What not to do

- Do not increase the 15-second watchdog and call it fixed.
- Do not shorten the 12-second poll and call it realtime recovery.
- Do not retry by POSTing the original message again.
- Do not use conversation-wide cancellation as the sole duplicate-prevention mechanism.
- Do not hide every error; distinguish transport interruption from real terminal failure.
- Do not add negative padding, arbitrary spacers, global fixed message heights, or random view IDs to hide the scroll gap.
- Do not rebuild the whole `messages` array per token.
- Do not parse the full Markdown reply for every one-character delta.
- Do not run all network decoding/reduction on `MainActor`.
- Do not remove true selectable text without an owner-approved replacement.
- Do not alter model routing or replace Grok 4.20 as part of this work.
- Do not redesign locked message/card/shimmer visuals while doing reliability work.

---

## 9. Recommended PR sequence

### PR 1 — Diagnostics + recovery hotfix

- lifecycle observers;
- transport error classification;
- immediate foreground status sync;
- visible recovered streaming tail;
- Bangla reconnect state;
- debug signposts/row bounds;
- clear ID maps on conversation switch.

### PR 2 — Scroll/layout fix

- reproduce with fixture;
- fix selectable UITextView intrinsic measurement;
- remove infinite row sizing;
- deterministic anchor preservation;
- single cancelable scroll debounce;
- add scroll/dynamic-height UI tests.

### PR 3 — Event parity + batching

- canonical schema/Swift event enum;
- robust SSE parser;
- buffered reducer;
- all missing native events;
- lightweight streaming renderer;
- stress tests.

### PR 4 — Idempotent durable turn backend

- additive Prisma migration;
- command endpoint returning turn immediately;
- clientMessageId uniqueness;
- one execution decision;
- durable events for inline + worker;
- replay cursor/status snapshot;
- concurrent idempotency tests.

### PR 5 — Native migration to canonical durable turn

- remove direct/fallback resend race;
- persistent recovery descriptor;
- replay on foreground/relaunch;
- exact terminal reconciliation;
- kill/relaunch and 4G handoff tests.

### PR 6 — Pagination + CI/performance gates

- paginated/delta message sync;
- consolidated polling;
- automatic PR simulator/unit tests;
- performance acceptance dashboard.

Do not delete the old client path until production telemetry shows the new path is healthy and rollback remains possible.

---

## 10. Definition of done

The native iOS agent is complete only when all are true:

- [ ] Grok 4.20 behavior/model choice is unchanged.
- [ ] Owner can background or kill the app and the agent continues server-side.
- [ ] Reopening instantly displays running/reconnecting/final state; no dead interval.
- [ ] No raw English network toast for an expected suspended stream.
- [ ] Final answer normally appears within 2 seconds of foreground if already complete.
- [ ] No duplicate owner message, agent turn, tool execution, approval, or final answer after retries/reconnects.
- [ ] All web/server event types have native handling or explicit unknown telemetry.
- [ ] Long Grok reasoning remains smooth while streaming and scrolling.
- [ ] No giant blank gap in the supplied reproduction pattern.
- [ ] Scroll position remains stable during settle, poll, card status change and foreground reconciliation.
- [ ] Message history is paginated/incremental rather than fully replaced every 12 seconds.
- [ ] Unit tests cover protocol, reducer, recovery and idempotency.
- [ ] UI tests cover background, relaunch, network handoff and dynamic row height.
- [ ] PR CI blocks regressions in native assistant code/protocol.

---

## 11. First commands/checks for Claude Code

1. Confirm clean worktree and audited commit/branch.
2. Read:
   - `ios/App/App/AssistantSwiftUI.swift`
   - `ios/App/App/AlmaAPI.swift`
   - `ios/App/App/ConnectivityBeacon.swift`
   - `src/agent/components/AgentApp.tsx` for current web buffering/recovery parity
   - `src/agent/lib/core.ts` event contract
   - `src/app/api/assistant/chat/route.ts`
   - `src/app/api/assistant/turn/route.ts`
   - `src/app/api/assistant/turn/[id]/stream/route.ts`
   - `src/agent/lib/turn-status.ts`
   - `src/agent/lib/turn-events.ts`
   - `worker/src/turn/run-streamed-turn.mjs`
   - `prisma/schema.prisma` (`AgentTurn`, `AgentTurnEvent`)
3. Build the simulator baseline before edits.
4. Add diagnostics/reproduction fixture before guessing at the scroll gap.
5. Complete and verify PR 1 acceptance criteria before starting the database migration.

This order is intentional: stop the owner's current production pain first, then replace the split transport architecture without mixing a UI hotfix and a cross-system migration in one risky change.

---

## AUDIT ANNEX — repo verification of every roadmap claim (2026-07-14, HEAD `d94c199c`)

Claude Code independently verified each root-cause claim against the actual code before starting work.

### Confirmed exactly as written

| Claim | Evidence in repo |
|---|---|
| ~6,100-line monolith | `AssistantSwiftUI.swift` = **6,155 lines**; contains DTOs, URLSession SSE, VM, merge, Markdown, UIKit text, all views, sidebar, voice |
| P0-A raw error toast | `runTurn` generic catch (`AssistantSwiftUI.swift:1462`) sets `errorToast = error.localizedDescription`; only `CancellationError` + `notAuthenticated` handled specially; no `URLError` classification, no `currentTurnId` check |
| P0-B no lifecycle observers | zero `willEnterForeground` / `didBecomeActive` / `didEnterBackground` observers in the assistant; only auth-expired NotificationCenter observer in `bootstrap()` (which also re-registers on every call) |
| P0-B 15–20 s delay | quiet poll = 12 s (`startPolling`, line 1094) + fetch/decode/render; resume path polls status every fixed 3 s (line 1126) |
| P0-C resume has no tail | `resumeRunningTurnIfAny()` (line 1116) sets `isStreaming`/`thinkingLive` but never calls `ensureStreamingTail()` — spinner attaches to a streaming row that doesn't exist |
| P0-D duplicate-work fallback | 15 s first-event watchdog (line 1439) → `runWorkerFallback` re-POSTs the same prompt to `/api/assistant/turn`; that route 400s without `conversationId` (`turn/route.ts:46`) so fresh chats can't fall back; dedupe is only `cancelRunningTurnsForConversation` (`turn-status.ts:58`) — cancellation-by-conversation, not idempotency |
| P0-E event parity gap | native `handle()` switch (line 1512) covers 12 types, `default: break` silently drops `subagent_start/end`, `verification_retry`, `model_switch_required`, `done.needContinue`, `done` usage/cost fields, `tool_end.screenshot` — all present in `core.ts` `AgentEvent` union (line 55) |
| P1-A per-token MainActor work | `streamEvents` awaits `@MainActor` callback per event (line 786); every delta scans `messages`, rebuilds blocks + `refreshPhases` (lines 1520–1545) |
| P1-B layout instability candidates | `AlmaSelectableRichText` (line 1919) measures via `sizeThatFits` with no width/height cache; `.frame(maxHeight: .infinity)` at lines 2909, 4270; merge replaces whole `messages` array (line 1067) |
| P1-C scroll task fan-out | `scheduleScrollToBottom` (line 5780) spawns a new task per call, generation-checked (`bottomScrollGeneration`), old tasks still wake on MainActor |
| P1-D full-history poll | `loadMessages` fetches complete `/conversations/:id/messages` every 12 s and `mergeServerMessages` rebuilds/replaces the array |
| P1-E ID-map leak | `localIdByServerId` (line 1011) never cleared in `openConversation()` (1239) or `newChat()` (1254) |
| SSE parser fragility | exact `line.hasPrefix("data: ")` (line 797); malformed JSON silently `continue`s; no multi-line data, no `id:`/`retry:` |
| Durable events worker-only | `agent_turn_events` written only by VPS worker path; direct `/chat` path never appends (grep: no `agentTurnEvent` in `chat/route.ts`) |
| No replay cursor | `turn/[id]/stream/route.ts` has no `afterSeq` / `Last-Event-ID` handling (grep: zero hits) |
| Thin status endpoint | `turn-status` returns only `{status, turnId, startedAt}` — no `lastSeq`, no `assistantMessageId`, no `updatedAt` |
| `AgentTurn` schema gap | model (schema.prisma:2062) has no `clientMessageId`/`userMessageId`/`assistantMessageId`/`lastSeq`/`executionMode`/`updatedAt` |
| Web already coalesces | `AgentApp.tsx` uses `requestAnimationFrame` flush buffers (lines 921, 945) — native has no equivalent |
| CI manual-only | `.github/workflows/ios-simulator.yml` = `workflow_dispatch` only, no PR trigger, no Swift tests |
| Server continues after disconnect | `chat/route.ts:396–595` deliberately detaches turn from `req.signal`; abort marks disconnected but does not cancel the turn — confirms Screenshot B behavior |

### Deviations / notes

1. **Head model:** roadmap says "Keep Grok 4.20". Code default is `HEAVY_HEAD_MODEL_ID → gemini-3.1-pro` (`models/head-router.ts:46`); `or-grok-4.20` exists in the registry and the head is env-tunable, so prod may well run Grok via env. Either way the constraint is honored: **this work changes no model routing whatsoever.**
2. **Audited commit drift:** repo is 2 commits ahead (`#346` LISTEN mode, `#347` cost badge) — line numbers above are from `d94c199c`; no architectural drift.
3. Approval-card timestamps (`confirmApprovedAt`, line 1636) exist precisely because the 12 s full-array poll wipes derived state — extra evidence for P1-D/§4.5.
