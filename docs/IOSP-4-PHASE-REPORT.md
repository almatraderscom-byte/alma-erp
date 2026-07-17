# IOSP-4 Phase Report — Polling reduction + CallKit×Agora crash fix

**Session date:** 2026-07-16 · **Branch:** `agent-phase-21` · **Tag:** `pre-agent-phase-21`
**Base:** `22e27867` (IOSP-3 head) · **Simulator:** clean iPhone 17 Pro Max `9E51818A-…`. Other session's iPhone 17 Pro untouched.

## Scope

- **Allowed (roadmap IOSP-4):** replace/pause the global 3s incoming-call poll; scene-aware refresh; pause nonessential refresh when inactive/backgrounded; consolidate feeds; audit hidden Capacitor dashboard; **fix the launch crash**; don't break Hermes/push/Face ID/shortcuts/widgets/Live Activities/voice/background.
- **Files changed:**
  - `ios/App/App/AgoraIntercom.swift` — `@ObservationIgnored` on the Agora engine + private call handles (crash fix)
  - `ios/App/App/FloatingChatHead.swift` — scene-aware suspend/resume of the 3s intercom poll
  - `ios/App/App/AlmaIslandBanner.swift` — scene-aware suspend/resume of the 30s notification poll
  - `ios/App/App/AppDelegate.swift` — DEBUG crash-repro harness
- **Out of scope / deferred:** foreground push-only replacement of the 3s poll (needs server realtime — see exception); hidden-Capacitor-dashboard suspension (audited, left intact — see risks).

## Root cause addressed (two)

1. **Launch crash (P1, from IOSP-0 §8).** `CallKitVoIP.providerDidReset` → `AgoraIntercom.leave()` reads the `engine` stored property. On the `@Observable` class, that read goes through generated keypath machinery, and the Swift runtime cannot demangle `AgoraRtcEngineKit?`'s keypath from the dynamically-linked `AgoraRtcKit.framework` → `SIGTRAP` whenever a stale CallKit reset fires at launch.
2. **App-wide 3s polling.** The intercom incoming-call poll ran every 3s on every screen, foreground **and background**, even though PushKit/CallKit VoIP already delivers background calls.

## Implementation summary

1. **Crash fix:** `engine`, `appId`, `channel`, `callTimer`, `ringTimer`, `remoteUids`, `handledCallIds` are marked `@ObservationIgnored`. They are private implementation handles that never drive the UI, so excluding them from Observation removes the crashing keypath codegen with zero behavioural change.
2. **Scene-aware polling:** both the FloatingChatHead intercom poll (3s) and the AlmaIslandWatch notification poll (30s) subscribe to `didBecomeActive`/`didEnterBackground`; the timers are invalidated in the background and recreated on foreground. Background calls continue to ring via the already-wired `CallKitVoIP` VoIP push, so nothing is lost.

## Verification — hard proof (signposts, `docs/proofs/iosp4/crashfix-and-scene-signposts.txt`)

| What | Proof |
|---|---|
| **Crash fixed** | `callResetRepro.start` → `callResetRepro.survived`, process alive, **no new crash report**. Pre-fix this SIGTRAP'd between the two events. |
| **Scene-aware suspend/resume** | `callWatch.resume` (launch) → `callWatch.suspend` (backgrounded via Safari) → `callWatch.resume` (foregrounded), repeated. Background intercom polls = **0**. |
| **Foreground poll intact** | `/api/assistant/office/intercom` still fires at ~3s foregrounded — call latency preserved. |

- **Build:** `BUILD SUCCEEDED` (Pro Max). **Checker:** route contract OK. Crash-repro is `#if DEBUG` (not in Release/TestFlight).

## PASS/FAIL — IOSP-4 exit criteria

| Criterion | Result | Notes |
|---|---|---|
| No 2–3s polling when related UI not active | **PASS (background)** / **EXCEPTION (foreground)** | Backgrounded = 0 (proven). Foreground poll kept — see exception |
| 5-min idle request ≥80% below baseline | **EXCEPTION** | Met for background (100%→0). Foreground unchanged by deliberate decision — evidence-backed exception below |
| Background/foreground, incoming call, push, Live Activity, auth continuity pass | **PASS (scene transitions)** / **DEVICE-PENDING (real push/CallKit)** | Scene suspend/resume proven; real APNs/VoIP/Live Activity need the TestFlight device checkpoint |
| Launch crash fixed | **PASS** | crash-repro survives; no crash report |
| Don't break Hermes/push/Face ID/etc. | **PASS** | no `/api/agent/*`, auth, or entitlement change; poll behaviour identical foreground |
| Memory/CPU within limits | **PASS (indicative)** | fewer background timers; no new allocation |
| TestFlight technical checkpoint executed | **OWNER ACTION** | prepared, not uploaded — see below |

### Evidence-backed exception (roadmap §8 allows this)

The foreground 3s intercom poll is **intentionally retained**. It is the owner's WhatsApp-style incoming-call ring, and cutting its cadence risks missed/late calls — the app's most safety-critical feature (owner priority, per project history). PushKit/CallKit VoIP is the primary real-time path and now solely covers the background; the foreground poll is a fast fallback. A true push-only foreground replacement is a **server-realtime change** (WebSocket/SSE on `/api/assistant/*` + server push fan-out) that is cross-cutting and unsafe to land in a client-only phase. Recommend it as a scoped follow-up with server coordination. Net idle win this phase: **100% of background polling eliminated**, foreground held for reliability.

## Hidden Capacitor dashboard (audited, left intact)

The Capacitor dashboard stays mounted behind the native shell because it hosts the push/session/Live-Pulse/N1–N5 plugin bridges (documented in `SwiftUIShell.makeDashboardTab`). Suspending its web rendering safely without breaking those bridges is a larger, higher-risk change than IOSP-4 should carry; audited and deferred with this rationale rather than touched blindly.

## Regression and safety

- `git diff --stat`: 4 files +78/−8, plus `docs/proofs/iosp4/`. iOS-native only; no web/API, `/api/agent/*`, auth, or money code (grep-verified). No secrets, no migrations. Other worktrees preserved.

## TestFlight technical checkpoint (owner action)

Per `CLAUDE.md`, TestFlight builds go through the **GitHub Actions pipeline** (no Mac/Xcode archive), from clean pushed main-current state, with `bash scripts/ios-build-preflight.sh` + a committed build-number bump. This phase's device-only items to validate: real APNs push, VoIP/CallKit incoming call foreground+background, Live Activity, background→foreground continuity, and the crash fix on a real device. **Claude does not upload.** When you're ready, trigger the CI pipeline from the merged branch; I can prepare the build-number bump commit on request.

## Remaining risks / carried debt

- Foreground poll reduction deferred to a server-realtime follow-up (exception above).
- Hidden Capacitor dashboard suspension deferred (rationale above).
- Real push/CallKit/Live Activity are device-only — unproven until the TestFlight checkpoint.

## Next: IOSP-5 handoff

`docs/IOSP-5-CLAUDE-CODE-HANDOFF.md` — Agent rendering/interaction polish. Branch `agent-phase-22`.
