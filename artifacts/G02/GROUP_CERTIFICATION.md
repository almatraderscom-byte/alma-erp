# G02 — GROUP CERTIFICATION

Group: G02 — Request Admission Control Plane
Branch: `aios/G02-admission` (stacked on certified `aios/G01-architecture-freeze`)
Base tree (G01): `a75b7442…`

```
Group: G02
Specs: SPEC-011..SPEC-020
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G02 built
The single admission door into the AIOS request path, entirely in the new zone
`src/agent/control-plane/admission` (deterministic, no LLM — INV-01):

| Spec | Deliverable |
| --- | --- |
| SPEC-011 | `admit()` gateway + `AdmissionStage` interface + registry |
| SPEC-012 | source normalization (telegram/assistant/cron → one shape) |
| SPEC-013 | deterministic fast-path command router (0 model calls) |
| SPEC-014 | `TaskEnvelope` — the pinned hand-off to G04/G05 |
| SPEC-015 | intent classification adapter (bounded seam, deterministic default) |
| SPEC-016 | complexity classification (SIMPLE/STANDARD/COMPLEX) |
| SPEC-017 | planning-need classification (NONE/PLAN) |
| SPEC-018 | risk classification (money/destructive → HIGH, fail-closed) |
| SPEC-019 | dedup & replay protection (idempotency; in-memory + durable seam) |
| SPEC-020 | admission bypass CI gate (gateway is the only door) |

## Group integration checkpoint
| Check | Result | Evidence |
| --- | --- | --- |
| Full repository typecheck | **PASS** | `npx tsc --noEmit` → exit 0 |
| Full relevant test suite | **PASS** | `vitest run src/agent/control-plane` → 64/64 (10 files) |
| Database migration validation | **PASS** | 0 migrations; `prisma/` untouched |
| Architecture / forbidden-import scan | **PASS** | ERP→agent: 0 new |
| Admission bypass gate | **PASS** | 0 bypasses; injection→FAIL proven |
| Tenant-isolation / fail-closed subset | **PASS** | gateway + risk + dedup → 21/21 |
| Security (secret scan) | **PASS** | clean |
| Cost & latency vs baseline | **PASS** | 0 model calls, $0.00 (deterministic) |
| Rollback from final group state | **PASS** | revert(G01..HEAD) → tree `a75b7442…` = G01 (MATCH) |
| `GROUP_CERTIFICATION.md` | **PASS** | this file |

## Scope discipline
- 196 files changed vs G01 base, **3221 insertions, 0 modifications, 0 deletions**.
- Every change within `src/agent/control-plane/admission` + `artifacts/`.
- **Frozen Hermes legacy API `src/app/api/agent` — 0 files touched** (owner
  decision ক: admission is exposed via new `src/app/api/assistant/*` when wired,
  never the live legacy door). No `prisma/`, no CI, no lockfile.

## Interface pinned to the rest of the roadmap (G01 seam)
Admission consumes G01 contracts directly: `validateRequest`/`ComponentResult`,
`ExecutionIdentity`, `idempotencyKey`, error taxonomy. Output is the canonical
`TaskEnvelope` — the typed hand-off G04 (Cost Governor) / G05 (Context Compiler)
consume. No vague seams.

## Integrity notes (transparency — corrections made mid-group)
Two defects were caught and fixed **within** the group, not hidden:
1. **SPEC-012 false-PASS:** a stale SPEC-011 test (`ADMISSION_STAGES === []`)
   regressed when SPEC-012 registered a stage; the capture helper had hidden the
   failing summary. Fixed the assertion, hardened the helper to fail loudly, and
   re-verified. See `artifacts/SPEC-012/CORRECTION.md`.
2. **SPEC-018 classifier bug:** "what is the order status?" was scored MED
   because the noun "order" matched a verb pattern. Made the risk classifier
   question-aware (money/destructive still force HIGH, fail-closed preserved).
   See `artifacts/SPEC-018/CORRECTION.md`.

## Known tracked seam (non-blocking)
Dedup uses an in-memory store; a durable Redis-backed `DedupStore` must be wired
before admission spans instances (VPS Redis, owner decision). Interface ready; no
fake durability shipped.

## Verdict
**G02 PASS.** Admission control plane complete, deterministic, fail-closed, and
green. Nothing in production or the live Hermes bot was touched. Per
PARALLEL_GROUP_PLAN (corrected), Wave 2 also contains G03 and G08; this Group
Runner does not start another group.
