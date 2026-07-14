# ALMA Agent iOS Presentation Parity & Reply Quality Roadmap

**Status:** APPROVAL REQUIRED — diagnosis complete, implementation not started  
**Created:** 2026-07-14  
**Audited baseline:** `origin/main` at `9dacf429`  
**Program type:** Separate corrective program; this is **not** an extension or re-run of `docs/ios-stability-roadmap.md`  
**Primary outcome:** The same settled agent turn must show the same owner-facing answer, activity, cards, usage and ordering on web and native iOS, without flicker, disappearing content or a redesign.

---

## 1. Executive verdict

The previous iOS stability roadmap successfully addressed transport recovery, durable turns, replay, duplicate execution, pagination and major scroll instability. It did **not** establish one canonical presentation contract shared by the server, web and native iOS clients.

The current production defect is therefore architectural, not a one-line visual bug:

1. The server persists an ordered timeline containing `think`, `text`, `tool` and `file` entries.
2. The web client renders `text` entries chronologically.
3. The native iOS history decoder drops persisted `text` timeline entries.
4. During live verification retry, native iOS clears the visible prose blocks.
5. Poll/recovery/cold-load can then rebuild the row from a thinner persisted projection.
6. Web and iOS also decode and calculate usage/step metadata differently.
7. Native reply formatting uses a separate markdown-lite renderer with unstable segment identity and forced serif body typography.

This explains all reported symptoms:

- the same conversation looks different on web and iPhone;
- reply content appears, changes a few seconds later, or loses its main section;
- web reports 4 API rounds while iOS reports 3 UI phases;
- cached-token totals appear on web but not on iOS;
- Bangla/Banglish reply text looks dense, uneven and less professional than ChatGPT/Claude iOS;
- a reload, reconnect or app relaunch can change the visible composition of an already completed turn.

The permanent fix is to create one versioned server-owned presentation projection and make both clients render it faithfully. **Owner clarification (2026-07-14): every user-visible work/progress prose segment must remain visible in its current chronological position, Claude-app style.** Verification metadata must distinguish a superseded draft from the verified final answer, but must not delete or silently hide the earlier prose.

---

## 2. Locked product requirements

These requirements are non-negotiable for every work package.

### 2.1 Design must remain intact

Do not redesign or replace:

- the aurora background;
- top header, title, menu or compose button;
- bottom navigation;
- composer shape, controls or model picker;
- owner message bubble shape/colour;
- floating assistant navigation;
- approval, ask, artifact and tool-detail card designs;
- current light/dark theme language.

Allowed work is limited to the **assistant reply content renderer's correctness**:

- paragraph/list/heading/code/table/link formatting;
- reliable line wrapping and spacing;
- activity disclosure and reply hierarchy;
- removal of flicker, blanking, accidental duplication/reordering and unstable content.

The existing prose visual language is also locked: font family, normal body size, colours, prose width, activity-row style and chronological prose/activity composition must not change without a separate owner approval. “Formatting improvement” means correctly interpreting and laying out the agent's content inside those existing tokens; it does not authorize a new visual design.

### 2.2 Behavioural invariants

1. One server turn has one canonical owner-facing presentation.
2. Live, settled, polled, foreground-recovered and cold-launched views converge to the same visible blocks.
3. Every intentional user-visible prose segment must remain visible in chronological order after settle, poll and relaunch.
4. An unverified/superseded draft must be truthfully distinguished from the verified final answer; it must not be silently deleted or falsely presented as another verified final answer.
5. Verification retry may show the existing truthful activity status, but must never leave a blank reply.
6. Polling/recovery may enrich a message; it must never silently remove already-canonical content.
7. Web and iOS must display the same prose sequence, activity order, cards, artifacts, token totals, cost and API-round count.
8. Duplicate/repeated paragraphs must remain visible and in order.
9. Unknown presentation block types must be observable in telemetry and non-fatal.
10. Message identity must be based on server IDs/turn sequence, never “last assistant after last user” alone.
11. No model routing, tool authorization, memory, ERP, finance, payroll or `/api/agent/*` behaviour may change in this program.

