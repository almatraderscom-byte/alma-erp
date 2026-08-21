# iOS Live Voice — Claude Independent Verification and Full Recovery Handoff

**Handoff date:** 2026-08-11 (Asia/Dhaka)

**Audience:** Claude or any senior implementation agent taking over ALMA ERP iOS Live Voice

**Status:** Recovery handoff and acceptance contract. The current voice implementation is **not release-ready**.

**PR scope:** Documentation only. This handoff does not merge, deploy, upload TestFlight, or approve production behavior.

## 0. Read this first

Do not assume that prior implementation decisions are correct. Independently reproduce, inspect, and verify every material claim in this document against:

1. the current repository and Git history;
2. current official Google Gemini and Apple documentation;
3. an exact iPhone 17 Pro simulator run for UI/layout/cache/contract checks;
4. a real iPhone for microphone, acoustic echo, barge-in, background, lock, audio-route, and CallKit claims;
5. the owner's observed behavior, which overrides simulator-only success.

The owner has reported multiple regressions after broad edits. Do **not** continue random threshold tuning or layer another large patch on the existing dirty voice worktree. Preserve it as evidence, start from the current `origin/main`, and recover the product in small, independently gated slices.

This document supersedes any earlier status claim that conflicts with the owner's latest real-iPhone evidence. The earlier 721-line audit remains valuable as the original professional contract and must also be read from the preserved local branch:

```sh
git show codex/ios-live-voice-professional:docs/handoffs/IOS_LIVE_VOICE_PROFESSIONAL_AUDIT_2026-08-08.md
```

At the time of this handoff, that branch has not been pushed to GitHub. It exists locally in:

```text
/Users/marufbillah/alma-erp-ios-live-voice-professional
```

## 1. Authority, permissions, and hard safety boundaries

The owner authorizes scoped local implementation of Phases 0–5 after independent verification. Routine read, build, test, edit, and local-commit commands do not require repeated permission.

Explicit owner approval is still required before any of the following:

- TestFlight upload;
- production deployment;
- merge;
- push to `main`;
- real production approval or ERP mutation;
- destructive operation;
- external paid bulk audio generation.

Never submit a real approval while testing. Prefer fixed, non-sensitive test phrases and read-only ERP tools. Preserve unrelated and uncommitted user changes.

## 2. Owner's non-negotiable product contract

### 2.1 Voice entry and settings

- Tapping the primary Live Voice button must open the voice conversation flow, as it did before the regression.
- It must **not** replace call entry with a settings-only screen.
- Model/voice settings must remain reachable before a call and from a safe settings control during the call.
- Opening settings must not silently start a call.

### 2.2 Exact model/voice preview

- Tapping a model card selects the draft model and immediately auto-plays the exact preview for that model plus the current draft voice.
- Tapping a voice card selects the draft voice and immediately auto-plays the exact preview for the current draft model plus that voice.
- The same screen must show a 2–5-line Bengali sample and evidence-based model strengths, limitations, cost/lifecycle label, and best-use guidance.
- Preview must require no new Gemini Live session, call, reconnect, or generation request.
- The catalog must cover exactly 2 models × 6 voices, be versioned and checksum-verified, and support bundled/CDN/disk cache behavior.
- Repeated preview must be a cache hit and incur zero new Gemini generation cost.
- Active-current-call, selected draft, and saved-for-next-call profiles must be distinct states.
- The active session must not change until **Apply to current call** is tapped.
- Apply must be transactional. If the new setup fails, roll back to the previous active profile.
- Rapid tap, cancellation, offline use, corrupt cache, audio interruption, VoiceOver, Dynamic Type, and active-call safety must be tested.

### 2.3 Conversation behavior

- The first natural utterance after readiness must be captured once, promptly, without requiring two to four repetitions.
- The UI may show listening only when the audio graph and transport can actually deliver input.
- A decorative mic glow must never be presented as proof that Gemini received or transcribed speech.
- Short, quiet, long, hesitant, distant, and Bengali/Banglish utterances must work without truncating the first syllable.
- While the owner speaks, the existing orb should listen calmly.
- Only while the agent speaks should the existing orb animate with natural speech-synchronous energy. Keep the current ALMA colors/design; do not imitate proprietary ChatGPT assets or claim an undocumented official motion specification.
- Smooth playback, long responses, transcripts, speaker/receiver behavior, CallKit, tool results, approval safety, and cost tracking must not regress while fixing input.

### 2.4 Work/tool behavior

- When the agent needs ERP data or an action, it must emit the correct provider function call; saying “দেখছি” or “কাজ করছি” without a tool call is not success.
- The UI enters real work mode only from real tool state, not from spoken promises or synthetic timers.
- Both advertised Live models must have the same safe tool contract unless current official capability requires a documented difference.
- Tool call ID and invoked function name must be preserved exactly in every response.
- Multiple calls, interruption/cancellation, reconnect, replay, late completion, duplicate delivery, and tool-only/no-audio turns must be deterministic and exactly-once.
- All mutating operations remain approval-gated. Real approval submission is forbidden during testing.

### 2.5 Background, Lock Screen, CallKit, and Dynamic Island

- Foreground, Home-screen background, lock, unlock, audio interruption, route change, incoming CallKit, reconnect, and stop/end must follow one explicit state contract.
- Entitlements or `UIBackgroundModes` alone are not proof that microphone capture or WebSocket delivery survives.
- Dynamic Island/Live Activity must show truthful, glanceable state. It must not fake a realtime waveform when ActivityKit cannot receive realtime PCM updates.
- Sensitive transcript/reply text must be private by default on the Lock Screen.
- Actual PCM-synchronous animation belongs in the foreground app.

## 3. Repository and snapshot inventory

### 3.1 Current clean recovery baseline

Verified on 2026-08-11 after `git fetch origin --prune`:

