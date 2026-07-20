# SPEC-079 — Baseline (generated runtime registry)

Parent: SPEC-078 (`5c9b33b2`). Owned zones: registry, manifests.

Today the runtime tool surface is the monolith: `registry.ts` hand-assembles
`TOOLS` (86-import array) and derives `TOOL_DEFINITIONS = TOOLS.map(...)` for the
model. It is coupled to prisma/handlers and has no feature-flag seam and no
migration-evidence comparison.

Discovery:
```
$ grep -n "export const TOOLS\|TOOL_DEFINITIONS" src/agent/tools/registry.ts
542:export const TOOLS: AgentTool[] = [...]
640:export const TOOL_DEFINITIONS = TOOLS.map(...)
```

Migration boundary: a runtime registry BUILT from the decomposed facets, driven by
the G01 feature-flag ladder, with a shadow comparison proving parity with the
SPEC-071 inventory before any `enforce` switch.

Files expected: `runtime-registry.ts`, tests, `index.ts` update.
