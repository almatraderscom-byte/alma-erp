# SPEC-089 — Baseline (capability broker & fallback)
Parent: SPEC-088 (`1e5d7edd`). Owned zones: capabilities, prisma/agent-capability.

The resolver (SPEC-088) ranks capabilities but nothing turns a capability into a
concrete callable TOOL with a fallback chain. G08 provides `callability` (removed
tools excluded) + `getManifest` (decoupled).

Discovery:
```
$ grep -rn "broker\|callableTools" src/agent/capabilities  # none before this spec
$ grep -n "export function callability" src/agent/tools/registry/deprecation.ts
```
Note: the bare specifier `@/agent/tools/registry` resolves to the monolith FILE;
G09 imports G08 via explicit package paths (`.../registry/deprecation`, `.../manifests`).

Migration boundary: broker = resolve ∘ per-capability callable-tool ranking ∘
cross-capability fallback, fail-closed on no callable tool.
Files: broker.ts, tests, index.ts update.
