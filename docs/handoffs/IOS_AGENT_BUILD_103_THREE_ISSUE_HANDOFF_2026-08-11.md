# Native iOS Agent Chat — Build 103 Three-Issue Handoff

Date: 2026-08-11

Owner: Maruf Billah

Handoff branch: `codex/ios-agent-build-103-handover`

Base: `origin/main` at `e8399d9d3cb6971df867a69350563ad9e73e3692` (shipped TestFlight build 102 source)

Target device: iPhone 17 Pro Max, iOS 26.5

Implementation status of this branch: **documentation only**

## Executive decision

Build 102 is already on the owner's physical iPhone. The owner found three follow-up issues and asked for a deep implementation handoff for the next candidate:

1. Previous-session loading must never show the new-chat hero behind the restore loader.
2. The image approval card must gain a professional, immutable, provider-aware image setup selector: preset/aspect, size, quality, variation count, model, and truthful USD quote.
3. Complex Agent work must gain a truthful ChatGPT/Codex-style in-chat step tracker with live, replay, and cold-history parity.

The receiving session must verify the findings, implement all three as one Build 103 candidate, and show the owner exact iPhone 17 Pro Max Simulator evidence. It must **not** start a TestFlight build until the owner explicitly approves that exact candidate commit.

## Locked scope and non-goals

- Primary product scope is native SwiftUI Agent Chat under `ios/App/App`.
- Issues 2 and 3 require additive Agent/backend/worker contracts. Those changes are authorized because a native-only imitation would be race-prone or dishonest.
- Do not change the Web Agent UI as part of this handoff.
- Do not invent a mobile-only contract or infer configuration/status from prose.
- Do not globally mutate Creative Studio settings to simulate a per-card choice.
- Do not expose or claim raw private chain-of-thought. The tracker shows public work state and safe summaries only.
- Do not silently resize, downgrade, switch models, change variation count, or change price after approval.
- Do not archive, upload, or dispatch TestFlight before owner approval.

## Required non-regressions

All work must preserve the current production behavior for:

- thought, tool, subagent, approval, question, file, and prose chronology;
- provider parity across Auto, GPT-5.6 Luna, Claude, Gemini, and Qwen/OpenRouter;
- live thought-sheet updates without closing/reopening;
- context meter, token accounting, round cost, and settled-turn cost footer;
- queue/steer chronology and delivered state;
- draft recovery, selected-text reference, attachment recovery, and composer isolation;
- approval recovery, lost-response reconciliation, idempotent approve/retry, and queue durability;
- generated-image canvas, adjacent multi-image gallery, QC badges, shared swipe viewer, Save/Share/Copy/Edit/Variation;
- cold-loaded history matching the settled live presentation.

## Owner-supplied evidence

Local evidence available to the receiving session:

- `/Users/marufbillah/Downloads/IMG_0140.PNG`
- `/Users/marufbillah/Downloads/IMG_0141.PNG`
- `/Users/marufbillah/Downloads/ScreenRecording_08-11-2026 11-27-52_1.MP4`

`IMG_0140.PNG` is the definitive Issue 1 screenshot. It visibly contains the new-chat `AL [robot] MA` hero, greeting, and subtitle while a second animated session robot and `সেশন খুলছি...` are also present.

`IMG_0141.PNG` shows the current Build 102 image generation surface: selected GPT Image 2, four images, a USD estimate, and the large estimated-progress canvas. It is evidence for Issue 2's current baseline, not the duplicate-loader bug.

The 17.4017-second MP4 is the owner's visual reference for Issue 3. It does not reproduce Issue 1. Treat it as interaction intent for a compact numbered work-step surface, not as a protocol specification to copy blindly.

---

# Issue 1 — Previous session opens with two robots

## Verified root cause

This is a session-state ambiguity, not primarily an animation defect.

The current view model begins with all of these values:

- `conversationId == nil`
- `messages.isEmpty == true`
- `loadingHistory == false`

That state can mean either:

- a genuine new chat is ready, or
- the app has not yet resolved the active-conversation pointer/history.

The UI currently treats it as a genuine new chat and mounts `AgentEmptyStateView`. Later, an independent awakening model mounts the session loader, producing two robot owners.

### Exact current path

- Initial VM state: `ios/App/App/AssistantSwiftUI.swift` around 2378–2398.
- Bootstrap waits for `loadModels()` before `loadActiveConversation()`: around 3940–3947. Slow model loading extends the false-new-chat window.
- The empty-state condition is derived from nil conversation + empty messages: around 21554–21560.
- `AgentEmptyStateView` renders the greeting/subtitle and `AgentNewSessionHero`: around 18625–18684.
- The hero itself renders `AL + AgentCodexSpriteRobot + MA`: `ios/App/App/AgentAnimations.swift` around 294–312.
- A later screen task independently starts the awakening overlay: `AssistantSwiftUI.swift` around 22121–22135.
- The overlay is independently mounted around 21773–21781.
- The overlay renders a second loading robot and `সেশন খুলছি...`: `AgentAnimations.swift` around 865–894.
- Only after `/active-conversation` resolves does the app set the conversation ID and begin history loading: `AssistantSwiftUI.swift` around 4233–4242.

