# G07 — GROUP CERTIFICATION

Group: G07 — Prompt Caching and Response Caching
Branch: `aios/G07-caching` (base = G03+G05+G06)

```
Group: G07
Specs: SPEC-061..SPEC-070
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS (this group SAVES money)
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G07 built
The caching layer that cuts model spend without breaking correctness or isolation.

| Spec | Deliverable |
| --- | --- |
| SPEC-061 | stable-prefix hashing (key unaffected by dynamic suffix → prompt caching) |
| SPEC-062 | provider prompt-cache adapter (seam + deterministic fake, no real call) |
| SPEC-063 | cache-break diagnostics (which bundle broke the prefix) |
| SPEC-064 | conversation cache-key strategy (tenant + prefix + request) |
| SPEC-065 | exact deterministic response cache |
| SPEC-066 | semantic read-only response cache (cosine, tenant-isolated) |
| SPEC-067 | tool-result cache with freshness (TTL; stale never served) |
| SPEC-068 | policy/permission exclusions (fail-closed — never cache money/permission/side-effect) |
| SPEC-069 | cross-tenant isolation (fail-closed; multi-tenant property proof) |
| SPEC-070 | savings + correctness dashboard (money saved in nano-USD; hit + verified rate) |

## Integration checkpoint
| Check | Result |
| --- | --- |
| Full repository typecheck | **PASS** (tsc exit 0) |
| Full relevant test suite | **PASS** (281/281 across G01–G07, 61 files) |
| Database migration validation | **PASS** (no DB; in-memory + seam) |
| Forbidden-import scan | **PASS** |
| Security (secret scan + cross-tenant) | **PASS** (isolation proven) |
| Cost vs baseline | **PASS** — this group *reduces* spend (savings dashboard) |
| Rollback from final group state | **PASS** (revert → base tree MATCH) |
| GROUP_CERTIFICATION.md | **PASS** |

## Scope discipline
191 files changed, **2348 insertions, 0 modifications, 0 deletions**; all within
`src/agent/cache`, `src/agent/providers/cache` + `artifacts/`. Frozen Hermes +
live schema: 0 touched.

## Security posture (the important part for caching)
- Every cache key embeds the tenant; `assertKeyTenant` is fail-closed and a
  multi-tenant property test proves NO key is ever authorised for another tenant.
- Cache eligibility is fail-closed: side-effecting, permission-dependent,
  HIGH-risk (money/destructive), or non-read-only responses are NEVER cached.
- Tool results carry a TTL; stale results are evicted, real-time tools (ttl=0)
  are never cached.

## Verdict
**G07 PASS.** Caching layer complete, deterministic, tenant-isolated, money-saving,
green. Production untouched. This Group Runner does not start another group.
