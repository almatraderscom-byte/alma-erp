# ALMA ERP iOS Live Voice Recovery Evidence

Date: 2026-08-11 (Asia/Dhaka)

Recovery branch: `codex/ios-live-voice-recovery-20260811`

Recovery base: `origin/main` at `1a51f0356`
Authoritative recovery contract: commit `8aa1a60a9`,
`docs/handoffs/IOS_LIVE_VOICE_CLAUDE_RECOVERY_HANDOFF_2026-08-11.md`

Latest local implementation commits covered by this report:
`ccd5c936a` (truthful Live Activity) and `56ec55b22` (final cross-phase
safety/evidence closure). Neither commit has been pushed or uploaded.

This file is the phase evidence index and end-to-end flow map required by the
recovery contract. It deliberately distinguishes simulator evidence from
real-iPhone evidence. `PASS` is used only for a command or behavior that has
actually run at the stated scope. Device-only rows stay `NOT RUN` until the
owner performs them.

No TestFlight upload, push, merge, deployment, or production mutation is
authorized by this report.

## Preserved state

- The recovery branch/worktree is separate from the original workspace.
- The preserved professional voice worktree has not been reset, cleaned, or
  overwritten.
- Recovery commits remain local. `origin/main` has not been moved.
- Preview media remains `generated_pending_owner_approval`; technical integrity
  does not substitute for the owner's 12 audible approvals.

## Rollback switches

Environment overrides take precedence over the matching UserDefaults key.
`0`, `false`, `no`, or `off` disables a slice before its behavior entry point.

| Slice | Environment key | Local key | Entry-point behavior |
|---|---|---|---|
| Phase 0 evidence | `ALMA_LIVE_VOICE_EVIDENCE_V1` | `alma-live-voice-recovery-evidence-v1` | No evidence session/export fixture is created when disabled. |
| Phase 1A preview | `ALMA_LIVE_VOICE_PREVIEW_CATALOG_V1` | `alma-live-voice-recovery-preview-catalog-v1` | Pre-call preview entry and playback coordinator are unavailable; the primary call entry remains. |
| Phase 1B Apply | `ALMA_LIVE_VOICE_PROFILE_TRANSACTION_V1` | `alma-live-voice-recovery-profile-transaction-v1` | Current-call profile transaction is unavailable; saved next-call behavior remains. |
| Phase 1B contract/budget | `ALMA_LIVE_VOICE_PHASE1B_CONTRACT_V1` | `alma-live-voice-recovery-phase1b-contract-v1` | Versioned contract, bounded context, migration, and local budget enforcement fall back atomically to the legacy path. |
| Phase 2A input reducer | `ALMA_LIVE_VOICE_INPUT_TURN_REDUCER_V1` | `alma-live-voice-recovery-input-turn-reducer-v1` | The pre-existing input path remains available without the new reducer/suppression policy. |
| Phase 2C tools | `ALMA_LIVE_VOICE_TOOL_ORCHESTRATION_V1` | `alma-live-voice-recovery-tool-orchestration-v1` | The deterministic provider-ID ledger and replay path are disabled at their entry point. |
| Phase 3 lifecycle | `ALMA_LIVE_VOICE_LIFECYCLE_REDUCER_V1` | `alma-live-voice-recovery-lifecycle-reducer-v1` | Existing lifecycle callbacks run without reducer enforcement. |
| Phase 4 private activity | `ALMA_LIVE_VOICE_PRIVATE_LIVE_ACTIVITY_V1` | `alma-live-voice-recovery-private-live-activity-v1` | Live Activity publication is disabled, not downgraded to content-bearing state. |
| Phase 5 PCM orb | `ALMA_LIVE_VOICE_OUTPUT_PCM_ENVELOPE_V1` | `alma-live-voice-recovery-output-pcm-envelope-v1` | Foreground presentation uses the prior level path instead of the generation-bound output-PCM envelope. |

Every behavior-changing recovery slice now has a checked entry-point gate and a
focused rollback test. Accessibility/layout policy is a fail-safe presentation
policy rather than a provider, transport, microphone, or session behavior gate.

## End-to-end owner and queue map