The previous loader fix correctly improved the drawer-switch path, but it did not eliminate the unresolved cold-bootstrap state. Build 102 therefore regressed at first render even though `openConversation(_:)` sets `loadingHistory` before clearing the timeline.

## Adjacent correctness risks that must be fixed with it

1. `loadMessages` captures a conversation ID before awaiting the network but does not re-check that the same conversation/request is still selected before merging. A late history response from Chat A can overwrite Chat B after a rapid switch.
2. `loadMessages` clears the shared `loadingHistory` flag in `defer`, even for non-spinner background loads. An old poll can clear a new foreground load.
3. `openConversation` marks restore ready even though `loadMessages` swallows ordinary transport failures. A failed request can dismiss the loader and leave a false blank state.
4. Initial bootstrap can mark the awakening model ready even when pointer/history resolution failed.

## Required design

Add one authoritative VM-owned session surface state. Suggested shape:

```swift
enum AgentSessionSurfaceState: Equatable {
    case resolvingInitialRoute(requestToken: UUID)
    case loadingHistory(conversationId: String, requestToken: UUID)
    case readyNew(sessionIdentity: String)
    case readyConversation(conversationId: String)
    case failedHistory(conversationId: String?, requestToken: UUID, message: String)
}
```

Exact names may change, but the semantics are locked:

- Initialize to `resolvingInitialRoute`, never an implicit new-chat state.
- While route/history is unresolved, render no new-chat hero/logo/greeting/suggestions/old timeline. Before implementation, verify the owner's exact preferred restore surface from the supplied screenshot: either a visually blank/tinted surface or exactly one selected restore indicator. Never show two robots, and do not show loading copy unless the owner confirms that copy belongs to the selected loader.
- Render `AgentEmptyStateView` only in `readyNew`, after the server authoritatively resolves that there is no active conversation or after the owner explicitly taps New Chat.
- During `resolvingInitialRoute` and `loadingHistory`, render no hero, greeting, suggestions, old timeline, or second loader.
- An existing conversation with zero messages is still `readyConversation`, never `readyNew`.
- Make the foreground history request carry both target conversation ID and a monotonic request token/session identity.
- Before merge, cache mutation, title/settings mutation, ready transition, or toast, verify that both target and token still match.
- Background polls must not own or clear the foreground session phase.
- `loadMessages` must return a typed success/failure outcome. Fire restore-ready only after the selected target successfully decodes and commits.
- On failure, show one compact retry surface for the selected target. Do not reveal the new-chat hero as a fallback.
- New Chat explicitly invalidates in-flight history tokens and enters `readyNew`.
- `bootstrap()` currently skips `loadActiveConversation()` when `shouldRestoreProvisionalSession` is true. That branch must explicitly enter the correct provisional `readyNew` state after restoring its scoped draft/attachments; it must never remain stuck in `resolvingInitialRoute`.
- Pending approval deep links and recoverable-turn descriptors must also invalidate/replace the initial request token before choosing their target session.
- Keep the existing message merge path as the canonical chronology path; do not create a second history renderer.
- If `AgentAwakeningModel` remains, derive it from the VM phase. Do not let `messages.isEmpty` become a second source of truth.

## Must-preserve ordering

- Persist the current draft before switching.
- Preserve `selectedSessionIdentity`, provisional drafts, recoverable turns, queued owner messages, and approval recovery.
- Do not let a stale response overwrite a provisional/new-chat draft.
- Do not show the previous conversation behind the loading overlay.
- A loader animation timeout may stop motion, but it must not claim that data is ready.

## Required tests

### Unit/state tests

1. Initial unresolved state with nil conversation and empty messages: restore phase true, hero false, and zero/one visible restore indicator according to the owner-confirmed design.
2. Delayed model load + delayed active pointer + delayed history: hero never appears before authoritative resolution.
3. Successful pointer `nil`: unresolved restore surface first, then exactly one genuine new-chat hero.
4. Existing zero-message conversation: ready conversation, no hero.
5. Rapid A → B switch where A returns last: A response is discarded and only B commits.
6. Background poll completion cannot clear B's foreground loading phase.
7. History failure: retry state remains tied to the selected chat; no fake ready/new state.
8. Retry succeeds and atomically commits the selected history.
9. New Chat invalidates in-flight history; a late response cannot replace it.
10. Cold history still preserves thought/tool/card chronology and settled cost footers.
11. Provisional-session bootstrap reaches its explicit ready state with draft and attachments intact.
12. Pending deep-link/recovery bootstrap invalidates the initial token and opens only its intended conversation.

### UI/accessibility tests

Add stable identifiers for the selected surfaces (the loader identifier is required only if the owner confirms a visible restore indicator):

- `agent.session.loader`
- `agent.empty.hero`
- `agent.session.load.failure`
- `agent.session.load.retry`