### 2.3 Repository safety

- Agent routes remain under `/api/assistant/*`.
- Never touch `/api/agent/*`.
- No secrets in git.
- Database work, if ultimately required, must be additive and owner-approved first.
- Every stage is one session and one focused PR/branch.
- Push only a preview branch. Never merge to main or deploy production without owner approval.
- Browser/iPhone proof is mandatory before any implementation stage is called complete.

---

## 3. Confirmed evidence and root causes

### RC-1 — persisted text timeline is dropped by native iOS (P0)

**Server evidence**

- `src/agent/lib/models/run-owner-turn.ts` defines timeline entries including `{ t: 'text'; text: string }`.
- Each model round appends visible text to the persisted timeline before tool execution.
- `src/app/api/assistant/conversations/[id]/messages/route.ts` returns `usage.timeline` to clients.

**Web evidence**

- `src/agent/components/AgentThread.tsx` includes `t: 'text'` in `TimelineEntry`.
- `ChronoFlow` renders those text segments in their true timeline order.

**Native evidence**

- `AgentTimelineEntryWire` can decode a raw `text` property, but its documented union only mentions `think | tool | file`.
- `AgentChatMessage.TimelineEntry` has no prose/text case.
- `timelineFromWire()` handles `think`, `tool` and `file`, then returns `nil` for `t == "text"`.
- A cold-loaded native message therefore renders only the final `content[].text` block.

**Observed proof**

- Web screenshot: multiple prose segments interleaved with reasoning/tool/verification activity.
- iPhone screenshot: only the last persisted final prose for the same turn.

### RC-2 — verification retry deliberately blanks native prose (P0)

In `AssistantVM.apply()`:

- `text_delta` appends prose into both `message.text` and live `message.blocks`;
- `verification_retry` sets `message.text = ""` and `message.blocks = []`;
- the previous prose is not represented as a native timeline text block;
- the next draft/final text later reappears as a new prose block.

This directly explains “একবার একরকম দেখায়, কয়েক সেকেন্ড পর বদলে যায়” and cases where the main part disappears before the replacement arrives.

### RC-3 — live and persisted messages use two different projections (P0)

- Live iOS uses SSE-derived `TurnBlock` values.
- Persisted iOS uses `AgentMessageWire → AgentChatMessage.from()`.
- Normal settle attempts to retain local blocks through `localIdByServerId`.
- Foreground recovery may clear partial blocks before a server reload.
- Cold launch has no local blocks or local/server ID map to preserve.
- `mergeServerMessages()` then replaces the loaded window with newly decoded server rows.

The same message can consequently have three different shapes:

1. live SSE shape;
2. just-settled locally preserved shape;
3. cold-loaded/polled persisted shape.

### RC-4 — usage and “steps” have different definitions (P1)

The messages API returns:

- `tokensIn`, `tokensOut`;
- `cacheCreation`, `cacheRead`;
- `costUsd`;
- `apiRounds`;
- `roundCostsUsd`.

Web uses these values and labels actual provider API rounds as steps. Native history currently decodes only input/output/cost and derives “ধাপ” from tool/phase counts. The native `done` reducer also receives richer fields but does not store the full set on the message model.

Result: the same turn can correctly show “4 API rounds” on web and “3 UI phases” on iOS, while both labels say “ধাপ”.

### RC-5 — native formatting is a separate limited renderer (P1)

`AgentMarkdownText` currently has these limitations:

- normal assistant prose is explicitly configured with the current serif style; the owner has now locked that visual choice, so this roadmap must not change it without separate approval;
- a markdown-lite implementation separate from web;
- only basic headings and flat bullets are structurally rendered;
- limited numbered/nested-list, quote and link behaviour;
- table blocks are presented as raw monospaced text rather than a semantic table;
- repeated empty lines/paragraph rhythm are normalized aggressively;
- segment identity uses content hashes, so identical repeated segments can produce duplicate SwiftUI IDs;
- streaming and settled paths use different view technologies and can measure/wrap differently.

This is why the native reply can feel visually dense or “হিজিবিজি” even when all words are technically present.

