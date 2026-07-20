# SPEC-072 — Baseline (tool manifest schema)

Parent commit: SPEC-071 (`96ced212`).
Owned zones: `src/agent/tools/registry`, `src/agent/tools/manifests`.

## Current state (aliases)

The nearest thing to a "manifest" today is `src/agent/tools/capability-manifest.ts`
— it JOINS pools + groups + classification at runtime by importing the whole
monolith (`TOOLS`, `TRADING_TOOLS`, …). It is therefore coupled to prisma/network
and cannot be the deterministic, authorable manifest the decomposition needs.

Discovery:
```
$ grep -nE "^export (interface|const) " src/agent/tools/capability-manifest.ts
Capability (interface), CAPABILITIES, getCapability, exposedButUnexecutable,
executableButUnroutable, packAllowsParallelToolCalls, orphanClassificationEntries,
unclassifiedTools
$ grep -nE "mode:|risk:|domain:" src/agent/tools/tool-contract.ts   # authored facets exist but are runtime-joined
```

Facets currently spread across files: `mode/risk/domain` in
`capability-classification.ts`; input schema on each `AgentTool.input_schema`;
routing in `tool-groups.ts` + pool arrays; NO versioning, NO ownership, NO
deprecation, NO closed side-effect taxonomy.

## Migration boundary

Introduce a single authorable `ToolManifest` record (this spec) that names every
facet as typed data, decoupled from handlers. Later specs deepen each facet.

## Files expected to change

- `src/agent/tools/manifests/manifest.schema.ts` (new)
- `src/agent/tools/manifests/index.ts` (new)
- `src/agent/tools/manifests/__tests__/manifest-schema.test.ts` (new)
- `artifacts/SPEC-072/*`
