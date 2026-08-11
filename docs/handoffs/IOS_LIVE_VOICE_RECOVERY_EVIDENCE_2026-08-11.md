# ALMA ERP iOS Live Voice Recovery Evidence

Date: 2026-08-11 (Asia/Dhaka)

Recovery branch: `codex/ios-live-voice-recovery-20260811`

Recovery base: `origin/main` at `1a51f0356`
Authoritative recovery contract: commit `8aa1a60a9`,
`docs/handoffs/IOS_LIVE_VOICE_CLAUDE_RECOVERY_HANDOFF_2026-08-11.md`

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
| Phase 4 private activity | `ALMA_LIVE_VOICE_PRIVATE_LIVE_ACTIVITY_V1` | `alma-live-voice-recovery-private-live-activity-v1` | Live Activity publication is disabled, not downgraded to content-bearing state. |

New behavior-changing Phase 1B/2/3/5 slices must add a checked entry-point gate
and rollback test before their phase can be marked engineering-complete.

## End-to-end owner and queue map

| Flow | Owner | Serialization / actor | Identity and cancellation | Truth event / test seam | Rollback |
|---|---|---|---|---|---|
| Primary voice entry | `AgentComposerView` / `AlmaVoiceConsoleView` | Main actor | Existing view lifetime | UI tests preserve the call button while preview is disabled | Preview flag affects settings only |
| Pre-call settings | `AlmaPreCallLiveSettingsController` | Main actor | Sheet controller lifetime; `shutdown()` is terminal | Draft/controller tests in `LiveVoicePreviewTests` | Preview flag |
| Preview resolve/cache | `AlmaLiveVoicePreviewStore` | Swift actor | Exact model+voice catalog identity, SHA-256, request generation | Built-product 12-entry test; cache/corruption/rapid-selection tests | Preview flag; bundled path remains offline |
| Preview playback | `AlmaLiveVoicePreviewCoordinator` | Main actor + injected audio adapters | Playback generation and central audio-admission token | Lifecycle, takeover, activation-failure tests | Preview flag; no Live token/socket path |
| Draft/saved/active profile | `AlmaLiveVoiceProfileTransaction` | Main actor | Proposed profile and connection generation | Apply/rollback reducer tests | Profile-transaction flag |
| Session mint/setup | `AlmaVoiceEngine` + `AlmaGeminiLiveSession` | Main actor, `netQueue`, start-attempt condition | Local session ID, engine connection generation, logical start token, physical socket attempt | Setup/socket/reconnect evidence and fixture tests | Live-session/server kill plus phase gates |
| Audio capture | `AlmaGeminiLiveSession` | `audioQueue`; realtime tap guarded by `audioLock` | Logical start token and current physical socket attempt | raw-energy→conversion→queue→completion evidence | Phase 2 transport gate required before final engineering PASS |
| Provider input state | `AlmaGeminiLiveSession` → `AlmaVoiceEngine` | URLSession delegate/net queue → main actor | Exact socket attempt and engine generation | provider activity/transcription evidence | Phase 2 reducer gate required |
| Tool invocation | Provider socket → engine tool dispatcher | Socket callback → main actor → backend task | Exact provider ID, invoked name, tool ordinal, session/transport generation | Tool receive/execute/response/playback evidence | Phase 2 tool gate required |
| Model playback | `AlmaGeminiLiveSession` | `audioQueue` + `audioLock` | Logical attempt, playback generation, buffer IDs | first PCM/playback/drain/interruption evidence | Phase 2 playback gate required |
| Reconnect/resumption | `AlmaGeminiLiveSession` | `netQueue` with start-attempt CAS | Logical start token + exact old physical socket | close/error/GoAway/resumption/reconnect events | Bounded retry, then terminal stop |
| App/CallKit lifecycle | `AlmaVoiceEngine`, CallKit/Office coordinators | Main actor plus provider queues | Call/audio-admission token and lifecycle generations | Focused pure tests only; product PASS is device-only | Phase 3 lifecycle gate required |
| Live Activity | `VoiceLiveActivityController` | Main actor / ActivityKit | Stable call activity ID | Payload privacy test | Private-activity flag |
| Usage/cost | `AlmaLiveVoiceUsageMeter` → usage API | Lock-protected meter; server transaction | Stable call ID + profile segment index | Swift usage tests and server pricing/dedup tests | Usage endpoint fail-closed; budget gate pending |

## Duplicated semantic contracts