### RC-6 — previous proof gate did not test presentation convergence (P1)

The completed stability roadmap tested transport/replay/scroll scenarios, but did not require:

- the same persisted payload rendered on web and iOS;
- verification-retry prose before/after settle and relaunch;
- duplicate/repeated paragraph identity;
- exact usage/footer parity;
- a real-device screenshot of the same conversation before marking presentation complete.

The iOS CI workflow builds the simulator but does not currently provide a real Swift unit/UI test target for this projection. Its path filters also omit important presentation producers such as the messages route and head-loop timeline producer.

---

## 4. Target owner experience

For a normal completed turn, both web and iOS must show:

1. every intentional work/progress/final prose segment in the same chronological position as the current Claude-style composition;
2. the current compact activity/tool rows between those prose segments;
3. tool/reasoning detail sheets through the current expand/tap behaviour;
4. cards/artifacts exactly where the canonical presentation places them;
5. a truthful verification activity row between superseded and replacement prose when a retry occurs;
6. the same token/cost/API-round footer values;
7. no prose disappearing or moving after waiting 60 seconds, polling, background/foreground or app relaunch.

For a verification retry:

1. keep all prose already shown in its existing chronological position;
2. insert/use the existing compact “উত্তর যাচাই করে ঠিক করছি…” activity state;
3. mark the previous prose as superseded in the presentation data without visually deleting it;
4. never clear the entire reply area to blank;
5. append the verified replacement/final prose after the verification row;
6. preserve this exact composition after settle, poll and relaunch.

---

## 5. Architecture decision: one canonical presentation projection

Introduce an additive, versioned presentation object returned by the existing messages API and generated by one server helper.

Illustrative contract:

```ts
type AgentPresentationV1 = {
  version: 1
  revision: number
  turnId?: string
  messageId: string
  blocks: Array<
    | { id: string; type: 'prose'; text: string; state: 'final' | 'status' }
    | { id: string; type: 'activity'; activityType: 'thinking' | 'tool' | 'verification'; label: string; detail?: unknown; status: 'running' | 'done' | 'failed' }
    | { id: string; type: 'file'; artifactId: string; title: string; kind?: string }
    | { id: string; type: 'confirm_card'; pendingActionId: string }
    | { id: string; type: 'ask_card'; askCardId: string }
  >
  usage?: {
    tokensIn: number
    tokensOut: number
    cacheCreation: number
    cacheRead: number
    totalTokens: number
    costUsd: number
    apiRounds: number
    roundCostsUsd?: number[]
  }
}
```

This shape is illustrative, not permission to code before Stage 0 audit approval. Claude Code must confirm the smallest additive contract that fits existing data and rollback needs.

### Canonical projection rules

- Every intentionally emitted user-visible `timeline.text` segment must become a chronological prose block and survive reload.
- Prose blocks must carry a state such as `progress`, `superseded` or `final` so verification truth is preserved without deleting content.
- Final `content[].text` identifies the verified settled answer and must map to the final prose block without duplicating it.
- Verification-superseded prose remains visible in sequence but must not be labelled or counted as another verified final answer.
- Every block ID must be deterministic and unique within the message, preferably based on message/turn ID + sequence/ordinal.
- The API supplies complete usage semantics; clients do not invent their own definition of “steps”.
- Legacy messages without `presentation` must be projected server-side into V1 at read time.
- Initial rollout remains additive: old fields stay available until both clients are proven and rollback-safe.

---

## 6. Work packages and proof gates

Each work package is one session and one PR. Claude Code must stop after its proof pack and wait for owner approval before moving to the next package.

### Stage 0 — Reproduction, baseline and failing contracts

**Goal:** Prove the defect before touching runtime behaviour.

**Allowed work:** tests, fixtures, diagnostics and documentation only.

**Required tasks**

1. Record audited SHA, branch, dirty-worktree state and exact allowed files.
2. Create a sanitized fixture representing the reported turn:
   - initial prose;
   - tool/reasoning activity;
   - `verification_retry`;
   - replacement final prose;
   - cached tokens;
   - 4 API rounds;
   - repeated identical paragraph segment.
