# SPEC-073 — Security proof
`queryManifests` enforces the full ExecutionIdentity (missing tenant/actor →
FAILED_FINAL, fail-closed; test present). Loader fails closed at load on any
corrupt/duplicate package (throws) rather than serving a partial registry.
Secret scan of manifests dir: none. Metadata only, no payloads/secrets (INV-07).
PASS.
