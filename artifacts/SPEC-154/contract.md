# SPEC-154 Contract — Cheap specialist T2 tier
- `createT2Handler()` registered as `T2`.
- Requires `taskKind = specialist` and `role ∈ {ops,orders,cs,marketing,research}`
  (`T2_ROLES`); else `MALFORMED_INPUT`.
- Role hint drives registry model selection: `ops`→DeepSeek, `cs`→Qwen (stronger
  Bangla) — caller never names a vendor model.
- Output bounded to T2 ceiling (4000); `json` validated, `text` passthrough.
- `cs` Bangla-quality gate is a documented response-gate seam, not in the fabric.