| Flow | Owner | Serialization / actor | Identity and cancellation | Truth event / test seam | Rollback |
|---|---|---|---|---|---|
| Primary voice entry | `AgentComposerView` / `AlmaVoiceConsoleView` | Main actor | Existing view lifetime | UI tests preserve the call button while preview is disabled | Preview flag affects settings only |
| Pre-call settings | `AlmaPreCallLiveSettingsController` | Main actor | Sheet controller lifetime; `shutdown()` is terminal | Draft/controller tests in `LiveVoicePreviewTests` | Preview flag |
| Preview resolve/cache | `AlmaLiveVoicePreviewStore` | Swift actor | Exact model+voice catalog identity, SHA-256, request generation | Built-product 12-entry test; cache/corruption/rapid-selection tests | Preview flag; bundled path remains offline |
| Preview playback | `AlmaLiveVoicePreviewCoordinator` | Main actor + injected audio adapters | Playback generation and central audio-admission token | Lifecycle, takeover, activation-failure tests | Preview flag; no Live token/socket path |
| Draft/saved/active profile | `AlmaLiveVoiceProfileTransaction` | Main actor | Proposed profile and connection generation | Apply/rollback reducer tests | Profile-transaction flag |
| Session mint/setup | `AlmaVoiceEngine` + `AlmaGeminiLiveSession` | Main actor, `netQueue`, start-attempt condition | Local session ID, engine connection generation, logical start token, physical socket attempt | Setup/socket/reconnect evidence and fixture tests | Live-session/server kill plus phase gates |
| Audio capture | `AlmaGeminiLiveSession` + `AlmaLiveVoiceInputTurnReducer` | `audioQueue`; realtime tap guarded by `audioLock` | Logical start token and current physical socket attempt | trusted-route/no-AEC/short-utterance tests | Input-reducer flag |
| Provider input state | `AlmaGeminiLiveSession` → input reducer → `AlmaVoiceEngine` | URLSession delegate/net queue → main actor | Exact socket attempt, engine generation, and one finalized owner turn | transcription ordering/finalization tests | Input-reducer flag |
| Tool invocation | Provider socket → `AlmaLiveVoiceToolLedger` → backend | Socket callback → main actor → backend task | Exact provider ID+name+payload, FIFO ordinal, transport generation | execution/response FIFO, replay, conflict, cancellation tests | Tool-orchestration flag |
| Model playback | `AlmaGeminiLiveSession` + `AlmaLiveVoiceOutputPCMEnvelopeReducer` | `audioQueue` + `audioLock` | Logical attempt, playback generation, exact PCM samples | PCM amplitude/silence/stale-generation tests | Output-PCM flag |
| Reconnect/resumption | `AlmaGeminiLiveSession` | `netQueue` with start-attempt CAS | Logical start token + exact old physical socket | close/error/GoAway/resumption/reconnect events | Bounded retry, then terminal stop |
| App/CallKit lifecycle | `AlmaVoiceEngine` + `AlmaLiveVoiceLifecycleReducer`, CallKit/Office coordinators | Main actor plus provider queues | Call/audio-admission token and lifecycle generation | exhaustive reducer/terminal/no-auto-resume tests; product PASS remains device-only | Lifecycle flag |
| Live Activity | `VoiceLiveActivityController` | Main actor / ActivityKit | Stable call activity ID, 90-second stale bound, 30-minute hard expiry | payload privacy and bounded stale/dead policy tests | Private-activity flag |
| Usage/cost | `AlmaLiveVoiceUsageMeter` + local budget guard → usage API | Lock-protected meter; server transaction | Stable call ID + profile segment index | measured/provider-token threshold and exactly-once guard tests | Phase 1B contract flag; server endpoint remains fail-closed |

## Duplicated semantic contracts

The following pairs must remain semantically equal. A source-string comparison
is insufficient; the final simulator gate must decode and compare normalized
structures.

