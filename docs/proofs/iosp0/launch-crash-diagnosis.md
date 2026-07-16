# IOSP-0 finding — launch crash on a stale simulator (CallKit reset × Agora keypath)

**Severity:** P1 latent — reproduced deterministically on one simulator, not on a clean one. Not fixed in IOSP-0 (baseline phase, no behaviour change); logged for a later phase.

## Symptom

On the pre-existing iPhone 17 Pro Max simulator `94E0186B-5CDA-4708-9368-53B4FF7274E7`, the app crashes ~1–2 s after every launch, before the UI is usable. Console fatal:

```
Swift/KeyPath.swift:3378: Fatal error: could not demangle keypath type from 'So17AgoraRtcEngineKitCSg'
```

Crash reports (`~/Library/Logs/DiagnosticReports/App-2026-07-16-16*.ips`), faulting thread top frames:

```
_assertionFailure(...)
_resolveKeyPathGenericArgReference(...)
_walkKeyPathPattern<A>(...)
_swift_getKeyPath(...)
AgoraIntercom.engine.getter               ← @Observable stored property access via keypath
AgoraIntercom.leave()
closure #1 in CallKitVoIP.providerDidReset(_:)
```

Exception `EXC_BREAKPOINT (SIGTRAP)`.

## Root-cause reasoning

1. `AgoraIntercom` is an `@Observable` class (`AgoraIntercom.swift:64`). Under Observation, stored-property reads are routed through synthesised key paths that reference the property's type — here `AgoraRtcEngineKit?` (`So17AgoraRtcEngineKitCSg`), a type that lives inside the dynamically-linked `AgoraRtcKit.framework`.
2. At launch, `CallKitVoIP.providerDidReset(_:)` (`CallKitVoIP.swift:182`) fires when CallKit hands the app a **reset** — which happens when the simulator has **leftover CallKit call state** from a previous run. It calls `AgoraIntercom.shared.leave()`, which reads `engine` (`AgoraIntercom.swift:200`).
3. The Swift runtime cannot demangle the Agora framework type for that key path in this toolchain/simulator combination → `_assertionFailure` → SIGTRAP.

The trigger is **environmental**: `providerDidReset` only fires when the simulator carries stale VoIP/CallKit state. A **freshly created** iPhone 17 Pro Max simulator (`9E51818A-…`, iOS 26.5) launches, unlocks with Face ID, and renders the native Dashboard with live data — **no crash** — because there is no pending CallKit reset to drive the Agora key-path read.

## Evidence

- Crash: deterministic on `94E0186B-…` across ≥5 launches (161037, 161143, 161226, 161505, 161704 .ips — all identical signature).
- No crash: fresh sim `9E51818A-…`, verified running (`launchctl`/`ps` shows the process alive) with Dashboard rendered — see `promax-01-launch-dashboard.png` and `promax-cold-launch-faceid-dashboard.mp4`.
- The Agora/CallKit sources are unchanged between the roadmap base `54aadb7c` and `origin/main` (`git diff … --stat` empty), so this is not introduced by recent work; it is a latent Observation × dynamic-framework-keypath fragility exposed by CallKit reset.

## Recommendation (NOT for IOSP-0)

- Do **not** read `@Observable` stored properties whose type comes from a dynamically-linked framework inside a CallKit reset path; guard `providerDidReset`'s `leave()` so it does not touch `engine` when no engine was ever created (`engine == nil` fast path without the keypath read), or hold the Agora engine behind a non-`@Observable` box.
- Owner-facing impact: if a real device ends a call abnormally and iOS later sends a provider reset at next launch, this same path could crash on device. Worth prioritising in **IOSP-4** (polling/realtime/CallKit consolidation) where this code is already in scope.
- The assigned audit simulator `94E0186B-…` should be reset (or the app reinstalled after clearing CallKit state) before device-class launch testing; this session used a clean Pro Max sim per the owner's instruction to "open another sim."