On the exact iPhone 17 Pro Max fixture:

- during route/history latency, assert hero/greeting do not exist and the verified restore surface contains at most one restore indicator;
- after history commits, assert restore indicator and hero are absent;
- for true new chat, assert the unresolved surface transitions to exactly one hero;
- test drawer new → existing, rapid A → B, and failure → retry;
- while loading, VoiceOver must expose at most one meaningful loading element according to the owner-confirmed restore design;
- if the selected design uses the pet, Reduce Motion must use one static pet; a confirmed blank surface remains blank.

## Issue 1 acceptance

- There is no video frame where `agent.empty.hero` and any restore indicator coexist, and never more than one restore indicator exists.
- During unresolved pointer/history, no ALMA new-chat hero, greeting, suggestion copy, loading copy not explicitly approved by the owner, or old/wrong timeline is visible.
- The hero appears only after the app knows it is a genuine new chat.
- Selected history appears atomically after a successful commit.
- Stale responses never land in the newly selected chat.
- Failure is honest and retryable without losing draft, selected chat, queue/steer, or approval recovery.

---

# Issue 2 — Professional image setup inside the approval card

## Current authoritative contract

The current backend already supports these render inputs when the agent first stages `generate_image`:

- `quality`: `standard | pro`
- `aspectRatio`: `1:1 | 4:5 | 9:16 | 16:9`
- `imageSize`: `1K | 2K | 4K`
- `count`: 1–4 distinct requested images
- allowlisted image model
- optional reference image

Relevant files:

- `src/agent/tools/confirm-tools.ts`
- `src/agent/lib/image-action-contract.ts`
- `src/app/api/assistant/actions/[id]/route.ts`
- `src/app/api/assistant/actions/[id]/approve/route.ts`
- `worker/src/index.mjs`
- `ios/App/App/AssistantTransport.swift`
- `ios/App/App/AssistantSwiftUI.swift`

Build 102 lets the owner change only the image model. The other values are hidden/locked to whatever the agent originally staged.

## Confirmed gaps

1. The card cannot edit preset/aspect, resolution tier, quality, or number of variants.
2. The selected aspect is not visible. The native generating canvas and single ready-image container remain visually hard-coded to 4:5, contradicting square, story, or landscape requests.
3. Quote v1 binds model/quality/size/count but omits aspect and exact dimensions. It is not a safe immutable quote for a future editable configuration.
4. GPT Image 2 pricing is currently flat by `standard/pro`, although the provider's current output price varies with quality and dimensions and total request cost can also include text/reference-image input tokens.
5. A multi-field editor needs a revisioned atomic compare-and-set. The current prior-model CAS alone cannot protect two-device or edit-vs-approve races.
6. `quality` has provider-specific meaning. Do not imply that every provider supports the same vendor quality switch.
7. A failed render retry must clone the exact pinned configuration and open a fresh approval; it must not silently re-run paid work.

## Official provider research boundary

- OpenAI's current GPT Image 2 guide supports many valid dimensions, with explicit edge, multiple-of-16, aspect, and pixel-count limits. Quality supports low/medium/high/auto, and pricing varies by quality/dimension. See [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation) and [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2).
- Google documents a larger enumerated aspect set and exact 1K/2K/4K dimensions for Nano Banana models. See [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation) and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
- fal documents Seedream 5 Pro's predefined/custom size contract, total-pixel/aspect limits, and `num_images`. See [Seedream 5 Pro API](https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image/api).

Provider capabilities must be resolved on the server from the exact enabled worker/model. The mobile app must never hard-code a choice as available merely because another provider supports it.

## Locked preset taxonomy

Initial professional card presets:

| Stable ID | Owner-facing label | Generation aspect | Rollout |
|---|---|---:|---|
| `square` | Square | `1:1` | Existing contract |
| `social_post` | Facebook / Instagram post | `4:5` | Existing contract |
| `reel_story` | Reel / Story | `9:16` | Existing contract |
| `landscape` | Landscape / banner | `16:9` | Existing contract |
| `poster` | Portrait poster | `2:3` | Add server/worker capability tables first |
| `custom` | Custom dimensions | provider-gated | Advanced follow-up; never universally enabled |

The card must distinguish:

- **aspect/preset** — the composition shape;
- **resolution tier** — ALMA's 1K/2K/4K semantic tier, resolved server-side into the selected provider's exact request/dimensions;
- **variation count** — 1–4 separately generated candidates.

Do not claim an exact platform export such as 1080×1350 unless the saved artifact is actually delivered at that exact size. For launch, show both semantic preset and exact server-resolved generation dimensions, for example `Social post · 4:5 · 1856×2304`. A future deterministic export/crop layer may offer exact platform-pixel downloads separately.

## Required additive persistence and wire contract

Add nullable fields to `AgentPendingAction` so existing cards require no backfill:

- `imageConfig Json?`
- `imageConfigRevision Int @default(0)`

