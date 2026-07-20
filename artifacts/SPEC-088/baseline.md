# SPEC-088 — Baseline (capability resolver)
Parent: SPEC-087 (`ec7b2c20`). Owned zones: capabilities, prisma/agent-capability.

Facets exist (intent/permission/health/cost) but nothing COMPOSES them to resolve
an intent+actor into the ranked capabilities that can serve it. Today the head
picks tool groups directly; there is no capability-level resolution.

Discovery:
```
$ grep -rn "resolveCapabilities\|resolver" src/agent/capabilities  # none before this spec
```
Migration boundary: a deterministic resolver = intent match ∘ permission filter ∘
availability filter ∘ tier ranking, fail-closed on empty.
Files: resolver.ts, tests, index.ts update.