```text
Repository:      /Users/marufbillah/alma-erp
Remote:          https://github.com/almatraderscom-byte/alma-erp.git
Default branch:  main
origin/main:     1a51f0356ecce2c9e26a5a5a4281a8409cf2d0d2
```

The documentation PR containing this file was created from that `origin/main`. Re-verify because the remote may have moved.

### 3.2 Preserved implementation worktree

```text
Worktree: /Users/marufbillah/alma-erp-ios-live-voice-professional
Branch:   codex/ios-live-voice-professional
HEAD:     eb3d63aec14e6916c308e76b45141f96ae331f30
State:    12 commits ahead and 32 commits behind origin/main at handoff time
```

The branch began from the build-100-era tree, not today's main. Build 100 remains a reproduction reference, not a safe source baseline for new implementation.

### 3.3 Uncommitted voice work — preserve, do not blindly ship

The preserved voice worktree has a large dirty diff:

```text
7 tracked files changed
1 new test directory
1,691 insertions
351 deletions
```

Dirty paths at handoff time:

```text
M  ios/App/App/AssistantVoiceSwiftUI.swift
M  ios/App/AppParityV2Tests/AssistantParityV2Tests.swift
M  ios/App/AppParityV2UITests/AssistantParityV2UITests.swift
M  src/agent/lib/__tests__/live-voice-config.test.ts
M  src/agent/lib/__tests__/native-voice-upload-contract.test.ts
M  src/agent/lib/live-voice-config.ts
M  src/app/api/assistant/voice-tool/route.ts
?? src/app/api/assistant/voice-tool/__tests__/
```

`AssistantVoiceSwiftUI.swift` alone contains roughly 1,469 changed lines in that uncommitted diff. Treat it as a research/salvage source, not a reviewable recovery patch.

Do not reset, clean, overwrite, or delete this worktree. Before recovery work, create a non-destructive patch/checkpoint if one does not already exist:

```sh
git -C /Users/marufbillah/alma-erp-ios-live-voice-professional status --short --branch
git -C /Users/marufbillah/alma-erp-ios-live-voice-professional diff --check
git -C /Users/marufbillah/alma-erp-ios-live-voice-professional diff --stat
```

Do not stage or commit the dirty work unless the owner explicitly chooses that scope.

## 4. What was implemented before the audit freeze

The preserved branch has these 12 local commits, in order:

| Commit | Intent | Current interpretation |
|---|---|---|
| `16a99fe2f` | Phase 0 privacy-safe diagnostics, feature flags, original audit/status/protocol | Useful concepts and evidence assets; rebase/rewrite from current main rather than blind cherry-pick |
| `207a6a1a3` | Build revision stamp | Useful for evidence attribution |
| `1b807fe85` | Recorded Phase 0 evidence | Simulator-only evidence, not microphone proof |
| `adec16fd2` | Initial exact voice-preview flow and catalog tooling | Important prototype; later entry-state regression made it inaccessible |
| `37e76ca1f` | Bundled exact 2×6 Gemini voice samples | All 12 assets and checksums currently verify; owner approval remains 0/12 |
| `f1dcbfed0` | Worktree revision stamp update | Build metadata only |
| `2dd340a4f` | Immutable revision stamp adjustment | Build metadata only |
| `caa1cc339` | Audible preview audio-session activation | Addresses one playback route issue, but not current access/gating failure |
| `7fc80fb24` | Restored primary voice entry | Fixed “settings opens directly” by removing pre-call sheet; unintentionally removed the only practical preview entry |
| `6e2aec50b` | Constrained Gemini Live setup | Setup compatibility work; must be checked against current official API and current main |
| `05c1cc69f` | Gemini credit exhaustion surface and setup probe | Useful diagnostic path |
| `eb3d63aec` | Orb synchronized to agent output audio | Desired direction; verify device behavior and accessibility before reuse |

Committed branch diff versus its merge base is approximately 3,503 insertions and 164 deletions across 54 files, including diagnostics, proof assets, scripts, 12 bundled iOS previews, 12 public preview copies, tests, and large Swift changes.

### 4.1 Preview catalog evidence

The preserved branch includes:

- `config/voice-preview-catalog/live-bn-v1.json`;
- `ios/App/App/VoicePreviews/live-bn-v1/` with 12 `.m4a` assets;
- `public/voice-previews/live-bn-v1/` with the same 12 catalog assets;
- `scripts/generate-ios-voice-preview-catalog.mjs`;
- `scripts/verify-ios-voice-preview-catalog.mjs`;
- Phase 1 proof manifests/screenshots.

Current local verification command:

```sh
cd /Users/marufbillah/alma-erp-ios-live-voice-professional
node scripts/verify-ios-voice-preview-catalog.mjs
```

Observed result on 2026-08-11:

```text
Voice preview catalog PASS: 12/12 pairs, 12/12 generated+verified,
0/12 owner-approved, release=false
```

This proves manifest/files/checksums, not audible playback in the current navigation flow and not owner approval of voice quality.

### 4.2 Diagnostics and test harness work

Prior work added privacy-safe session/build/model/voice/route/event evidence, aggregate RMS/classifier values, a diagnostic export, feature-flag declarations, Swift tests, UI fixtures, and a real-device protocol.

The original protocol is available at:

```sh
git show codex/ios-live-voice-professional:docs/testing/IOS_LIVE_VOICE_REAL_DEVICE_PROTOCOL_2026-08-08.md
```

Reuse its privacy principles, but correct misleading milestones before relying on it. Evidence must distinguish queued from successfully sent data and must use a stable local ordinal/correlation without logging PCM, transcript, tool arguments/results, URLs, tokens, or provider call IDs.

### 4.3 Dirty hardening prototypes worth reviewing, not trusting

The uncommitted diff contains prototypes for:

- a listening-gate reducer and larger pre-roll;
- continuous PCM upload on trusted VPIO/AEC routes;
- first-energy / first-audio evidence milestones;
- input transcript ordinals and `finished` handling;
- canonical Swift/TypeScript tool declarations;
- exact tool ID/name response encoding;
- held-result FIFO and a tool-call ledger;
- reconnect/stale-send hardening;
- per-model quick-tool routing and sales-date defaults;
- parity and regression tests.

Some of these address real defects. Some were written while the flow was changing and have known edge cases. Extract only after a clean independent test proves the behavior.

## 5. Owner-observed failure chronology

These are product facts, not hypotheses:

1. The requested ChatGPT-like card-tap preview was initially absent on both simulator and real iPhone.
2. Preview later appeared to progress/take time but produced no audible sound on the iPhone.
3. The primary Live Voice button regressed into opening model/voice settings directly instead of starting the earlier voice flow.
4. Restoring voice entry led to connection failure: “পূর্ণ সংযোগ / সংযোগ ফিরে আনা হচ্ছে,” no timer start, then “কলটি সংযোগিত হয়নি.”
5. After credit was restored, the owner asked for the existing orb to move naturally only with agent speech while remaining calm during owner speech.
6. On a real iPhone, the first utterance was often ignored. The owner needed two to four attempts, often speaking slowly, before a title appeared.
7. The screen-edge live/mic effect reacted immediately to speech even when no title appeared and the agent did not respond.
8. Later broad changes still did not fix first-input recognition.
9. Live preview became inaccessible again.
10. Gemini 3.1 could capture speech but would verbally promise work without switching to work mode or actually calling the ERP tool.
11. The owner explicitly stopped random implementation and requested a full end-to-end audit before restart.

Any future claim of “fixed” must include a reproducible PASS against these exact failures.

## 6. Confirmed root causes and high-confidence gaps

### 6.1 Preview is blocked by navigation and call-state coupling

In the preserved snapshot:

- the voice console calls `engine.begin()` on appearance;
- settings defines `callIsActive` as any connection state other than `.idle`;
- preview refuses playback while `callIsActive` and shows “কল শেষে preview শুনুন”;
- commit `7fc80fb24` removed the pre-call settings presentation to restore primary call entry.

Together these make the preview catalog inaccessible from the primary flow even though the 12 assets exist and verify.

Independent verification locators:

```sh
rg -n "engine\.begin\(|callIsActive|কল শেষে preview" \
  /Users/marufbillah/alma-erp-ios-live-voice-professional/ios/App/App/AssistantVoiceSwiftUI.swift
git show 7fc80fb24 --
```

Required architecture: pre-call preview/settings must be independent of Live-session start. Active-call preview needs an explicit audio-session policy and must not leak preview PCM into Gemini input.

### 6.2 The edge glow proves raw mic energy only

The capture path updates `engine.micLevel` from raw input RMS before PCM conversion and before `sendRealtimeAudio`. The visual edge uses `micLevel` even when later stages fail.

Therefore the owner's observation—glow reacts, no title, no agent response—is consistent with any failure between raw audio tap and provider transcription. It does **not** prove the model heard the owner.

The minimum truthful evidence chain is:

```text
audio graph ready
→ first raw energy
→ PCM conversion succeeded
→ audio chunk queued for the current transport generation
→ send completion succeeded on the current ready socket
→ provider input transcription/activity observed
→ model response or tool call observed
```

The exact failing boundary in the owner's run is still unresolved because no exported report from that run proves the later milestones.

### 6.3 First-input loss was plausible in the old local gate

The prior normal-listening path could:

- suppress/destroy the first post-playback audio window;
- calibrate its noise floor from the owner's immediate speech;
- withhold PCM until a local custom gate opened despite provider automatic VAD;
- reset calibration redundantly;
- present “listening” before post-playback suppression ended.

This explains the original “two to four attempts” symptom and blank headline. The dirty prototype changed normal trusted/AEC routes toward continuous provider-VAD upload, which is directionally safer.

However, the latest owner test still failed after broad tuning. Do not conclude that one threshold is the remaining cause.

### 6.4 Unsupported evidence-free VAD tuning was introduced

Immediately before the audit freeze, start sensitivity was changed globally from LOW to HIGH and a trusted-route local activity threshold was reduced. This did not resolve the real-iPhone failure and was not supported by a controlled route/noise matrix.

Independent locator:

```sh
rg -n "START_SENSITIVITY|startOfSpeechSensitivity" \
  /Users/marufbillah/alma-erp-ios-live-voice-professional/ios/App/App/AssistantVoiceSwiftUI.swift \
  /Users/marufbillah/alma-erp-ios-live-voice-professional/src/agent/lib/live-voice-config.ts
```

Treat endpointing/VAD as **UNVERIFIED**. Revert or redesign from measured real-device evidence, not intuition.

### 6.5 “Work mode” has a direct prompt/fallback contradiction

The UI enters “কাজ করছি…” only when a real `run_agent_turn` call marks `liveToolTurnPending`. A spoken acknowledgement alone does not do this.

The fallback watchdog sends a `STATUS_NOTE` telling the model to call `run_agent_turn`. The TypeScript system instruction simultaneously says never call `run_agent_turn` in response to `STATUS_NOTE`.

Independent locators:

```sh
rg -n "armAckWithoutToolWatch|এখনই run_agent_turn|STATUS_NOTE-এর জবাবে" \
  /Users/marufbillah/alma-erp-ios-live-voice-professional/ios/App/App/AssistantVoiceSwiftUI.swift \
  /Users/marufbillah/alma-erp-ios-live-voice-professional/src/agent/lib/live-voice-config.ts
```

This contradiction is a high-confidence root cause for “মুখে বলে কাজ করে না.” Do not patch it with another spoken nudge. Design deterministic intent→tool behavior and prove the provider emits the call for each supported model.

### 6.6 Gemini 3.1 synchronous tool behavior raises the severity

Current official Google documentation states:

- Live function calling is manual; the client must return function responses;
- Gemini 3.1 Flash Live supports synchronous function calling only;
- one prompt can yield multiple function calls;
- Gemini 3.1 waits for tool responses before continuing;
- Gemini 2.5 additionally supports asynchronous/non-blocking behavior.

Consequences:

- dropping or misnaming one response can stall the 3.1 turn;
- a single optional pending-result slot is not sufficient;
- ID and invoked name must round-trip exactly;
- response delivery must survive reconnect without duplicate execution;
- a completed-call ledger must reject late results from a reset session;
- multiple function calls must preserve order and all results.

### 6.7 Provider tool cancellation is unhandled

The preserved Swift implementation has no `toolCallCancellation` handler. Official Live protocol includes cancellation semantics during interruption.

Without cancellation handling, an interrupted tool may continue, speak a stale result, or violate approval expectations. Implement cancellation propagation and suppress late response/playback for canceled calls. Test it on both immediate and held tool paths.

### 6.8 Tool response and routing defects found during audit

Confirmed or previously present defects include:

- `quick_erp_lookup` results were once returned using the default name `run_agent_turn`;
- an optional default function name made recurrence easy;
- a single held-result slot could overwrite one of multiple tool results;
- a single wire-response slot/weak replay rules could lose or duplicate results across reconnect;
- `/api/assistant/voice-tool` sent `{}` to `get_sales_summary`, although that tool requires `from` and `to` dates;
- the dirty route prototype supplies the Asia/Dhaka current date when omitted;
- evidence events were sometimes recorded before socket-send success;
- same-name calls lacked privacy-safe local correlation;
- exhausted reconnect/full engine restart can intentionally reset the ledger and lose an already-accepted tool completion unless an explicit terminal policy exists.

Verify the current main implementation independently; some old defects may already have changed in the 32 newer main commits.

### 6.9 Input transcript finalization/order is not a stable invariant yet

The installed Google SDK type includes optional transcription `text` and optional `finished`, but the public Gemini Developer WebSocket reference may document only `text`. Provider audio/transcription/model events may arrive independently.

Known risks in evolving code included:

- ignoring marker-only `{finished: true}`;
- splitting one owner utterance if a late fragment follows playback start;
- appending a new utterance to the previous feed row;
- overwriting real transcript text with a delayed “কথা শুনছি…” activity placeholder;
- incrementing the local turn ordinal twice if transcription arrives before local RMS activity;
- never finalizing a tool-only/no-audio turn when `finished` is absent.

Required design: one ordered reducer/state machine with explicit local/provider boundaries and fallback timeouts that are observable and model-tested. Do not let independent callbacks mutate headline/feed ownership ad hoc.

### 6.10 Realtime text has cross-stream ordering risk

Current official docs require `send_realtime_input` for post-initial-context text on Gemini 3.1. That fixes the old unsupported `clientContent` usage, but realtime text and audio are concurrent streams and their ordering is not guaranteed.

`STATUS_NOTE` control messages can therefore interleave with owner audio. Do not use undocumented realtime text ordering as a hidden control channel. Define a clear turn/control protocol and verify both models.

### 6.11 Feature flags do not provide real rollback isolation

Flags are declared for diagnostics, preview, barge-in, background lifecycle, private Live Activity, and professional UI. In the preserved snapshot, only a subset is actually checked; several phase flags are decorative.

Every behavior-changing phase must be gated at the behavior entry point with a safe default and tested rollback path. A declared enum case is not a feature flag.

### 6.12 Privacy disclosure is materially inaccurate

`ios/App/App/Info.plist` states that voice is transcribed on-device “without sending audio to a server.” Live Voice sends PCM to Gemini.

This is a release blocker. Replace it with accurate, plain-language disclosure reviewed for all voice modes. Do not imply on-device processing when using a cloud Live API.

### 6.13 Dynamic Island is synthetic and exposes content

The existing `VoiceLiveActivityController` fabricates pulses for thinking/idle-style states and exports a transcript/reply tail through `captionTail()`. The privacy Live Activity flag is not a reliable behavior gate.

This fails the professional truth/privacy contract. Redesign Live Activity as low-frequency state, elapsed time, privacy-safe route/mute/end information where allowed. Keep real waveform animation inside the foreground app.

### 6.14 Cost accounting is not provider-accurate

Current server usage code uses one blended `LIVE_VOICE_USD_PER_MIN` estimate. The iOS client may send voice, but the server body/schema does not persist it. Wall-clock seconds do not distinguish streamed input, audio output, transcription text, and model-specific rates.

As verified on official Google pages on 2026-08-11, Gemini 3.1 Flash Live lists audio input at `$3/M` tokens or about `$0.005/min`, and audio output at `$12/M` or about `$0.018/min`. Input/output transcription adds text-token charges. These numbers are time-sensitive; re-check before implementation.

Preview asset playback is separate: once an approved immutable asset is bundled or cache-hit, it should create zero Gemini Live generation calls and zero new generation cost.

### 6.15 Model defaults are inconsistent

The prior iOS fresh default was Gemini 2.5 + Aoede, while a legacy backend empty-body default used Gemini 3.1 + Charon. Saved profiles may preserve older values.

Choose one versioned source of truth for supported model IDs, voices, defaults, capability flags, and replacement mapping. Migrate old preferences explicitly and test first install, upgrade, missing model, retired model, and remote kill-switch cases.

## 7. Official facts re-verified on 2026-08-11

These are a research snapshot, not permission to skip Claude's own verification:

