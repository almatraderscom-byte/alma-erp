# SPEC-145 architecture scan
- No direct model/provider/tool/DB/clock/RNG. Reconcile probe I/O stays behind the G14 seam; this module decides over an injected finding.
- Ownership-zone diff: only `src/worker/queues/**`. Imports `@/agent/workflows/{lease,reconcile}` + `@/agent/contracts` (read-only, allowed one-way).
- Forbidden-import gate PASS at group checkpoint.
- No secret/payload surface (task carries payloadRef only).
