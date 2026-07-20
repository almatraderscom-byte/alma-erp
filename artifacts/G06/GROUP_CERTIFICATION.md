# G06 — GROUP CERTIFICATION

Group: G06 — Conversation State and Memory
Branch: `aios/G06-memory` (base = G01+G05)

```
Group: G06
Specs: SPEC-051..SPEC-060
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G06 built
Conversation state + long-term memory, deterministic and tenant-isolated:

| Spec | Deliverable |
| --- | --- |
| SPEC-051 | immutable append-only transcript |
| SPEC-052 | copy-on-write active-session state |
| SPEC-053 | pending-approval state (fail-closed: actionable only when approved) |
| SPEC-054 | conversation compaction policy (deterministic split; summary is a seam) |
| SPEC-055 | semantic memory store (cosine; embeddings are INPUTS; pgvector seam) |
| SPEC-056 | episodic execution memory |
| SPEC-057 | relevance scoring (similarity + recency decay) |
| SPEC-058 | privacy & tenant isolation (G05 guard; bounded model view, INV-07) |
| SPEC-059 | expiration (TTL) + correction (supersede, immutability kept) |
| SPEC-060 | retrieval evaluation suite (precision@k quality gate) |

## Integration checkpoint
| Check | Result |
| --- | --- |
| Full repository typecheck | **PASS** (tsc exit 0) |
| Full relevant test suite | **PASS** (237/237 across G01–G06, 51 files) |
| Database migration validation | **PASS** (live schema.prisma untouched; pgvector model PROPOSED only, not applied) |
| Forbidden-import scan | **PASS** |
| Security (secret scan) | **PASS** (clean) |
| Cost vs baseline | **PASS** (0 model calls; embeddings are inputs) |
| Rollback from final group state | **PASS** (revert → base tree MATCH) |
| GROUP_CERTIFICATION.md | **PASS** |

## Scope discipline
192 files changed, **2604 insertions, 0 modifications, 0 deletions**; all within
`src/agent/memory`, `prisma/agent-memory` (proposed only) + `artifacts/`. Live
`prisma/schema.prisma` + frozen Hermes: **0 touched**. Legacy agent memory code
untouched.

## Owner decisions honoured (established pattern)
1. DB → interface + in-memory + PROPOSED pgvector migration (no live DB, no migration run).
2. Semantic memory takes **pre-computed embeddings** — no embedding API call, stays deterministic (INV-01).
3. Tenant/business isolation fail-closed via the G05 guard; models get bounded views (INV-07).

## Integrity note
SPEC-058's test carried a TS cast error that vitest (esbuild, no typecheck)
didn't catch and the guarded committer didn't gate on. Full-repo typecheck at
certification caught it; fixed + re-verified (tsc exit 0); the committer is now
noted to gate on typecheck too. See `artifacts/SPEC-058/CORRECTION.md`.

## Verdict
**G06 PASS.** Memory + conversation state complete, deterministic, tenant-isolated,
green. Production untouched. This Group Runner does not start another group.
