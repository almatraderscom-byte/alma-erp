# SPEC-090 — Baseline (capability certification gate)
Parent: SPEC-089 (`c6f1503b`). Owned zones: capabilities, prisma/agent-capability.

Facets 082–089 each check one aspect; nothing composes them into a single
whole-plane certification proving the capability control plane is coherent AND
executable end-to-end (resolvable → brokerable to a callable tool).

Discovery:
```
$ grep -rn "evaluateCertification\|certification" src/agent/capabilities  # none before this spec
```
Migration boundary: a fail-closed gate composing all facet checks + a brokerability
end-to-end check.
Files: certification-gate.ts, tests, index.ts update.
