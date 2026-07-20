# SPEC-079 — Contract  (runtime-registry.ts, contract v1.0.0)

- `buildRuntimeRegistry(mode, manifests?): RuntimeRegistry{mode, authoritative,
  entries, byName, toolCount, callableCount}` — assembles manifest + riskProfile +
  input schema + callability per tool. Authority from G01 `decide(mode)`:
  enforce → new, else legacy. Under enforce, removed tools are dropped (fail-closed).
- `toolDefinitions(registry): RuntimeToolDefinition[]` — model-facing
  name/description/input_schema (replaces TOOL_DEFINITIONS).
- `shadowCompare(manifests?): ShadowComparison{matched,onlyInNew,onlyInInventory,parity}`
  vs the SPEC-071 inventory (migration evidence, INV-09).
- Boundary `queryRuntimeRegistry(raw): ComponentResult` — build|definitions|
  shadowCompare; identity-enforced; never throws.