For a v2 action, `imageConfig` is the canonical pending selection. The existing loose fields inside `payload` are a backward-compatible mirror only. Every v2 stage/edit must write both atomically; approval must compare the mirror/fingerprint to the canonical config and fail closed on divergence. After approval, the worker payload is derived from the canonical config snapshot. A legacy action with `imageConfig == null` continues through the existing v1 path. Do not allow two independently mutable JSON sources.

Suggested canonical config:

```json
{
  "version": 1,
  "presetId": "social_post",
  "sizeMode": "tier",
  "aspectRatio": "4:5",
  "imageSize": "2K",
  "width": 1856,
  "height": 2304,
  "quality": "standard",
  "providerQuality": "medium",
  "variationCount": 4,
  "pipelineMode": "preview"
}
```

The server, not Swift, derives aspect and exact dimensions from preset + model + tier. `custom` is the only mode that accepts owner-supplied width/height, and only after provider validation.

Add quote v2 bound to the complete immutable render selection:

- model and provider;
- preset and aspect;
- exact width/height and tier;
- owner quality plus actual provider-quality mapping;
- variation count;
- preview/production QC attempt ceiling;
- canonical config fingerprint;
- USD min/max, pricing basis, verification date, priced-component breakdown, and explicit exclusions.

For GPT Image 2, explicitly state whether prompt text tokens and reference-image input tokens are included. If the worker cannot obtain/provider-price those components, exclude and label them rather than presenting output-only cost as full provider spend or invoice truth. Settled receipts must include provenance such as provider usage vs internal output-rate estimate.

Keep Build 102 compatibility during rollout:

- preserve the existing `imageModelSelection` and quote-v1 projection;
- add a separate `imageRenderSelection` v2 object;
- new native code consumes v2 when present and safely falls back to the existing read-only v1 card;
- do not replace v1 in place because the Build 102 decoder validates version 1.
- an installed Build 102 may still POST `{imageModel}`. Route that legacy edit through the same v2 canonical CAS, increment the revision, mirror the payload, and requote; if that cannot be done safely, return a non-mutating upgrade/conflict response. It must never bypass a concurrent v2 edit or approval claim.

Suggested v2 projection:

```json
{
  "contractVersion": 2,
  "revision": 3,
  "selectedModel": "gpt-image-2",
  "config": {},
  "modelOptions": [],
  "presetOptions": [],
  "sizeOptions": [],
  "qualityOptions": [],
  "countOptions": [1, 2, 3, 4],
  "quote": {}
}
```

Project the same authoritative structure through:

- live `confirm_card` SSE;
- cold conversation messages;
- action list/detail;
- retry response and rehydrated fresh card.

## Atomic edit/approve contract

Extend the existing action update endpoint rather than creating a mobile-only route:

```json
{
  "imageConfig": {
    "expectedRevision": 3,
    "imageModel": "gpt-image-2",
    "presetId": "social_post",
    "imageSize": "2K",
    "quality": "standard",
    "variationCount": 4
  }
}
```

Server behavior:

1. Authenticate owner and load the pending image action.
2. Validate fresh worker capability/kill switches.
3. Derive canonical config and exact dimensions.
4. Validate model × preset × size × quality compatibility.
5. Recompute model options and authoritative quote.
6. CAS on `status=pending`, `approvalClaimedAt=null`, and `imageConfigRevision=expectedRevision`.
7. Atomically write config, revision + 1, model, quote, fingerprint, and summary.
8. Return only the authoritative server echo.
9. On conflict, return 409 with the current projection so native can reconcile.
10. On unsupported input, return a field-specific 422 and make no mutation.

Legacy model-only requests without `expectedRevision` must still snapshot the currently read revision and CAS on that exact value plus the current model/claim state. A concurrent v2 edit therefore wins or loses atomically; it cannot be partially overwritten.

Approval must claim the same row, re-read revision/fingerprint/capability, and snapshot the canonical model/config/quote into the worker payload in the same transition. Whichever wins first—edit or approval—must exclude the other. No paid queue entry may be created from a half-updated selection.

The worker must independently re-derive and verify the config fingerprint and decoded artifact dimensions before reporting success. Unsupported/mismatched config must fail before provider spend where possible; never silently downgrade.

Retry must:

- leave the failed card terminal;
- idempotently create/reuse one fresh pending card;
- copy exact model/config/quote/fingerprint;
- never auto-approve or auto-run;
- allow the owner to edit the fresh card before approving.

## Safe rollout and rollback order

1. Apply the additive migration first and verify the new columns.
2. Deploy a backward-compatible server that dual-reads/dual-writes v1/v2 but does not advertise v2 yet.
3. Deploy a worker capability-receipt version that proves canonical config/fingerprint and each advertised preset/tier.
4. Enable server v2 staging/projection behind `agent_image_controls_v2` only when the live worker receipt is fresh and compatible.
5. Ship the new native decoder/editor; Build 102 remains operable through the legacy projection/edit path.
6. Enable native v2 presentation for new cards after live/cold/retry verification.
7. Rollback disables new v2 staging first; already-pinned v2 cards remain readable/approvable/retryable from their immutable snapshots.

