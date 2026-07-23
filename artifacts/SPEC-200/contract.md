# SPEC-200 contract — Final architecture certification

## Public contract
- Module: `src/agent/release/certification.ts`.
- Types: `CertificationPayload` (zod-validated: `expectedSpecCount`, `auditedCommit`, `gateSteps[]`, `specProofs[]`, `checklist[]`), `CertificationSummary`, `CERT_REASON_CODES`, `REQUIRED_GATE_STEPS`.
- Boundary fn: `certifyArchitecture(req: ComponentRequest<CertificationPayload>): ComponentResult<CertificationSummary>` — G01 `ComponentResult`, never throws, no ambiguous boolean success.
- Helper: `certificationDigest(payload)` — sha256 over canonical (key-sorted) JSON; same evidence ⇒ same digest.
- Contract version: `CERTIFICATION_CONTRACT_VERSION = '1.0.0'`.

## Finite reason codes (append-only)
`GATE_STEP_MISSING`, `GATE_STEP_FAILED`, `SPEC_SET_INCOMPLETE`, `SPEC_PROOF_MISSING`, `SPEC_VERDICT_NOT_PASS`, `CHECKLIST_UNSATISFIED`, `CHECKLIST_NO_EVIDENCE` — emitted alongside canonical `POLICY_DENIED`; envelope failures reuse G01 codes (`MISSING_TENANT`, `CONTRACT_VERSION_MISMATCH`, `MALFORMED_INPUT`).

## Decision rules (all fail-closed)
1. Identity invalid ⇒ `DENIED`. Contract version mismatch ⇒ `FAILED_FINAL`. Malformed/oversized payload ⇒ `FAILED_FINAL`.
2. Every `REQUIRED_GATE_STEPS` id (contracts-typecheck, contracts-tests, forbidden-imports, ownership, adr-lint, proof-complete) present AND `PASS`, else `DENIED`.
3. `SPEC-001..SPEC-<expectedSpecCount>` each present, zero missing artifacts, verdict `PASS`, else `DENIED`.
4. Every checklist item satisfied and carrying a non-blank `evidenceRef`, else `DENIED`.
5. Success ⇒ `COMPLETED` with `certified: true` + deterministic digest + versions.

## Runner
`scripts/architecture/certify-architecture.mjs` (dependency-free mirror, same rules) executes the six freeze-gate steps + the three bypass gates (admission / gateway / authorization), parses `check-proof.mjs --json`, evaluates the machine-verified checklist and writes `artifacts/SPEC-200/certification.json`. Exit 0 only when CERTIFIED. Checklist rows without an executable gate are deliberately absent — certification asserts exactly what was proven (constitution rule 10).