- Gemini Live remains a preview API.
- Gemini 3.1 Flash Live uses `thinkingLevel`; Gemini 2.5 uses `thinkingBudget`.
- Gemini 3.1 post-initial text updates use realtime input rather than client content.
- Gemini 3.1 does not support affective dialog; Gemini 2.5 does.
- Bengali (`bn`) is listed as a supported language.
- Gemini 3.1 function calling is synchronous only; Gemini 2.5 can support asynchronous calls.
- Google examples explicitly iterate a list of function calls and return a list of function responses.
- Transcription adds text-token cost on top of audio-token cost.
- Current deprecation page lists no announced shutdown date for the two selected Live models, while recommending Gemini 3.1 as the replacement for the 2.5 native-audio preview.
- Apple `.playAndRecord` supports simultaneous input/output, but category/entitlement configuration is not runtime evidence.
- ActivityKit is a system-managed glanceable surface, not a reliable realtime PCM animation channel.

Primary sources to open again before any implementation decision:

- Google Live tools: <https://ai.google.dev/gemini-api/docs/live-api/tools>
- Google Live protocol: <https://ai.google.dev/api/live>
- Google Live capabilities: <https://ai.google.dev/gemini-api/docs/live-api/capabilities>
- Google Live best practices: <https://ai.google.dev/gemini-api/docs/live-api/best-practices>
- Google Live session management: <https://ai.google.dev/gemini-api/docs/live-api/session-management>
- Google pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- Google deprecations: <https://ai.google.dev/gemini-api/docs/deprecations>
- Apple `playAndRecord`: <https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playandrecord>
- Apple background execution: <https://developer.apple.com/documentation/xcode/configuring-background-execution-modes>
- Apple ActivityKit: <https://developer.apple.com/documentation/activitykit>
- Apple Live Activities HIG: <https://developer.apple.com/design/human-interface-guidelines/live-activities>

Record the date, exact model identifiers, SDK version, and any changed capability/pricing/deprecation facts in the recovery PR.

## 8. Required independent audit before editing

Claude must perform this sequence and report its own findings before reusing old code:

### 8.1 Baseline and preservation

```sh
cd /Users/marufbillah/alma-erp
git fetch origin --prune
git status --short --branch
git rev-parse HEAD origin/main
git worktree list --porcelain
git log --oneline --decorate -n 30 origin/main
```

- Identify all dirty worktrees and preserve unrelated changes.
- Confirm whether build 100's historical tree is still relevant only for reproduction.
- Create a new `codex/` recovery branch/worktree from current `origin/main`.
- Do not delete or reset the preserved professional voice worktree.
- Set a persistent goal and a PASS/FAIL checklist.

### 8.2 Build an end-to-end flow map

Trace and document, with current-main symbols rather than stale line numbers:

1. primary voice-button navigation;
2. pre-call settings and in-call settings;
3. model/voice draft, saved, active, and Apply transaction;
4. preview asset lookup, checksum, cache, audio session, playback, cancellation;
5. token/session creation and setup payload for each model;
6. audio-session category/mode/options and route changes;
7. input tap → conversion → framing → queue → socket generation → provider;
8. provider activity/transcription → local reducer → headline/feed;
9. function call → dispatch → approval policy → backend → response → provider → spoken result;
10. model audio → jitter/playback queue → level meter → orb → interruption;
11. reconnect, GoAway, resumption, stale callback, stop, and full restart;
12. background, lock, CallKit, media-services reset, and Live Activity;
13. usage/cost reporting and preview-cache accounting.

For every transition, name the owner, queue/actor, cancellation token/generation, feature flag, diagnostic event, test, and rollback behavior.

### 8.3 Compare all duplicated contracts

Normalize and compare:

- Swift Gemini setup vs TypeScript Gemini setup;
- system instruction copies;
- model/voice catalogs and defaults;
- function declarations, exact parameter schemas, and quick-tool allowlists;
- current-call Apply behavior and saved preference behavior;
- client usage payload and server usage schema;
- diagnostics event names and test expectations.

If two copies must exist, add a parity test over decoded semantic structures. Source-string tests alone are insufficient.

### 8.4 Reproduce before tuning

- Run exact iPhone 17 Pro simulator tests for UI, layout, cache, state reducer, and no-network fixtures.
- Do not claim microphone or provider behavior from simulator.
- Prepare privacy-safe evidence so the owner can perform one narrow real-iPhone first-input test.
- Tune VAD/barge-in only after the failing boundary and route are known.

## 9. Clean recovery implementation order

Do not cherry-pick the 12-commit voice branch wholesale. Reimplement from current main in reviewable slices, using the old branch only as a reference.

### Phase 0 — Truthful diagnostics and rollback harness

Behavioral tuning is forbidden in this phase.

Implement:

- stable local voice-session ID and monotonic transport generation;
- privacy-safe local turn ordinal and tool ordinal;
- actual feature gates at behavior entry points;
- events for audio graph ready, raw first energy, conversion failure/success, first queue, current-socket send success, provider activity/transcription, model audio, tool receive/execute/response/playback, socket open/close/error, reconnect/GoAway/resumption, route/interruption/background transitions;
- queued/succeeded/failed distinctions after real completion callbacks;
- exportable JSON containing no PCM, transcript, prompt, tool args/results, credentials, URLs, provider call IDs, or reversible content hashes;
- diagnostic report attribution updated after a current-call profile Apply;
- a DEBUG no-network evidence fixture.

Gate:

- exact iPhone 17 Pro simulator unit/UI tests pass;
- privacy tests seed secrets and prove absence;
- owner runs the narrow real-device first-input reproduction;
- report identifies the exact last successful stage.

### Phase 1A — Restore navigation and exact preview only

Implement pre-call settings/preview independent of Live-session start. Do not change VAD, tool routing, or background behavior in the same slice.

Acceptance:

- primary voice button starts the prior voice flow;
- settings is separately reachable before call;
- model-card and voice-card taps auto-play the exact paired asset;
- visible 2–5-line Bengali script and model research appear on the same screen;
- no Live token/session/socket/reconnect is created;
- all 12 checksums verify;
- second play is bundle/disk cache hit with zero network body and zero Gemini generation;
- rapid taps leave only the final selection playing;
- offline/corrupt/interrupted/VoiceOver states are designed and tested;
- preview does not enter active-call microphone input;
- owner listens to and approves each of the 12 assets before `release=true`.

