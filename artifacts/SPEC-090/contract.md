# SPEC-090 — Contract (certification-gate.ts, v1.0.0)
- `evaluateCertification(): CertReport{certified, checks[8], blockers, summary}`
  Checks (ALL must pass; fail-closed): INTENT, TOOLS, COVERAGE, PERMISSION, COST,
  RUNTIME_OWNER, HEALTH, BROKERABLE (every capability brokers to a callable tool
  for an owner). certified only when blockers empty.
- Boundary `queryCertificationGate(raw): ComponentResult<CertReport>` —
  identity-enforced; never throws.
