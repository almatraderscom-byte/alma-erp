# SPEC-128 — Contract (evidence-capture.ts)
- `evidenceCaptureStage: GatewayStage` — no rawPayload ⇒ FAILED_FINAL. Else:
  (1) store FULL raw payload → evidenceId (G10, access-controlled, authoritative);
  (2) applyViewObligations(raw, obligations) (G11 redact/mask) BEFORE bounding;
  (3) boundedOutputView(obligated) (G08, byte-cap + secret-redact);
  (4) provenance {toolName, evidenceId, tenantId, correlationId, source:'tool',
      observedAtMs, truncated}. Advances with evidenceId + view={provenance, view}.
- Wired seventh (after execution). Model gets ctx.view only, never rawPayload.
