# G09 — Group Certification: Capability Control Plane

```
Group: G09
Specs: SPEC-081..SPEC-090
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What was built

A deterministic Capability Control Plane in the owned zone `src/agent/capabilities`
that sits ABOVE G08 tools and binds user intent (G02) → capability → concrete tool,
carrying permission, cost/tier, runtime/owner and health metadata. Built entirely on
G01 contracts, G02 admission intent, and G08 tool manifests — no runtime dependency
on the monolith, prisma, the network or any model (INV-01). 63 capabilities are
generated from the real 326-tool G08 surface (one per domain).

| Spec | Component | Key property |
|------|-----------|--------------|
| 081 | Capability data model | zod schema + `CapabilityStore` interface + in-memory default + PROPOSED (not-applied) migration |
| 082 | Capability→intent mapping | intent-key + G02 IntentClass indexes; mutating-intent consistency |
| 083 | Capability→tool mapping | validated vs G08 manifests; catalog partitions all 326 tools exactly once |
| 084 | Permission metadata | fail-closed privilege lattice owner>staff>customer |
| 085 | Cost & model-tier metadata | Cost Governor tier hints; consistent with tool cost drivers (INV-03, no silent upgrade) |
| 086 | Runtime & owner metadata | runtime == tool routing; owner validated vs G01 zones |
| 087 | Health model | state machine + kill-switch + fail-closed availability + override store |
| 088 | Resolver | intent∘permission∘health, deterministic ranking, fail-closed on empty |
| 089 | Broker & fallback | concrete callable-tool selection + fallback chain, fail-closed |
| 090 | Certification gate | whole-plane fail-closed gate (8 facets + end-to-end brokerability) |

## Integration checkpoint results

- **Full-repo typecheck** (`tsc --noEmit`): **0 errors**.
- **Full agent suite** (`vitest run src/agent`): **236 files / 2809 tests PASS**
  (existing suites + 10 new G09 files; nothing regressed).
- **Owned-zone suite** (`vitest run src/agent/capabilities`): **10 files / 101 tests PASS**.
- **Forbidden-import gate** (`scripts/architecture/check-forbidden-imports.mjs`):
  **PASS** — no NEW forbidden imports; ERP app/api → agent: 0; 101 pre-existing
  baselined violations unchanged.
- **Migration validation**: live `prisma/schema.prisma` and `prisma/migrations/`
  are **UNTOUCHED**; `AgentCapability` is **not** in the live schema; the durable
  table ships only as a PROPOSED, explicitly not-applied file
  (`prisma/agent-capability/0001_capability_catalog.proposed.sql`). Runtime uses the
  in-memory `CapabilityStore`.
- **Ownership**: every changed file is inside `src/agent/capabilities/`,
  `prisma/agent-capability/`, or the spec proof dirs (verified via
  `git diff --name-only e80ce9da HEAD`).
- **Group rollback drill**: reverting all 10 spec commits restores the branch-base
  tree `c77cb718…` **exactly** (byte-for-byte).

## Cost & latency

No request-path cost change: the plane is deterministic data + zod, with **zero**
model/provider/DB/network calls at runtime (INV-01/INV-03). Cost-tier metadata is a
Cost Governor *hint* (a ceiling), never a call and never a silent upgrade.
Generator is dev-time only.

## Architecture posture

- Runtime imports only allowed surfaces: G01 `@/agent/contracts`, G02
  `@/agent/control-plane/admission/intent`, G08 `@/agent/tools/manifests` and
  `@/agent/tools/registry/deprecation`. It never imports the monolith `registry.ts`
  file (an intermediate SPEC-089 run caught exactly this trap — the bare
  `@/agent/tools/registry` specifier resolves to the monolith FILE — and it was
  fixed to the explicit decoupled package path before certifying).
- Every boundary speaks the frozen G01 `ComponentResult` union, enforces the full
  `ExecutionIdentity` fail-closed, and never throws.
- Permission, availability, resolution and brokerage are all fail-closed (INV-05).

## Unresolved critical risks

None (0). Per-spec `unresolved-risks.md` records only low-severity, by-design
follow-ups (durable-store adoption, richer ranking/roles wiring, the live head
cutover) — all downstream and non-blocking.

Verdict: **PASS**