Never advertise `poster`, `custom`, or another model/preset merely because source code supports it. The live worker capability receipt must prove the exact config version and option before the card enables it.

## Native card UX

The pending image card should contain one compact `Image setup` summary:

- preset + aspect;
- resolution tier + exact pixels;
- number of variants;
- image model/provider;
- truthful USD estimate/range and exclusions.

Tapping it opens a native sheet with:

- visual preset chips;
- resolution choices supported by the selected model/preset;
- 1–4 variant choices;
- provider-authored quality description;
- model list with disabled reasons;
- live authoritative quote after each server-accepted change.

Rules:

- Apply selection only after the server echo; no optimistic fake lock.
- Disable Approve while a config mutation is unresolved.
- Disabled combinations remain visible with a reason.
- After approval, show the pinned setup read-only on generating, executed, failed, and cold-loaded cards.
- Drive generating and single-ready media aspect from the pinned config with a bounded phone height.
- Keep adjacent gallery and shared viewer behavior. The viewer uses the real artifact ratio.
- VoiceOver reads preset, ratio, exact pixels, count, model, and estimate.
- Grok remains disabled/omitted from this generic adjacent multi-image lane until the backend and worker support the same immutable payload/result/QC semantics. Do not route it through mutable Creative Studio settings.

## Issue 2 required tests

### Server/worker

- Exhaustive model × preset × tier × quality capability matrix.
- Quote/fingerprint changes for every priced input, including aspect and exact dimensions.
- Current official pricing fixtures with verification dates.
- Edit-vs-approve and two-device revision races.
- Stale/missing worker receipt fails closed without losing the pending card.
- 409 reconciliation and field-specific 422 behavior.
- Approval queues exactly once from the accepted revision.
- Worker rejects config/fingerprint/dimension mismatch.
- Retry copies exact config once and never auto-spends.
- Live, cold, list, and detail projections are byte-semantically equivalent.
- v1 cards/history remain valid during dual-projection rollout.

### Native/UI

- v1-only, dual-v1/v2, malformed-v2, and unknown-future-field decoding.
- Server-echo-only selection changes and lost-response reconciliation.
- Approve disabled while editing and read-only locked setup afterward.
- 1:1, 4:5, 9:16, 16:9, and new 2:3 visual snapshots.
- 1, 2, 3, and 4 adjacent variants; one shared viewer.
- Dynamic Type, VoiceOver, Reduce Motion, light/dark.
- Failure → direct fresh-card Retry without losing chat/draft or duplicating spend.

## Issue 2 acceptance

- Before approval, the owner can choose supported preset/size/quality/count/model in one professional surface.
- The exact ratio and server-resolved pixels are visible and remain locked in history.
- Every accepted edit revalidates compatibility and requotes atomically.
- No silent model/size/aspect/count/quality change occurs.
- The preflight label is an estimate; the settled receipt labels its provenance and priced components, and does not overclaim output-only estimates as full provider spend, invoice, input-token, or QC totals.
- 1–4 requested images arrive adjacent in one gallery and swipe in one viewer.
- A failed job produces a truthful error and one idempotent fresh approval retry; no paid render is duplicated or left indefinitely queued.

---

# Issue 3 — Truthful in-chat work step tracker

## Official product boundary

