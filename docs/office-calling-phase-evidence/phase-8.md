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
- Validator tests prove an empty/fabricated/incomplete record remains closed and only a structurally
  complete record can pass. These tests validate the gate, not physical call behavior.

## Still required before PASS

- A frozen backend/web SHA and matching release-signed iOS/Android embedded SHAs.
- Two physical iPhones, two physical Android phones and two web clients.
- All 264 real-device/browser rows with correlated evidence.
- 100 additional real mixed-platform calls and long-call token-renewal proof.
- Canary metrics, rollback drill and explicit owner approval.
- Closure or explicit owner/security acceptance of the Phase 7 dependency exception.

No release or WhatsApp-like claim is authorized by this record.

