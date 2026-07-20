# SPEC-096 — Contract (model-view.ts, v1.0.0)
- MODEL_VIEW_BYTES=4096 (clamp [256, 32768]).
- `buildModelView({toolName,payload,correlationId,observedAtMs,maxBytes?}, store?):
  ModelView{evidenceId, view, truncated, redactedKeys[], originalBytes, viewBytes}`
  — stores full evidence, redacts secret keys, caps bytes; oversize → truncated
  preview referencing evidenceId (fail-closed).
- Boundary `compactModelView(raw, store?): ComponentResult<ModelView>` —
  identity-enforced; evidenceId in evidenceIds[]; never throws.
