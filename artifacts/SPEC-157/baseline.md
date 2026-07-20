# SPEC-157 Baseline — Provider capability discovery
## Discovery
```text
$ rg -n "capabilit" src/agent/providers/runtime   → NONE
$ rg -n "capabilities|CapabilityGate" src/agent/models/fabric.ts → optional hook present (SPEC-151), unwired default
```
- Current: fabric has an optional `capabilities` hook, no default gate/table.
- Direct provider/network calls: none — capability discovery is a STATIC declared
  table (real provider query is a documented seam).
- Tests: 56 green pre-spec.
- Bypass paths: sending a request needing a capability (e.g. vision) to a model
  that lacks it. Prevented: gate checks BEFORE cost + provider (fail closed).
- Migration boundary: additive; default the fabric's gate to the static registry.
- Files expected: `capabilities.ts` (new), `providers/runtime/index.ts`,
  `models/fabric.ts` (default gate), tests, artifacts.
