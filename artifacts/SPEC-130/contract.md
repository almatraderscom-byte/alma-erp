# SPEC-130 — Contract (bypass-gate.ts + check-gateway-bypass.mjs)
Rules (false-positive-free by scope):
- Rule A gateway-core-network-call: a file under src/agent/tool-gateway/ (except
  the adapter stage + tests + `gateway-adapter-ok` lines) with a direct network
  call (fetch/axios/WebSocket/http client) → violation.
- Rule B gateway-aware-bypass: a file OUTSIDE the gateway that IMPORTS the gateway
  and also makes a direct network call → violation.
- `scanFileForBypass(file, src): BypassViolation[]` (pure). Runner walks src/agent,
  exit 1 on any violation. Legacy code that neither lives in nor imports the
  gateway is out of scope (never false-flagged).
