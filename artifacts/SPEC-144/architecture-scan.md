# SPEC-144 architecture scan
- No model/provider/tool/DB/clock/RNG in scheduling.ts (pure comparator + selection).
- Ownership-zone diff: only `src/worker/queues/**`.
- Forbidden-import gate PASS at group checkpoint.
- No secret/payload surface.
