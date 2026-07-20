# G10 — Group Certification: Tool Selection and Tool Result Firewall

```
Group: G10
Specs: SPEC-091..SPEC-100
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

A deterministic two-sided tool firewall in the owned zones `src/agent/tools/selection`
and `src/agent/tools/results`, built on G01 contracts, G08 tool manifests/registry,
G09 capabilities, and the G05 finops token estimator. No runtime dependency on the
monolith, prisma, the network or any model (INV-01).

**Selection side** (what the model is offered):

| Spec | Component | Property |
|------|-----------|----------|
| 091 | Domain-first retrieval | permission-scoped via G09 resolver; never the full 326-surface as fallback |
| 092 | Exact shortlist | hard cap (≤ MAX_SHORTLIST=24), safest-first ranking |
| 093 | Schema token minimization | annotation-strip + description caps; tokensAfter ≤ tokensBefore (finops estimator) |
| 094 | Argument validation | fail-closed (unknown tool / oversize / schema violation → DENY) |

**Result firewall side** (what the model is shown back — INV-07):

| Spec | Component | Property |
|------|-----------|----------|
| 095 | Evidence storage | full payload stored, content-addressed id; boundary returns id only, never the payload |
| 096 | Compact model-view | secret-redacted + hard byte-capped (oversize → evidence-referenced truncation) |
| 097 | Summarization without LLM | deterministic structural shrink; honest truncation marks |
| 098 | Search/browser normalization | canonical {title,url?,snippet}; http(s)-only urls; bounded |
| 099 | Provenance | every view traceable to evidence + identity; fail-closed on un-traceable |
| 100 | Regression gate | fail-closed whole-firewall certification (8 invariants, incl. no-secret-leak + byte-bound) |

## Integration checkpoint results

- **Full-repo typecheck** (`tsc --noEmit`): **0 errors**.
- **Full agent suite** (`vitest run src/agent`): **312 files / 3189 tests PASS**
  (existing suites + 10 new G10 files; nothing regressed).
- **Owned-zone suite** (`vitest run src/agent/tools/selection src/agent/tools/results`):
  **10 files / 82 tests PASS**.
- **Forbidden-import gate**: **PASS** — no NEW forbidden imports; ERP app/api → agent: 0.
- **Ownership**: every changed file is inside `src/agent/tools/selection/`,
  `src/agent/tools/results/`, or the spec proof dirs (verified via
  `git diff --name-only 113c0d7d HEAD`). No live `prisma/schema`, no
  `prisma/migrations`, no `src/app/api/agent` (frozen Hermes) touched.
- **Group rollback drill**: reverting all 10 spec commits restores the branch-base
  tree `170d9883…` **exactly**.

## Cost & latency

No request-path cost change: the firewall is deterministic data + zod + a heuristic
token estimator, with **zero** model/provider/DB/network calls at runtime
(INV-01/INV-03). Its PURPOSE is cost + safety control — it bounds the tool surface
(≤24 tools), minimizes tool-schema tokens (after ≤ before), and caps every result
view (≤ 4 KiB) so both the request and response token budgets are firewalled.

## Notable finding (honesty record)

SPEC-100's regression gate caught a REAL bound-escape bug it was built to catch: the
compact model view's truncated envelope serialized to 4654 bytes (> the 4096 cap)
because the wrapper + JSON-escaping were not accounted for. Fixed in `model-view.ts`
(deterministic preview-trim until the whole envelope fits `cap`); re-run confirmed
4016 ≤ 4096 and all 8 invariants PASS. PASS was never certified for any spec until
BOTH the vitest summary and `tsc` were clean.

## Architecture posture

- G08 registry package imports use explicit decoupled paths
  (`@/agent/tools/registry/io-schema`), never the bare `@/agent/tools/registry`
  specifier (which resolves to the monolith FILE) — the same trap caught in G09.
- Every boundary speaks the frozen G01 `ComponentResult` union, enforces the full
  `ExecutionIdentity` fail-closed, and never throws.
- The result firewall is fail-closed and INV-07-complete: models receive only
  bounded, secret-redacted, provenance-stamped views; full payloads stay in evidence.

## Unresolved critical risks

None (0). Per-spec `unresolved-risks.md` records only low-severity, by-design
follow-ups (durable evidence store, per-tool schema migration, semantic ranking) —
all downstream and non-blocking.

Verdict: **PASS**