### Phase 1B — Profile transaction, bounded context, and cost truth

Implement:

- separate draft, saved-next-call, and active profile state;
- cancel/dismiss semantics;
- current-call Apply with setup health check and rollback;
- one versioned source of truth for models/voices/defaults/capabilities;
- explicit tested context compression bound;
- provider/model/voice/input-audio/output-audio/transcription attribution;
- budget alerts and bounded session termination;
- cache evidence that distinguishes preview asset cache, context compression, and session resumption.

Gate: both models pass setup/probe, rollback failure test, long-context fixture, and cost reconciliation within an owner-approved tolerance.

### Phase 2A — First-input transport and transcript reducer

Fix only the evidence-proven boundary.

Preferred invariant on trusted VPIO/AEC routes: continuously stream valid PCM to provider automatic VAD while unmuted and ready. A local energy threshold may drive UI/evidence but must not silently withhold valid audio unless route-specific evidence justifies it.

For no-AEC loudspeaker, use a bounded design that retains a complete short utterance occurring during any suppression window. A pre-roll capacity increase alone is insufficient if detection is disabled throughout suppression.

Build one deterministic input-turn reducer covering:

- immediate speech on fresh start;
- immediate post-greeting speech;
- `.006` quiet and `.03` normal fixtures;
- quiet→speech, long speech, pauses, noise, and exact-once frame emission;
- mute/audioStreamEnd;
- transcription-before-energy and energy-before-transcription;
- marker-only finished;
- missing-finished fallback;
- late fragment after playback start;
- tool-only/no-audio model turn;
- delayed activity callback after final transcript;
- quick barge-in starting a new owner turn.

Gate: simulator reducer/transport tests pass, then a real iPhone shows one privacy-safe sequence from first energy through successful send, transcript/headline, and response on each supported model.

### Phase 2B — Barge-in from real acoustic evidence

Do not reuse a guessed global threshold.

Test at least:

- speaker 25%, 60%, 100%;
- receiver;
- AirPods/Bluetooth HFP when available;
- short “থামো”, “একটু শুনো”, a quiet full Bengali sentence, and long interruption;
- TV/music/fan/keyboard/cough/road noise false-stop cases.

Targets from the original audit: p95 interruption ≤500 ms on AEC/receiver and ≤750 ms on exposed loudspeaker, subject to owner feel and false-stop rate. Retain the first syllable and prevent stopped model audio from resurrecting.

### Phase 2C — Deterministic tools and truthful work mode

Remove the contradictory STATUS_NOTE fallback. A tool-required request must be classified and routed deterministically.

Implement/test:

- canonical exact declarations for `quick_erp_lookup`, `end_call`, and `run_agent_turn` for both models unless official capability changes;
- no unsupported `NON_BLOCKING` on 3.1;
- exact ID + invoked name + response preservation;
- ordered multiple function calls and responses;
- held results while model speaks;
- send failure→reconnect→exactly one successful replay;
- stale socket completion cannot drain a new transport queue;
- duplicate call ID cannot execute twice;
- reset-session late result is rejected;
- cancellation propagates to local/backend work and suppresses stale result audio;
- approval-required tools never execute without approval;
- quick sales lookup supplies explicit Asia/Dhaka dates;
- UI work mode begins only from a real accepted tool call and ends only on deterministic terminal state.

Run scripted Bengali/Banglish requests on both models and verify provider tool events, backend execution, returned result, spoken result, and no duplicate.

### Phase 3 — Background, lock, routes, and CallKit

Define one lifecycle state machine before editing audio callbacks.

Cover:

- foreground↔Home;
- lock/unlock;
- receiver/speaker/Control Center/Bluetooth route changes;
- audio interruption begin/end;
- incoming/outgoing CallKit activation and deactivation;
- media-services reset;
- socket stall, network handoff, GoAway, resumption rejection, and bounded full restart;
- pending tool/approval/result policy during each transition;
- timer, mute, UI, and Live Activity truth.

Only a real iPhone may PASS this phase.

### Phase 4 — Truthful, privacy-safe Live Activity

Remove synthetic waveform implications and transcript/reply tails from the privacy-default path. Show only system-appropriate low-frequency state such as connecting/listening/working/speaking/reconnecting/ended, elapsed time, mute, and safe controls where supported.

Test stale/dead session behavior, lock-screen privacy, Dynamic Island sizes, app termination, and accessibility. Keep agent-audio PCM animation in the foreground orb.

### Phase 5 — Human feel, accessibility, route matrix, and soak

Run blinded Bengali evaluation for:

- pronunciation of names, money, dates, numbers, English business terms, and Islamic greetings;
- concise tool-result narration;
- no habitual filler, duplicate greeting, theatrical empathy, or fabricated fact;
- natural speech-synchronous orb motion only during agent playback;
- VoiceOver labels/order/announcements;
- Dynamic Type, Bold Text, Reduce Motion, Reduce Transparency, contrast, small-screen and landscape;
- 45-minute call/soak, reconnect, memory, thermal, battery, duplicate-tool, duplicate-cost, and context-bound checks.

No TestFlight discussion until all release gates and owner sign-offs are recorded.

## 10. Mandatory test/evidence matrix

