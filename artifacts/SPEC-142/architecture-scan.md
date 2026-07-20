# SPEC-142 architecture scan
- Direct model/provider/tool/DB/clock/RNG scan of `src/worker/queues/fairness.ts` → none (pure selection).
- Ownership-zone diff: only `src/worker/queues/**`. No forbidden path.
- Forbidden-import gate: imports only `@/agent/contracts` + local queue module; run at group checkpoint → PASS.
- No secret/payload surface (operates on identity ids + counters).