| Contract | Swift source | Server/TypeScript source | Current status |
|---|---|---|---|
| Model IDs, voices, defaults, capabilities, replacements | `AlmaLiveVoiceContractStore` | `src/agent/lib/live-voice-contract.ts` | **PASS (unit/product scope)** — one strict versioned JSON contract, migration, replacement, and server kill policy. |
| System instruction | `AlmaGeminiLiveSession.sendSetup` | `LIVE_VOICE_SYSTEM_INSTRUCTION` | **PASS (unit scope)** — contradictory `STATUS_NOTE` behavior removed. |
| Context compression | canonical contract → setup payload | canonical contract → `buildLiveVoiceConfig` | **PASS (unit/product scope)** — explicit 25,000 trigger / 8,000 target bounds. |
| Function declarations and schemas | setup + tool ledger | `buildLiveVoiceConfig` | **PASS (unit scope)** — same three synchronous declarations, exact identity, FIFO, replay, and cancellation. |
| Usage dimensions | `AlmaLiveVoiceUsageReport` | usage route + `live-voice-usage.ts` | **PASS (unit scope)** — provider/model/voice/audio/transcription dimensions and stable segment dedup are covered. |
| Preview catalog | bundled strict Swift decoder | JSON manifest + Node verifier | **PASS (technical scope)** — exact 2×6 matrix and hashes; audible approval remains device-only. |

## Phase evidence

### Phase 0 — diagnostics and rollback

- Commit slices: `6f3c43a93`, `fe6e23ca9`, `e3a02a27f`, plus integration in
  `3d7959bcc`.
- Changed behavior: privacy-safe evidence only; no PCM, transcript, prompt,
  credentials, URL, provider call ID, tool argument/result, or reversible content
  hash is exported.
- Simulator/unit evidence: evidence recorder, exact send-completion, lifecycle,
  privacy-canary, and no-network fixture tests are present in
  `AssistantParityV2Tests` and `AssistantParityV2UITests`.
- Real iPhone first-input boundary: **NOT RUN / OWNER GATE**.

### Phase 1A — exact independent preview

- Commit slices: `7518cb3a7`, `3924224a1`.
- Technical catalog: 12/12 entries and checksums verified; bundle/cache/offline,
  corrupt asset, rapid selection, lifecycle, takeover, and VoiceOver behavior are
  covered by focused tests.
- Exact iPhone 17 Pro simulator evidence: all preview/catalog/audio-admission
  cases in the 81-test `LiveVoicePreviewTests` class passed. One Phase 2 intent
  classifier method in that mixed class failed before a one-line Bengali
  grapheme-boundary fix; the final source compiled, but Xcode did not
  materialize a post-fix test worker (details below). Catalog verifier 83/83
  PASS.
- Audible model×voice approval: **0/12, NOT RUN / OWNER GATE**.

### Phase 1B — profile, bounded context, and cost

- Commit slices: `81fe3ff22` (transaction), `7a8893ca7` (truthful usage),
  and `102915ce1` (versioned contract, context, migration, kill policy, budget).
- Apply/rollback, strict duplicate-key rejection, model replacement, remote kill,
  25,000→8,000 compression, measured/provider-token budget thresholds, and
  exactly-once warning/termination unit scope: **PASS**.
- Both-model provider probe and owner-approved billing tolerance: **NOT RUN /
  OWNER GATE**.

### Phase 2A/2B/2C — input, barge-in, and tools

- Commit `4e0dd1dda` integrates one generation-bound input/transcript reducer.
  Trusted AEC/receiver routes submit valid ready/unmuted PCM continuously, while
  bounded no-AEC suppression retains and drains complete short utterances.
- Commit `3f84fb0fe` integrates the deterministic provider tool ledger: exact
  ID/name/payload identity, provider-order execution and FIFO responses,
  duplicate replay without re-execution, reconnect replay, cancellation, and
  late-result suppression. Engineering/unit scope: **PASS**.
- Acoustic latency/false-stop, first-syllable retention and provider-scripted
  Bengali/Banglish flows: **NOT RUN / OWNER GATE**.

### Phase 3 — lifecycle and CallKit

- Commit `6d219f9df` integrates the rollback-gated, generation-bound lifecycle
  reducer across foreground/background/lock, interruption, route, CallKit,
  provider/network recovery, mute/end, and tool policy. The transition matrix,
  composite blockers, exact generation, and terminal no-auto-resume unit scope
  are **PASS**.
- Home/lock/routes/interruption/CallKit/media-reset/network product behavior:
  **NOT RUN / OWNER GATE**. Simulator tests may prove reducer logic only.

### Phase 4 — truthful Live Activity

- Commits `845ea62b0`, `e8b6deb1a`, and `ccd5c936a` remove transcript/reply/audio tails,
  synthetic waveform state, and periodic synthetic speaking animation; enforce
  90-second stale and 30-minute hard-expiry bounds; and add stale/termination,
  Reduce Motion/Transparency, and accessibility policy coverage. Simulator/unit
  scope: **PASS**.