| Area | Simulator allowed | Real iPhone required | Current status |
|---|---:|---:|---|
| Navigation/layout | Yes — exact iPhone 17 Pro | Owner UX confirmation | Historical pass; current flow owner FAIL |
| 12-asset manifest/checksum | Yes/local | Owner listens to each asset | 12/12 technical PASS, 0/12 approved |
| Preview cache/cancellation/offline | Yes | Audible route confirmation | Not release-proven |
| Draft/saved/active reducer | Yes | Apply/reconnect confirmation | Not release-proven |
| Mic raw energy | Limited fixture only | Yes | Owner sees glow; downstream stage unknown |
| PCM conversion/socket send | Mockable | Yes for product PASS | Failing boundary unresolved |
| Gemini VAD/transcription | No | Yes, each model | Owner FAIL |
| Barge-in/echo | No | Yes, each route/volume | FAIL/UNVERIFIED |
| Tool contract serialization | Yes | Yes, one read-only tool per model | Partial local pass; owner work-mode FAIL |
| Tool cancellation/reconnect/multi-call | Yes with injected sink | Narrow real-device/network probe | Not proven |
| Agent playback/orb | UI/audio fixtures | Yes for natural feel/routes | Prototype only |
| Background/lock | No product claim | Yes | FAIL/UNVERIFIED |
| CallKit | No product claim | Yes | FAIL/UNVERIFIED |
| Dynamic Island privacy/truth | Layout fixtures | Yes on supported device | Current design FAIL |
| Accessibility | Yes + Accessibility Inspector | Real VoiceOver route pass | Incomplete |
| Cost truth | Server/unit reconciliation | Controlled paid test if approved | Current blended estimate FAIL |
| Soak | Partial automation | Yes | Not run |

Use iPhone 17 Pro simulator, not Pro Max, unless the owner explicitly changes the target.

When the real iPhone is required, ask the owner in one line with the exact action, for example:

```text
Real iPhone test ready: ফোন unlock করে Live Voice খুলে greeting শেষ হওয়ার সঙ্গে সঙ্গে একবার “আজকের ছোট পরীক্ষা” বলুন; তারপর কিছু করবেন না—আমি first-energy→send→transcript evidence যাচাই করব।
```

## 11. Known validation evidence and its limits

### Latest local TypeScript check on the preserved dirty snapshot

```sh
./node_modules/.bin/vitest run \
  src/agent/lib/__tests__/live-voice-config.test.ts \
  src/agent/lib/__tests__/native-voice-upload-contract.test.ts \
  src/app/api/assistant/voice-tool/__tests__/route.test.ts
```

Observed on 2026-08-11: 3 files, 21/21 tests PASS.

This does not prove real microphone, provider delivery, tool execution, background, or owner UX. Some tests are source-string contracts and must be replaced or complemented with decoded pure contracts and injected transport sinks.

### Swift/simulator evidence

- Historical exact iPhone 17 Pro unit runs reached 67/67 PASS on an earlier snapshot.
- Historical exact iPhone 17 Pro UI runs reached 4/4 PASS before the final small VAD change.
- A later focused Swift run compiled and linked but the test worker did not materialize; it was stopped after prolonged inactivity. Therefore no fresh current-snapshot XCTest PASS may be claimed.
- Simulator success never overrides the owner's real-iPhone FAIL.

### Static checks

- `git diff --check` passed on the preserved dirty snapshot during audit.
- Preview catalog verification passed 12/12.
- These are useful integrity checks only.

## 12. Release-blocking acceptance checklist

Do not mark the initiative complete until every applicable item is PASS with evidence:

- [ ] Primary voice entry and settings navigation are both correct.
- [ ] All 12 card-tap previews auto-play exact audible Bengali samples with no Live session.
- [ ] Draft, saved, active, Apply, and rollback semantics pass.
- [ ] One first utterance works promptly on both models and every required route.
- [ ] Headline/transcript ownership remains correct under late/out-of-order events.
- [ ] Long speech and natural pauses do not truncate.
- [ ] Barge-in latency/false-stop targets pass on real routes.
- [ ] Agent output remains smooth and complete.
- [ ] Orb is calm while listening and naturally audio-reactive only while agent speaks.
- [ ] Tool-required requests produce real calls, real work mode, real results, and no spoken-only promises.
- [ ] Exact ID/name, multi-call, cancellation, approval, reconnect, replay, and late-result tool tests pass.
- [ ] Background/Home/lock/unlock/network/audio-interruption matrix passes.
- [ ] CallKit answer/hang-up/route lifecycle passes.
- [ ] Dynamic Island/Lock Screen is truthful and privacy-safe.
- [ ] `Info.plist` voice disclosure accurately describes cloud audio processing.
- [ ] Model/voice defaults, lifecycle, remote kill switch, and migration pass.
- [ ] Provider usage/cost and preview cache evidence are accurate and distinct.
- [ ] VoiceOver, Dynamic Type, Reduce Motion, and route accessibility pass.
- [ ] 45-minute soak/battery/thermal/memory/reconnect gates pass.
- [ ] No duplicate greeting, owner turn, tool execution, result speech, approval, or cost row.
- [ ] Owner signs off each phase.
- [ ] Explicit owner approval is obtained before TestFlight/deploy/merge/main push.

## 13. Required phase-end report format

After every phase, report:

1. exact branch and commit;
2. changed files and why;
3. commands executed;
4. unit/integration/UI results;
5. exact iPhone 17 Pro simulator result;
6. screenshots when UI changed;
7. preview cache/network/generation-cost evidence when relevant;
8. privacy-safe real-device PASS/FAIL matrix;
9. owner actions requested, if any;
10. remaining risks and rollback switch;
11. confirmation that no TestFlight, production action, merge, or main push occurred.

Do not report “PASS” for an unrun or simulator-ineligible test. Use `NOT RUN`, `BLOCKED`, `FAIL`, or `UNVERIFIED` honestly.

## 14. Claude kickoff message

Give Claude the complete message below. It intentionally asks Claude to verify this handoff rather than trust it blindly.