3. Add a pure server projection test that defines the intended canonical visible blocks.
4. Add a native decoding/projection assertion runnable without a production write.
5. Add a web projection assertion using the same fixture.
6. Demonstrate the tests fail on the current implementation for the expected reasons.
7. Capture baseline screenshots from:
   - Vercel preview in the owner's Chrome;
   - iOS simulator;
   - real iPhone/TestFlight if the current build is available.

**Mandatory proof**

- failing test names and concise failure output;
- current web visible-block list;
- current iOS visible-block list;
- side-by-side screenshot showing mismatch;
- no runtime-code diff;
- `git diff --stat` proving Stage 0 scope.

**Stop gate:** Do not begin Stage 1 until the owner approves the fixture and target presentation.

### Stage 1 — Canonical server presentation contract

**Goal:** Build one additive server projection for live and historical messages.

**Required tasks**

1. Implement a pure `buildAgentPresentationV1()`-style helper in agent-owned code.
2. Convert stored content, usage timeline, tool calls and cards into deterministic blocks.
3. Classify final prose, progress/status prose and superseded verification drafts.
4. Return the projection from the existing `/api/assistant/conversations/[id]/messages` route.
5. Ensure legacy messages receive a deterministic read-time projection.
6. Include the complete usage object and explicit `apiRounds` terminology.
7. Add schema/contract validation and unknown-block compatibility.
8. Do not remove or rename legacy response fields.

**Tests that must pass**

- verification retry preserves the earlier prose, a verification activity block and one correctly identified final prose block;
- intentional status/progress prose remains visible in chronological order without being mislabelled as final;
- activity/tool/file/card ordering is deterministic;
- duplicate paragraphs receive different stable block IDs;
- legacy message fallback is stable across repeated reads;
- cache and round totals match stored usage exactly;
- no database or model/tool behaviour changes.

**Mandatory proof**

- red-to-green test output;
- sanitized JSON response from preview showing `presentation.version = 1`;
- two repeated GETs produce byte-equivalent presentation blocks;
- preview web still renders with legacy path before client migration;
- build/typecheck/agent test results;
- file-scope diff and commit SHA.

**Stop gate:** Wait for owner approval of the preview API proof.

### Stage 2 — Native state convergence and no-disappearing-content fix

**Goal:** Make native live, settle, poll, recovery and cold-load converge to the same canonical presentation.

**Required tasks**

1. Decode every V1 block and full usage field into typed native models.
2. Use stable block IDs from the server.
3. Store `turnId`, canonical server `messageId`, revision and event sequence in the native row state.
4. Reconcile the exact assistant message by ID/turn linkage, not last-row position.
5. Remove the verification-retry blanking behaviour.
6. Keep live prose visible, mark the earlier block superseded in data and show the existing truthful verification activity until final projection arrives.
7. Apply the canonical settled projection in one non-animated transaction.
8. Prevent quiet polling from replacing a newer/higher-revision row with an older/thinner one.
9. Ensure recovery and cold launch build the same `TurnBlock` representation as normal settle.
10. Store/display cache tokens and actual API rounds consistently with web.

**Tests that must pass**

- live → verification retry → final: no blank frame;
- live → settle: same visible-block fingerprint;
- settle → 60-second poll: same fingerprint;
- background/foreground: same fingerprint;
- kill/relaunch: same fingerprint;
- cold-open old conversation: same fingerprint;
- out-of-order/older revision is ignored;
- same reply remains visible after app scene transitions;
- 4 API rounds remain 4 on both clients.

**Mandatory proof**

- simulator video or timed screenshot sequence covering retry and settle;
- logs containing IDs/revisions only—never message text or secrets;
- before/after visible-block fingerprints;
- same-conversation screenshot after 0s, 15s and 60s;
- background/foreground and relaunch screenshot;
- iOS build and protocol/reducer test output;
- no server/model/tool execution duplication.

**Stop gate:** No renderer-formatting work until state convergence is approved.

### Stage 3 — Professional native reply renderer

**Goal:** Make reply formatting reliable and professional without changing the existing ALMA prose or page design.