[OpenAI's long-running work documentation](https://learn.chatgpt.com/docs/long-running-work) says multi-step work should have clear outcomes/completion criteria, remain steerable in the same chat, and expose goal progress controls such as pause/resume/edit/clear. It does **not** publish a private numbered-step UI schema that ALMA can copy as an API contract.

[OpenAI's streaming documentation](https://developers.openai.com/api/docs/guides/streaming-responses) uses typed semantic events. [Background mode](https://developers.openai.com/api/docs/guides/background) distinguishes queued/in-progress from terminal states. [Reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning) exposes an optional reasoning **summary** only when explicitly requested; it does not authorize presenting raw hidden reasoning.

Therefore ALMA's implementation must use server-authored, typed, durable work-state events. It should be labeled `Work steps` / `কাজের ধাপ`, not `private thinking` or `chain of thought`.

## Current truthful infrastructure

The backend already has useful pieces:

- `progress_update` — provider-neutral factual progress headlines;
- `plan_progress` — durable `AgentPlan` checklist projection;
- `turn_progress` — long-running/silent-turn status;
- typed thought, tool/subagent, approval/question, skill, steering, retry, done, and error events;
- durable sequence-numbered event persistence and replay.

Primary files:

- `src/agent/lib/models/visible-progress.ts`
- `src/agent/lib/plan-progress.ts`
- `src/agent/lib/turn-progress.ts`
- `src/agent/lib/core.ts`
- `src/agent/lib/turn-events.ts`
- `src/app/api/assistant/turn/[id]/stream/route.ts`
- `src/app/api/assistant/conversations/[id]/messages/route.ts`
- `src/agent/protocol/agent-event.schema.json`
- `ios/App/App/AssistantTransport.swift`
- `ios/App/App/AssistantSwiftUI.swift`

Native already renders chronological activity and a settled activity sheet, but it is not a durable step tracker. It currently drops `plan_progress` and `turn_progress` as unknown events.

## Confirmed gaps

1. Native transport/reducer does not decode `plan_progress` or `turn_progress`.
2. The canonical JSON schema is behind runtime and omits several already-emitted event types, including plan/turn progress.
3. Cold history does not contain a canonical plan/turn tracker snapshot, so live and reloaded history cannot match.
4. Current plan selection can attach the latest non-abandoned conversation plan without an exact turn/run link.
5. Initial and terminal plan snapshots are not guaranteed.
6. Visible title/goal edits may not revise the current signature.
7. One path appears to emit `skill_held_back` twice; fix source duplication and keep reducers idempotent.
8. The optional legacy Anthropic loop lacks the same progress instrumentation as unified orchestration.

## Required additive event

Prefer a full authoritative snapshot over fragile partial patches:

```json
{
  "type": "work_steps_snapshot",
  "version": 1,
  "trackerId": "stable-logical-task-id",
  "originTurnId": "origin-turn-id",
  "currentTurnId": "continuation-turn-id",
  "turnIds": ["origin-turn-id", "continuation-turn-id"],
  "conversationId": "conversation-id",
  "originAssistantMessageId": null,
  "revision": 7,
  "source": "agent_plan",
  "sourceId": "plan-or-workflow-id",
  "goal": "Prepare the requested deliverable",
  "status": "waiting_owner",
  "headline": "Waiting for image approval",
  "blockedBy": {
    "kind": "approval",
    "refId": "approval-id"
  },
  "retryRef": null,
  "steps": [
    {
      "id": "stable-step-id",
      "position": 1,
      "title": "Inspect the request",
      "status": "completed",
      "toolCallIds": [],
      "startedAt": "2026-08-11T00:00:00Z",
      "finishedAt": "2026-08-11T00:00:03Z"
    }
  ],
  "updatedAt": "2026-08-11T00:00:03Z"
}
```

Overall states:

- `preparing`
- `running`
- `waiting_owner`
- `waiting_worker`
- `paused`
- `completed`
- `failed`
- `cancelled`

Step states:

- `pending`
- `running`
- `waiting_owner`
- `waiting_worker`
- `completed`
- `failed`
- `cancelled`
- `skipped`

Blocker kinds:

- `approval`
- `question`
- `model_switch`
- `worker`
- `queue`
- `global_pause`

Do not show an estimated percentage. The card may show evidence-derived counts such as `2 of 5 complete`. It may claim 100% only when the authoritative overall state is `completed`.

## Truth/source precedence

1. `AgentPlan` / `AgentPlanStep` for explicit plans.
2. `WorkflowRun` / durable workflow events for structured workflows and gates.
3. A factual runtime projector for unplanned turns.

Allowed evidence:

- persisted owner request accepted;
- actual tool start/end;
- approval, question, or model-switch gate;
- worker enqueue/start/result;
- verification retry;
- persisted assistant response;
- terminal done/error/cancel/pause/resume.

Never complete a step from:

- prose promises;
- `thinking_delta`;
- elapsed time;
- estimated percentage;
- tool selection before execution.

For unplanned work, append steps only as real actions begin or use honest macro phases such as Accepted, Preparing, Executing, and Delivering. Do not invent a fixed numbered plan after the fact. Trivial one-answer turns should not show a tracker unless the server emits one.

## Linkage, persistence, and reconciliation

- Persist `trackerId`, exact turn/conversation/message linkage, revision, source ID, and final snapshot.
- Initial live revisions are anchored by `trackerId + originTurnId`; `originAssistantMessageId` is nullable because the canonical assistant message may not exist until settlement. A later persisted revision binds that message ID and reparents/reconciles the same native block instead of creating another tracker.
- After binding, `originTurnId` and `originAssistantMessageId` anchor the canonical chronological block. `currentTurnId` and an ordered turn chain describe approval/model/worker continuations without pretending one turn owns the whole task.
- An old plan must never attach to a new request merely because it is the latest conversation plan.
- Emit initial, changed, blocker, resume, and terminal snapshots.
- Return the same tracker structure in cold history/presentation.
- Cold load may overlay a newer durable source state only when exact tracker linkage matches.
- Add native typed decoding and a first-class chronological `TurnBlock`/presentation block.
- Apply only higher revisions.
- Same revision + same payload is a no-op.
- Same revision + different payload is protocol-error telemetry.
- Terminal state cannot regress to running from replay/poll overlap.
- Hot stream, replay, polling fallback, and cold load choose the highest authoritative revision.
- Approval continuation updates the same logical tracker and turn chain, or explicitly declares a new linked tracker with `continuationOf`. It must never silently create an unrelated duplicate.
- Queue/steer may change delivery/blocking state, never imply completion.
- Approval/question cards remain the interactive source; a waiting step deep-links to the existing card rather than duplicating controls.
- Activity/tool chronology remains evidence/detail and must not be duplicated verbatim inside every step row.

Update the canonical runtime union, JSON schema, route serializers, persistence, Swift wire decoder, reducer, cold projection, and protocol-drift tests together. Zero tracker events may arrive as `unknown` in an accepted candidate.

## Native UI contract

Use one canonical turn-owned SwiftUI block anchored to the tracker origin. While that tracker is active, the composer area may show a lightweight dock projection of the **same tracker store** (matching the owner's video). The dock is navigation/summary only, not a second state machine or duplicate set of approval/retry controls. Settled/cold chronology remains owned by the in-turn block.

The canonical block/dock projection should provide:

- goal/headline;
- honest summary such as `2 of 5 steps`;
- numbered rows with explicit status icon and text;
- one clearly active step;
- expand/collapse for detail after settlement;
- waiting-owner row opens the existing approval/question/model-switch card;
- failed row is retryable only when the snapshot carries a typed `retryRef`/capability for an existing image, turn, or card retry contract. Otherwise it is read-only and may deep-link to the existing failure/card. There is no generic step-retry API to infer;
- pause/resume state reflects existing authoritative controls;
- no duplicate cost footer or separate tool log.

### Owner video visual intent

The 17.402-second reference recording shows a lightweight, bottom-anchored tracker rather than a modal:

- A persistent strip sits immediately above the composer with three compact pills: goal/status, `1 of 5`, and agent count.
- The center progress pill expands/collapses a rounded panel while the conversation and composer remain visible.
- The expanded panel contains a directly numbered five-step list with multiline titles and no redundant header.
- Its content scrolls independently inside a compact viewport; the underlying chat does not move.
- The active row has an animated partial-ring indicator while pending rows remain quiet empty circles.
- A separate live activity headline changes while the authoritative tracker remains `1 of 5`. Keep factual live activity separate from step completion state.
- Expand/collapse completes in roughly 250 ms in the sampled frames and is reversible.

The recording does **not** prove a completed step, approval/retry/error behavior, cold-load persistence, accessibility, or any hidden reasoning. Those must come from the typed contract and tests, not visual inference. ALMA may use the same compact interaction pattern while keeping the tracker chronologically associated with the correct turn and preserving the composer/status strip.

Animation rules:

- animate only the active state when Reduce Motion is off;
- do not use color alone;
- do not animate completed rows repeatedly after cold load;
- preserve VoiceOver focus by stable step IDs;
- announce only meaningful current-step/status changes, not every replay.

Accessibility:

- 44-point controls;
- unrestricted Dynamic Type wrapping outside fixed media;
- combined label such as `2 of 5 completed; step 3 running`;
- mixed Bangla/English labels;
- light/dark, Reduce Motion, and VoiceOver coverage.

The owner's video is a visual reference for compact numbered progress and live checkmarks. ALMA's actual rows must remain driven by the durable contract above, not animation timing or inferred model behavior.

## Issue 3 required tests

### Server/protocol

- Runtime union, JSON schema, route envelope, persistence, and Swift decoder synchronization.
- Projectors for plans, workflows, and unplanned turns.
- Exact plan/turn linkage; stale plan cannot attach.
- Origin/current turn-chain and assistant-message anchoring across approval/worker continuation.
- Initial snapshot without message ID → terminal bound snapshot → force reload produces one identical tracker, never two.
- Initial, changed, blocker, resume, and terminal snapshots.
- Tool, approval, question, model switch, queue, worker, verification, failure, cancel, pause/resume transitions.
- No speculative completion and no terminal regression.
- Reconnect/replay overlap, polling fallback, compaction, and approval continuation.
- Live final snapshot equals cold history.
- Privacy assertion: event contains no raw reasoning, prompt, or hidden-chain field.
- Unified and legacy provider paths produce the same semantics or the legacy path is disabled for this feature.

### Native/UI

- Typed snapshot decoding with unknown future fields.
- Monotonic revision merge and terminal dominance.
- Live/replay/cold visual equality.
- Correct chronology with cards, tools, skill state, steering, and settled cost.
- Waiting-owner navigation and supported retry behavior.
- Active composer dock and canonical in-turn block read the same tracker state and never duplicate controls.
- Simple one-answer turn shows no speculative tracker.
- VoiceOver labels, Dynamic Type, Reduce Motion, and focus retention.

## Issue 3 acceptance

- A complex task visibly updates its current step without closing/reopening the chat.
- Cold-loaded history looks like the settled live tracker.
- Every visible completed step has durable evidence.
- Auto, GPT-5.6 Luna, Claude, Gemini, and Qwen/OpenRouter share the same tracker semantics.
- Waiting for approval/question/worker and failed/retry states are explicit and navigable.
- No raw hidden chain-of-thought claim appears.
- Zero `work_steps_snapshot` events decode as unknown.
- Existing activity chronology and the settled cost footer remain intact.

---

# Combined implementation order

The three issues must be integrated deliberately, not implemented as disconnected UI patches.

1. Record a clean Build 102 baseline on the exact iPhone 17 Pro Max Simulator.
2. Add Issue 1's explicit session surface state and stale-request guards.
3. Prove cold/drawer/failure loading before touching the approval UI.
4. Add Issue 2's schema migration, canonical config resolver, quote v2, dual projection, revisioned CAS, approval snapshot, and worker validation.
5. Add Issue 2 native decoder/editor/aspect-aware canvas and gallery presentation.
6. Add Issue 3 exact tracker linkage, typed snapshot projector, persistence, replay, and cold projection.
7. Add Issue 3 native decoding/reducer/card and accessibility behavior.
8. Run focused server/worker/native tests, then broad Agent/type checks.
9. Verify the provider matrix and cold/live equivalence.
10. Install one combined Debug candidate on the exact iPhone 17 Pro Max Simulator.
11. Capture owner-facing screenshots and continuous recordings.
12. Report exact branch, commit, migration, changed files, tests, provider outcomes, screenshots, recordings, and known hardware-only checks.
13. Ask the owner to inspect that exact SHA.
14. Only after explicit approval, bump from build 102 to build 103, merge through the required PR/checks, and dispatch the GitHub TestFlight workflow once from current `main`.

## Mandatory verification matrix

### Static/server/worker

- `git diff --check`
- `npx prisma generate`
- `npx prisma validate`
- `npm run type-check`
- `npm run test:agent`
- focused action/config/approval/retry/worker/protocol tests added by this work
- worker Node tests for dimension, queue, retry, QC, and terminal delivery
- migration execution + schema smoke in release readiness

### Native

- Swift parse for every changed Swift/test file
- `build-for-testing` from `ios/App/App.xcworkspace`
- focused unit and UI suites
- broader Agent parity suite after focused tests are green
- no simultaneous manual `simctl` launch while XCTest owns the device

### Provider matrix

- Auto
- GPT-5.6 Luna
- Claude
- Gemini
- Qwen/OpenRouter

Each must prove:

- the same image approval/config contract;
- the same step tracker semantics;
- no unknown protocol events;
- live updates and cold-load match;
- cost footer remains on every settled billed turn.

### Image provider matrix

For every enabled image provider/model:

- validate every advertised preset/tier combination;
- generate exact server-resolved dimensions;
- prove 1 and 4 variants;
- prove adjacent gallery and shared viewer;
- prove worker failure → fresh approval retry;
- prove no stuck queue or duplicate paid render.

## Required iPhone 17 Pro Max evidence before owner approval

1. Cold launch into an existing chat: owner-confirmed unresolved surface, no hero, never two robots.
2. Drawer switch to another previous chat under artificial latency.
3. History failure and Retry.
4. True New Chat transition to exactly one hero.
5. Pending image setup sheet showing model/preset/size/quality/count/quote.
6. Locked generating card using the selected aspect.
7. Four adjacent ready images, QC labels, shared swipe viewer, and actions.
8. Failed image job with direct idempotent fresh-card Retry.
9. Live complex task with numbered step transitions.
10. Waiting-approval step, approval, and resumed same tracker.
11. Settled tracker, then force quit/relaunch showing identical cold history.
12. Dynamic Type, VoiceOver, Reduce Motion, light/dark screenshots.

No iPad evidence substitutes for the iPhone 17 Pro Max gate.

## Stop conditions

Do not ask for TestFlight approval if any of these remains true:

- hero and loader can coexist;
- a stale history response can overwrite the selected chat;
- image selection can race approval or change without a new quote;
- an advertised preset silently downgrades or produces wrong dimensions;
- a failed image can remain indefinitely approved/queued without recovery;
- retry can duplicate provider spend;
- tracker live/cold state differs;
- a completed step lacks durable evidence;
- tracker events arrive as unknown;
- provider semantics differ without an explicit supported reason;
- cost footer, queue/steer, draft, or approval recovery regresses;
- the owner has not reviewed the exact simulator candidate SHA.

## TestFlight gate

Only after the owner approves the combined simulator candidate:

1. Finish PR review and required checks.
2. Merge the exact approved source to current `main`.
3. Confirm production migration/readiness and live worker capability from the same SHA.
4. Bump all App/widget `CURRENT_PROJECT_VERSION` values and workflow default from 102 to 103 in one release commit.
5. Push the release commit.
6. Dispatch `.github/workflows/ios-testflight.yml` with `expected_build=103` once.
7. Monitor every readiness, archive, upload, and App Store Connect processing step to terminal success.
8. Do not create a second upload for the same build.

## Receiving-session first instruction

The receiving session should begin with:

> Read this handoff completely, inspect all three owner evidence files, verify every cited code path and current API contract before editing, then implement Issues 1–3 as one Build 103 candidate. Keep Web UI unchanged. Preserve all listed native parity/recovery features. Use only iPhone 17 Pro Max for final simulator proof. Show the owner the exact candidate evidence and ask permission before any TestFlight build.
