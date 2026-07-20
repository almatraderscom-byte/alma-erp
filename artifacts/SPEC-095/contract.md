# SPEC-095 — Contract (evidence-store.ts, v1.0.0)
- `evidenceIdFor(tool, payload): 'ev_'+sha256(...).slice(40)` — deterministic,
  content-addressed (no clock/randomness, INV-01).
- `EvidenceStore` interface (put/get/has/size) + `InMemoryEvidenceStore`
  (content dedupe; caller-supplied observedAtMs).
- `EvidenceRecord{evidenceId, toolName, sizeBytes, storedAtMs, correlationId, payload}`.
- Boundary `storeEvidence(raw, store?): ComponentResult<{evidenceId, sizeBytes}>`
  — returns id+size ONLY, never the payload (INV-07); evidenceId in evidenceIds[];
  identity-enforced; never throws.