**Required tasks**

1. Preserve the existing assistant prose font family, size, colour and width. Any typography change requires a separate screenshot comparison and explicit owner approval before implementation.
2. Preserve existing owner bubble typography.
3. Render semantic blocks with stable ordinal/server IDs—never content hash alone.
4. Support and test:
   - paragraphs and intentional blank spacing;
   - headings;
   - unordered and numbered lists;
   - nested lists;
   - bold, italic and inline code;
   - links;
   - block quotes;
   - fenced code/copy blocks;
   - compact horizontally scrollable tables;
   - mixed Bangla, Banglish, English, numbers and emoji.
5. Preserve the current chronological prose → activity/tool row → prose composition and current detail expansion behaviour.
6. Keep text selection/copy/listen features.
7. Respect Dynamic Type, Reduce Motion, light/dark mode and narrow iPhone widths.
8. Ensure streaming and settled text have matching width, font metrics and paragraph rhythm.
9. Cache parsed presentation by message ID + revision + content-size category + theme.

**Visual acceptance criteria**

- existing prose typography remains visually unchanged while Bangla/mixed-script wrapping is corrected;
- no orphan bullets or broken Bangla glyph clusters;
- no text underlap with composer/FAB/navigation;
- no duplicated or missing repeated paragraphs;
- long replies remain readable and selectable;
- layout remains the existing ALMA layout in both themes;
- changing only the message renderer must not move header/nav/composer geometry.

**Mandatory proof**

- screenshot matrix: light/dark × short/long × Bangla/mixed × list/table/code;
- overlay/diff proving header, composer and navigation frames did not change;
- Dynamic Type screenshots at default and one larger accessibility size;
- repeated-paragraph fixture screenshot;
- 100-scroll stress result with zero missing blocks/phantom gaps;
- real iPhone screenshot before approval.

**Stop gate:** Owner approves reply formatting before web convergence changes.

### Stage 4 — Web convergence on the same canonical projection

**Goal:** Prevent web from permanently displaying unverified drafts or diverging from native.

**Required tasks**

1. Make web consume V1 presentation blocks.
2. Keep legacy fallback during canary/rollback.
3. Render every intentional `timeline.text` entry as chronological prose with its canonical state.
4. Present verification/tool/reasoning through the current activity rows while retaining all work prose around them.
5. Use the same usage/footer semantics as native.
6. Preserve current web theme/layout and cards.

**Tests that must pass**

- web and iOS projection fingerprints are identical for every golden fixture;
- same final answer text and block order;
- same API-round count, tokens and cost;
- no deleted prose or duplicated final block after verification;
- old messages remain readable through fallback.

**Mandatory proof**

- side-by-side preview screenshots of the exact same conversation;
- machine-readable block/fingerprint comparison;
- Chrome live exercise on Vercel preview;
- web build/typecheck/tests;
- no unrelated ERP visual diff.

**Stop gate:** Owner approves cross-surface preview before rollout work.

### Stage 5 — Contract CI and regression prevention

**Goal:** Make this class of divergence impossible to merge silently.

**Required tasks**

1. Add a versioned JSON schema for persisted/presentation messages, separate from the SSE event schema.
2. Add server contract tests and web projection tests.
3. Add a real Swift unit test target or an equivalent blocking native assertion runner approved by the owner.
4. Validate shared golden fixtures on both platforms.
5. Expand iOS CI path triggers to include:
   - presentation schema/helper;
   - messages API route;
   - timeline producers/head loops;
   - web/native render adapters;
   - usage projection code.
6. Upload screenshots/logs on UI-test failure.
7. Add an invariant check/telemetry event for unknown presentation version/block type and revision rollback.

**Mandatory proof**

- demonstrate a deliberate incompatible fixture change fails CI;
- revert the deliberate break and show CI green;
- list exact blocking checks on the PR;
- show tests run because a server timeline producer changed.

**Stop gate:** No TestFlight/rollout until regression gates are green.

### Stage 6 — Real-device proof, canary and owner handoff

**Goal:** Prove the permanent result on the owner's actual iPhone without claiming success from simulator/build output.

