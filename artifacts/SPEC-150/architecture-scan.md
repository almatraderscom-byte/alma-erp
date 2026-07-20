# SPEC-150 architecture scan
- No model/provider/tool/DB/clock/RNG in either chaos module (all inputs are constants; probe/model/browser are the same deterministic seams as 141–149).
- Ownership-zone diff: only `src/worker/queues/**` and `src/agent/browser-runtime/**`.
- Forbidden-import gate PASS at group checkpoint.
- No secret surface; browser chaos explicitly asserts secrets are redacted out.
