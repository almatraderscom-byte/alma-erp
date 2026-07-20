# SPEC-099 — Contract (provenance.ts, v1.0.0)
- RESULT_SOURCES = tool|search|browser|summary.
- `Provenance{toolName, evidenceId, tenantId, correlationId, source, observedAtMs,
  truncated, contract}`.
- `buildProvenancedView(input, store?): {provenance, view}` — composes SPEC-096
  model view + provenance envelope.
- `checkProvenance(p)/isTraceable(p)` — fail-closed: MISSING_TOOL|MISSING_EVIDENCE|
  MISSING_TENANT|MISSING_CORRELATION|BAD_SOURCE.
- Boundary `provenancedResult(raw, store?): ComponentResult<ProvenancedView>` —
  never emits an un-traceable result; identity-enforced; never throws.