**Required test matrix on one Vercel preview + one TestFlight build**

1. Simple personal question with no tools.
2. Tool-using office-status question.
3. Verification-retry turn.
4. Approval card turn.
5. Ask-card turn.
6. Artifact/file turn.
7. Long Bangla markdown reply.
8. Repeated paragraphs/list items.
9. Background mid-stream, then foreground.
10. Kill mid-stream, then relaunch.
11. Wait 60 seconds after settle.
12. Open the exact same conversation on Chrome and iPhone.

For each case record:

- conversation ID and message ID (safe identifiers only);
- preview commit SHA;
- TestFlight build number;
- web screenshot;
- iPhone screenshot;
- visible-block fingerprint;
- expected versus actual usage footer;
- PASS/FAIL with a one-line reason.

**Canary rules**

- Use an additive presentation version/feature flag for rollback.
- Do not delete legacy fields during the first release.
- On unknown/invalid V1 payload, fall back to legacy final content and log telemetry—never show blank content.
- Any disappearing content, duplicate permanent answer, usage mismatch or layout drift is an automatic rollout FAIL.
- Owner approval is required before main merge and production rollout.

---

## 7. Proof protocol — fake claims are forbidden

Claude Code must follow this protocol for every stage.

### 7.1 Claim-to-evidence table

Every final report must contain:

| Claim | Required evidence | Result |
|---|---|---|
| Code compiles | Exact build/typecheck command + exit code | PASS/FAIL |
| Tests pass | Test names/count + command + exit code | PASS/FAIL |
| Same content on web/iOS | Same message ID + visible-block fingerprints | PASS/FAIL |
| No flicker after settle | 0s/15s/60s screenshots or video | PASS/FAIL |
| Recovery stable | background + relaunch proof | PASS/FAIL |
| Formatting professional | required screenshot matrix | PASS/FAIL |
| No design change | frame/overlay comparison for locked UI | PASS/FAIL |
| Scope respected | `git diff --stat` + changed-file allowlist | PASS/FAIL |
| Preview tested live | Vercel preview URL + Chrome screenshot | PASS/FAIL |
| Real iPhone tested | TestFlight build + owner-device screenshot | PASS/FAIL |

### 7.2 Forbidden claims

Claude Code must not say any of the following without the matching evidence:

- “fixed” from code inspection alone;
- “permanent” from one simulator run;
- “iOS parity” without testing the same conversation/message ID on web and iOS;
- “no flicker” without a timed settle/poll/relaunch proof;
- “design unchanged” without visual frame/diff evidence;
- “all tests passed” without names, counts and exit codes;
- “production ready” before owner real-device approval;
- “done” while any required proof row is FAIL, missing or not run.

### 7.3 Honest status language

Use only these states:

- **DIAGNOSED** — root cause proven, no fix claim.
- **IMPLEMENTED, NOT VERIFIED** — code exists but live proof is incomplete.
- **PREVIEW VERIFIED** — automated checks + live Chrome/simulator proof complete.
- **DEVICE VERIFIED** — owner iPhone/TestFlight proof complete.
- **OWNER APPROVED** — owner explicitly approved merge/next stage.
- **BLOCKED** — exact missing access/state/evidence is named.

If a proof cannot be produced, the report must say **NOT VERIFIED**. It must not convert an assumption into PASS.

### 7.4 Screenshot authenticity

Every screenshot must include or be accompanied by:

- environment: preview or production;
- commit SHA/build number;
- conversation/message ID in the test log;
- timestamp;
- explanation of what is being proven;
- no unrelated old screenshot reused as current proof.

---

## 8. Required test fixtures

At minimum, maintain these sanitized golden fixtures:

1. `simple-final` — one final paragraph, no activity.
2. `thinking-tool-final` — thinking → tool → final.
3. `draft-verification-final` — draft → verification retry → final.
4. `status-tool-status-final` — intentional progress text distinct from answer drafts.
5. `cards-artifact` — confirm + ask + file ordering.
6. `usage-four-rounds` — cache write/read + 4 round costs.
7. `repeated-content` — identical paragraphs and list items at different ordinals.
8. `bangla-markdown-long` — headings, nested lists, quote, link, code, table, emoji.
9. `legacy-no-presentation` — old persisted message projected to V1.
10. `unknown-block-version` — safe fallback + telemetry.

