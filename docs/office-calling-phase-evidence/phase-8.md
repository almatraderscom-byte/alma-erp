# Office Calling Phase 8 Evidence — Full Matrix, Soak, Canary and Release

**Current verdict:** `PHASE 8: NOT PASS — NON-DEVICE PREPARATION COMPLETE; SIGNED PHYSICAL EVIDENCE REQUIRED`

**Verifier:** Codex

Phase 8 is intentionally the only hardware/release gate. It must not be marked PASS from compilers,
simulators, screenshots or synthetic JSON.

## Prepared and agent-verified

- Executable evidence validator/template: `scripts/office-call-release-gate.mjs`.
- Deterministic coverage: 12 directional platform/device pairs × 22 scenarios = 264 mandatory rows.
- Required per-row assertions: server, caller, callee, system UI, Agora, two-way audio, history and
  event ledger, plus call ID/log/video references.
- Independent 100-call mixed-platform soak and >60-minute token-renewal gates.
- Baseline/canary SLO comparison, ≤5-minute rollback drill, exact artifact SHA and owner-approval gates.
- Support, permission recovery, evidence capture and go/no-go runbook:
  `docs/office-calling-support-release-runbook.md`.
- Pre-device completeness re-audit closed two residual gaps before hardware testing: Android now surfaces
  a validated FCM wake immediately and reconciles canonical truth asynchronously, and server `MISSED`
  termination now emits a distinct durable callee notification (`office_call_missed`).
- Validator tests prove an empty/fabricated/incomplete record remains closed and only a structurally
  complete record can pass. These tests validate the gate, not physical call behavior.

## Pre-device completeness verification — 18 July 2026

Audited on branch `agent/office-calling-whatsapp`, based on
`daecf5cb3d15ed00c023f63072b8dc7883825517` before the completeness patch.

- Office-call Vitest suite: 9 files, 55 tests passed.
- `tsc --noEmit`: passed. Repository `next lint`: passed with warnings only; a pre-existing unescaped
  display quote in Creative Studio was encoded so the full lint gate could run cleanly.
- Next.js optimized build: compiled successfully and generated all 377 static pages (`--no-lint` was
  used because lint and type-check were already executed as separate hard gates).
- Android: `testDebugUnitTest`, `assembleDebug`, and `compileReleaseKotlin` passed. Packaged APK inspection
  confirmed `OfficeCallFirebaseService`, the FCM messaging event, `IncomingCallActivity`,
  `showWhenLocked`, `turnScreenOn`, full-screen intent, phone-call foreground-service and own-call permissions.
- iOS unsigned generic-device build: `BUILD SUCCEEDED`. Built `Info.plist` confirmed `audio`, `voip`,
  `remote-notification` and the Office-call microphone purpose string; the binary contains the
  PushKit/CallKit adapter and VoIP registry delegate.
- `git diff --check`: passed.

These are engineering/static/build results only. They do not replace the signed physical matrix below.

## Still required before PASS

- A frozen backend/web SHA and matching release-signed iOS/Android embedded SHAs.
- Two physical iPhones, two physical Android phones and two web clients.
- All 264 real-device/browser rows with correlated evidence.
- 100 additional real mixed-platform calls and long-call token-renewal proof.
- Canary metrics, rollback drill and explicit owner approval.
- Closure or explicit owner/security acceptance of the Phase 7 dependency exception.

No release or WhatsApp-like claim is authorized by this record.