```text
Repository: /Users/marufbillah/alma-erp

প্রথমে এই handoff file-টি সম্পূর্ণ পড়ো:
docs/handoffs/IOS_LIVE_VOICE_CLAUDE_RECOVERY_HANDOFF_2026-08-11.md

এই file-এ আগের Live Voice implementation, owner-reported regression, audit findings, official-source snapshot, preserved dirty worktree এবং Phase 0–5 recovery contract লেখা আছে। কিন্তু handoff-এর কোনো technical conclusion অন্ধভাবে বিশ্বাস করবে না—current code, Git history, official Google/Apple docs এবং reproducible evidence দিয়ে নিজে আবার verify করবে।

Authorization:
- Phase 0–5 scoped local read/build/test/edit/local-commit কাজ করতে পারো; routine permission বারবার চাইবে না।
- TestFlight upload, production deployment, merge, main push, real production approval/action, destructive operation বা external paid bulk generation-এর আগে explicit owner approval লাগবে।
- কোনো real approval submit করবে না এবং unrelated/uncommitted change নষ্ট করবে না।

শুরুতে বাধ্যতামূলক:
1. git fetch origin --prune চালাও।
2. git status, HEAD, origin/main এবং সব worktree verify করো।
3. preserved worktree `/Users/marufbillah/alma-erp-ios-live-voice-professional` inspect করো, কিন্তু reset/clean/overwrite করো না।
4. old authoritative audit-টি পুরো পড়ো:
   `git show codex/ios-live-voice-professional:docs/handoffs/IOS_LIVE_VOICE_PROFESSIONAL_AUDIT_2026-08-08.md`
5. current origin/main থেকে নতুন dedicated `codex/` recovery worktree/branch নাও। পুরনো 12 commits বা 1,691-line dirty diff wholesale cherry-pick করবে না।
6. persistent goal এবং PASS/FAIL checklist set করো।
7. official Google Gemini Live capabilities/tools/protocol/pricing/deprecations এবং Apple AVAudioSession/background/ActivityKit docs আজকের date-এ নিজে re-check করো। Primary source ছাড়া provider/platform decision নিও না।
8. edit করার আগে complete end-to-end flow map ও duplicated-contract comparison তৈরি করো।

Owner-required preview contract:
- Model card tap = draft model select + current draft voice-এর exact preview auto-play.
- Voice card tap = draft voice select + current draft model-এর exact preview auto-play.
- একই screen-এ 2–5 লাইনের Bengali script এবং model strengths/limitations/cost/lifecycle copy থাকবে.
- Preview-এর জন্য Gemini Live session, call, reconnect বা generation হবে না.
- 2 models × 6 voices-এর versioned checksum-verified bundle/CDN/disk cache থাকবে; repeated play cache hit এবং zero new generation cost হবে.
- Active, draft এবং saved-next-call আলাদা; Apply current call না চাপা পর্যন্ত active বদলাবে না; Apply fail করলে rollback.
- Rapid tap, cancel, offline, corrupt cache, interruption, VoiceOver এবং active-call leakage test করবে.

Owner-reported critical failures পুনরায় reproduce করো:
- প্রথম কথা 2–4 বার বলার আগে title/agent response আসে না.
- edge mic glow হয়, কিন্তু এটা raw RMS; provider delivery/transcription প্রমাণ করে না.
- Gemini 3.1 মুখে “কাজ করছি” বলে, কিন্তু real tool call/work mode/result হয় না.
- preview assets verify করলেও current flow-এ preview inaccessible/inaudible.
- background/lock/CallKit/Dynamic Island professional gates pass নয়.

Recovery phase order:
Phase 0: privacy-safe truthful diagnostics, transport generation, session/turn/tool ordinals, real feature gates, evidence harness—কোনো VAD tuning নয়.
Phase 1A: voice entry + independent pre-call exact auto-preview only.
Phase 1B: draft/saved/active transactional Apply, context bound, model/voice lifecycle, cost truth.
Phase 2A: evidence-proven first-input transport + one ordered transcript reducer.
Phase 2B: real-iPhone route/noise evidence দিয়ে barge-in; guessed global threshold নয়.
Phase 2C: deterministic tool dispatch/work mode, exact ID/name, multi-call, cancellation, approval, reconnect/exactly-once.
Phase 3: background/lock/routes/CallKit lifecycle.
Phase 4: truthful privacy-safe Live Activity; real waveform foreground-only.
Phase 5: Bengali human feel, agent-audio orb, accessibility, route matrix, soak/release gates.

Simulator rule:
- UI/layout/cache/reducer/contract test-এ exact iPhone 17 Pro simulator ব্যবহার করবে, Pro Max নয়.
- Microphone, echo, Gemini delivery, barge-in, background, lock এবং CallKit PASS শুধু real iPhone evidence দিয়ে দাবি করবে.
- simulator pass owner real-device FAIL-কে override করতে পারবে না.

Real iPhone test-ready হলে এক লাইনে exact instruction দেবে—কখন connect/unlock/lock/speak করতে হবে।

প্রতিটি phase শেষে branch/commit, changed files, commands, tests, simulator result, screenshots, cache/cost evidence, privacy-safe real-device PASS/FAIL matrix, remaining risks ও rollback flag দেবে। সব gate ও owner sign-off না হওয়া পর্যন্ত TestFlight করবে না।

এখন শুধু plan লিখে থেমে যেও না: baseline/research/flow audit execute করো, evidence report দাও, তারপর Phase 0 থেকে ছোট gated implementation শুরু করো। কোনো random broad rewrite করবে না।
```

## 15. Final handoff verdict

There is useful work to salvage: a verified 12-asset preview catalog, diagnostics concepts, an agent-audio orb direction, setup/tool parity ideas, and regression tests. There is also a large, stale, mixed, uncommitted refactor whose simulator/source tests do not explain the owner's current real-iPhone failures.

The professional recovery path is therefore:

```text
preserve old work
→ start from current origin/main
→ independently map and verify the full flow
→ add truthful evidence first
→ restore preview/navigation in isolation
→ fix the evidence-proven input boundary
→ make tool work deterministic
→ validate lifecycle/privacy/cost
→ real-device gates
→ owner sign-off
→ only then request release approval
```

No shorter path may be represented as professionally complete.