Every fixture must define:

- canonical visible blocks;
- canonical plain-text copy/TTS output;
- usage totals;
- expected activity count and API-round count as separate concepts;
- accessibility label order where applicable.

---

## 9. Scope map

Expected areas, subject to Stage 0 confirmation:

### Server/contract

- `src/agent/lib/models/run-owner-turn.ts` — read/audit; change only if classification metadata is truly required.
- `src/app/api/assistant/conversations/[id]/messages/route.ts` — additive presentation output.
- new agent-owned pure presentation helper/schema/tests under `src/agent/`.
- `src/agent/protocol/` — separate persisted presentation schema.

### Web

- `src/agent/components/AgentThread.tsx`.
- `src/agent/components/AgentMarkdown.tsx` only if required for canonical blocks.
- relevant focused tests/fixtures.

### Native iOS

- `ios/App/App/AssistantSwiftUI.swift`.
- `ios/App/App/AssistantTransport.swift` only for typed contract data if necessary.
- extracted assistant presentation/model/renderer/test files if the stage prompt explicitly allows them.
- iOS project/test target files only in the CI/testing stage.

### CI/docs

- `.github/workflows/ios-simulator.yml`.
- this roadmap and stage reports.

### Explicitly out of scope

- `/api/agent/*`;
- ERP pages and financial logic;
- model selection/routing/cost policy;
- tool authorization or claim-verifier policy;
- memory behaviour;
- native shell/header/navigation/composer redesign;
- Android unless the owner separately requests parity there;
- production merge/deployment without owner approval.

---

## 10. Final definition of done

This program is complete only when every item is proven:

- [ ] Server emits one versioned canonical presentation for new and legacy messages.
- [ ] Every intentional work/progress prose segment remains visible in chronological order on both clients.
- [ ] Superseded prose remains visible but is truthfully distinguished from the verified final answer.
- [ ] Verification retry never blanks the native reply.
- [ ] Live, settled, 60-second poll, foreground recovery and cold launch have the same visible-block fingerprint.
- [ ] Same conversation/message renders the same final prose and block order on web and iOS.
- [ ] Web and iOS show identical token, cache, cost and API-round values.
- [ ] “Activity phases” and “provider API rounds” are no longer mislabeled as the same metric.
- [ ] Repeated identical paragraphs/list items never disappear.
- [ ] Bangla/Banglish wrapping, spacing and markdown pass the real-device screenshot matrix without changing the locked prose typography.
- [ ] Existing ALMA background/header/nav/composer/bubbles/cards remain visually unchanged.
- [ ] Text selection, copy, listen/TTS, cards, artifacts and tool details still work.
- [ ] Background, reconnect and kill/relaunch do not alter the settled presentation.
- [ ] Contract tests fail on incompatible server/client drift.
- [ ] CI runs for both client and server presentation changes.
- [ ] Vercel preview proof exists in owner Chrome.
- [ ] Real iPhone/TestFlight proof exists for the exact same conversation.
- [ ] Final claim-to-evidence table has no FAIL, missing or NOT RUN rows.
- [ ] Owner explicitly approves merge/rollout.

Until all boxes are proven, the correct status is **NOT DONE**.

---

## 11. Claude Code start instruction

When this roadmap is handed to Claude Code, the first session must execute **Stage 0 only**.

Claude Code must:

1. read `AGENTS.md` and this entire roadmap;
2. inspect the audited files and latest `origin/main` before making assumptions;
3. report any scope conflict before editing;
4. create the failing shared fixture/tests and baseline proof pack;
5. make no runtime fix in Stage 0;
6. stop and ask the owner to approve the target canonical presentation;
7. never move automatically to Stage 1;
8. never claim the issue is fixed from Stage 0 evidence.

The owner must see the failure reproduced and the target output agreed first. Only then may implementation begin.