- All real Lock Screen/Dynamic Island sizes and visual/privacy approval:
  **NOT RUN / OWNER GATE**.

### Phase 5 — feel, accessibility, and soak

- Commit `a714e7603` drives the foreground speaking orb from generation-bound
  real output PCM, settles silence, keeps listening calm, and removes fixed and
  synthetic speaking-level behavior.
- Commit `9df850444` wires VoiceOver metadata/order, 44-point targets, all Dynamic
  Type buckets, Bold Text, Reduce Motion/Transparency, Increase Contrast, and
  bounded small-screen/landscape/accessibility geometry. The 768-combination
  policy matrix and focused simulator/unit scope are **PASS**.
- Blinded Bengali evaluation, route matrix, 45-minute soak, battery, thermal,
  memory and paid-cost reconciliation: **NOT RUN / OWNER GATE**.

## Current automated evidence and limits

These results are evidence for their named scope only. They deliberately do not
convert a compile result or an infrastructure-interrupted rerun into a test PASS.

- Exact owner-approved iPhone 17 Pro simulator
  `D9787ADC-5E93-4D23-86ED-FB497EFEE1FC`: final `build-for-testing` **PASS**,
  including App, Widget, AppParityV2Tests, and AppParityV2UITests compile/link.
- The combined focused run executed 140 tests. Accessibility 5/5, Live Activity
  7/7, input 13/13, lifecycle 15/15, rendered-PCM 6/6, and Phase 1B 13/13
  passed. `LiveVoicePreviewTests` passed 80/81 methods; its only failing method
  had two assertions for the same Bengali mutation-classification defect.
- That defect was fixed by matching the complete Bengali mutation stem
  (`তৈরি`) instead of a substring ending inside the following grapheme. The
  final source rebuilt successfully. Three post-fix `test-without-building`
  attempts (including simulator reboot and non-destructive CoreSimulator service
  restart) stalled before any test process materialized and were terminated;
  therefore **no post-fix 140/140 PASS is claimed**.
- The final combined pre-fix result bundle is
  `/private/tmp/alma-live-voice-final-focused.xcresult`; the successful final
  build log is `/private/tmp/alma-live-voice-final-build-confirm.log`.
- Preview catalog Node verifier: **83/83 PASS**; technical verifier resolves
  **12/12 generated+verified**, remains **0/12 owner-approved**.
- Live voice TypeScript contract/config/usage/cancellation/voice-tool tests:
  **27/27 PASS**; full `tsc --noEmit`: **PASS** after canonical Prisma client
  generation.
- Swift parse, PBX plist lint, and repository diff/whitespace checks: **PASS**.
- Release verifier: **EXPECTED BLOCK** because status is
  `generated_pending_owner_approval`, approvals are 0/12, and `release=false`.

Simulator evidence never proves microphone delivery, provider VAD/transcription,
acoustic echo cancellation, CallKit activation, background/lock execution,
Bluetooth routing, paid billing reconciliation, or human speech quality.

## Remaining release gate (no owner action performed)

The source compiles and all executed focused rows except the now-fixed intent
case are green. Release is still blocked by the missing post-fix simulator
execution, the owner/device rows below, and these lower-severity code-evidence
follow-ups identified at freeze: preserve preview/compression milestones beyond
the bounded evidence FIFO, bind send-completion attribution to the captured
socket attempt, enforce only the current model's declared remote replacement
(including `retired` lifecycle), and add the accessibility-size/in-call preview
unavailable UI assertions.

Owner/device-only rows remain:

- listen to and approve all 12 exact preview assets;
- first-input and scripted tool flows on both provider models;
- receiver/speaker/Bluetooth/noise/volume barge-in matrix;
- Home, lock, interruption, route, CallKit, media-reset, and reconnect matrix;
- real Lock Screen/Dynamic Island privacy/layout review;
- paid billing tolerance, blinded Bengali human-feel evaluation, and 45-minute
  thermal/battery/memory/duplicate/reconnect soak.

No TestFlight upload, push, merge, deployment, production mutation, or owner
approval was performed. The release verifier remains fail-closed until the owner
completes the device gate and records 12/12 exact boolean approvals.
