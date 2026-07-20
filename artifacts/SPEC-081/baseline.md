# SPEC-081 — Baseline (capability data model)

G09 base commit: `e80ce9da`. Owned zones: `src/agent/capabilities`,
`prisma/agent-capability`.

## Current state / aliases
There is NO capability layer today. The head routes via G08 tool groups
(`TOOL_GROUPS`, 14) and G02 admission intent classes, but there is no first-class
"capability" that binds intent → tools + permission + cost + runtime + health.

Discovery:
```
$ ls src/agent/capabilities        # did not exist
$ grep -rn "capabilit" src/agent/tools src/agent/control-plane | grep -vi "Capability (G08 manifest)" | head
# G08 has capability-manifest.ts (tool-level); G09 introduces the ability-level plane
$ grep -n "INTENT_CLASSES" src/agent/control-plane/admission/intent.ts  # G02 intent taxonomy
$ grep -c '"id":"cap' /dev/null    # no catalog existed
```

## Prereqs consumed
- G01 `@/agent/contracts` (ComponentResult, ExecutionIdentity, REASON_CODES).
- G02 `@/agent/control-plane/admission/intent` (INTENT_CLASSES) — type-only chain,
  deterministic.
- G08 `@/agent/tools/manifests` (ALL_MANIFESTS/loader) — decoupled, used dev-time
  by the catalog generator only.

## Direct provider/model/tool/DB calls
None in runtime. Generator imports G08 loader at dev time (no prisma/network).

## Tenant/permission/audit propagation
New boundary enforces the G01 ExecutionIdentity fail-closed. Permission metadata
itself is SPEC-084.

## Likely bypass paths
- Importing the tool monolith or prisma at runtime (would couple). Mitigated:
  runtime imports only G01 contracts + G02 intent const; G08 import is dev-time.

## Proposed migration boundary
`src/agent/capabilities/` hosts the deterministic capability plane. Durable table
is a PROPOSED (not-applied) migration under `prisma/agent-capability/`; runtime
uses an in-memory store behind a `CapabilityStore` interface.

## Files expected to change
- capability.schema.ts, store.ts, capability-model.ts, catalog.generated.ts,
  scripts/build-catalog.ts, index.ts (new)
- prisma/agent-capability/0001_capability_catalog.proposed.sql + README.md (new)
- tests + artifacts/SPEC-081/*
