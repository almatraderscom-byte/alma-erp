# SPEC-143 architecture scan
- No model/provider/tool/DB/clock/RNG in concurrency.ts (pure counting).
- Ownership-zone diff: only `src/worker/queues/**`.
- Forbidden-import gate PASS at group checkpoint (imports `@/agent/contracts` + local queue only).
- No secret/payload surface.
