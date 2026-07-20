# SPEC-072 — Security proof
`validateManifest` enforces the full ExecutionIdentity via G01 `validateRequest`
(missing tenant/actor → FAILED_FINAL, fail-closed, INV-05; test present).
Malformed manifests → MALFORMED_INPUT, never a throw, never default-allow.
Secret scan of `src/agent/tools/manifests/`: none. Manifests carry metadata only,
no payloads/secrets (INV-07). PASS.