The following pairs must remain semantically equal. A source-string comparison
is insufficient; the final simulator gate must decode and compare normalized
structures.

| Contract | Swift source | Server/TypeScript source | Current status |
|---|---|---|---|
| Model IDs, voices, defaults, capabilities, replacements | `AlmaLiveVoicePreferences` | `src/agent/lib/live-voice-config.ts` | **OPEN** — one versioned catalog/migration source is required. |
| System instruction | `AlmaGeminiLiveSession.sendSetup` | `LIVE_VOICE_SYSTEM_INSTRUCTION` | **OPEN** — `STATUS_NOTE` contradiction must be removed. |
| Context compression | raw setup payload | `buildLiveVoiceConfig` | **OPEN** — explicit trigger/target bounds and long-context tests required. |
| Function declarations and schemas | raw setup payload | `buildLiveVoiceConfig` | **OPEN** — all three canonical declarations and semantic parity required. |
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
- Exact iPhone 17 Pro simulator evidence: `LiveVoicePreviewTests` 68/68 PASS on
  the committed recovery snapshot; catalog verifier 83/83 PASS.
- Audible model×voice approval: **0/12, NOT RUN / OWNER GATE**.

### Phase 1B — profile, bounded context, and cost

- Commit slices already present: `81fe3ff22` (transaction) and `7a8893ca7`
  (truthful usage).
- Apply/rollback and measured usage/pricing/dedup unit scope: **PASS**.
- Versioned catalog/migration/remote model kill, explicit compression bounds,
  budget alert/termination and long-context fixture: **OPEN**.
- Both-model provider probe and owner-approved billing tolerance: **NOT RUN /
  OWNER GATE**.

### Phase 2A/2B/2C — input, barge-in, and tools

- Evidence plumbing exists, but engineering completion is **OPEN** until:
  - trusted AEC routes continuously submit valid ready/unmuted PCM;
  - one deterministic input/transcript reducer passes the complete fixture matrix;
  - no-AEC suppression proves complete short-utterance retention;
  - tool declarations, ordered calls/results, exact ID/name, FIFO holding,
    duplicate/reconnect replay, cancellation and approval invariants pass.
- Acoustic latency/false-stop, first-syllable retention and provider-scripted
  Bengali/Banglish flows: **NOT RUN / OWNER GATE**.

### Phase 3 — lifecycle and CallKit

- Source contains generation fences and central audio admission, but the required
  single lifecycle reducer and complete transition-policy test matrix are
  **OPEN**.
- Home/lock/routes/interruption/CallKit/media-reset/network product behavior:
  **NOT RUN / OWNER GATE**. Simulator tests may prove reducer logic only.

### Phase 4 — truthful Live Activity

- Commit `845ea62b0` removes transcript/reply tails and synthetic waveform state.
- Payload privacy unit scope: **PASS**.
- Stale/dead session, termination, accessibility and all Dynamic Island sizes:
  **OPEN (simulator/layout)** and **NOT RUN (owner device)**.

### Phase 5 — feel, accessibility, and soak

- Preview has focused accessibility coverage; the full voice surface, output-PCM
  orb metering and layout/accessibility matrix remain **OPEN**.
- Blinded Bengali evaluation, route matrix, 45-minute soak, battery, thermal,
  memory and paid-cost reconciliation: **NOT RUN / OWNER GATE**.

## Current automated evidence and limits

These results are evidence for their named scope only:

- Exact iPhone 17 Pro simulator: `LiveVoicePreviewTests` 68/68 PASS.
- Preview catalog Node verifier: 83/83 PASS.
- Usage/pricing plus agent-call server tests: 28/28 PASS.
- Usage/pricing TypeScript slice: 5/5 PASS.
- Swift parse, ESLint, plist and whitespace checks passed for their committed
  slices.
- A later incremental Xcode test-worker launch stalled after a clean build/link
  and was stopped; it is not recorded as either a test PASS or source failure.

Simulator evidence never proves microphone delivery, provider VAD/transcription,
acoustic echo cancellation, CallKit activation, background/lock execution,
Bluetooth routing, paid billing reconciliation, or human speech quality.

## Final owner gate (not yet ready)

The owner gate opens only after every `OPEN` simulator-code row above is closed
and the combined exact iPhone 17 Pro simulator/server/catalog/provenance/hygiene
gate is green. The subsequent actions are real-device tests and approvals only;
no upload, push, merge, deployment, production mutation, or TestFlight action is
performed without explicit owner approval.
