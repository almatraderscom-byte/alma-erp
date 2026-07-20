# SPEC-152 Contract — Deterministic T0 path

- `T0Template { key, render(vars) }` — pure deterministic renderer.
- `DEFAULT_T0_TEMPLATES` — `echo`, `ack` (Boss-addressed), `kv` (stable key order).
- `createT0Handler(templates?)` — a `TierHandler` whose `prepare` returns a
  `RESOLVED` value (no provider call); `finalize` is defensive passthrough.
- Registered as `T0` in `defaultTierHandlers()`.
- New reason code: `MODEL_T0_TEMPLATE_UNKNOWN` (fail closed on unknown key).

Guarantees: no LLM call, no cost authorization, `usage=0`, `attempts=0`,
`deterministic=true`. Unknown key / wrong taskKind / missing key fail closed.
