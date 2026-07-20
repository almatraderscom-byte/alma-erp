# G05 — GROUP CERTIFICATION

Group: G05 — Prompt and Context Compiler
Branch: `aios/G05-context-compiler` (base = G01+G02+G03+G04)

```
Group: G05
Specs: SPEC-041..SPEC-050
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G05 built
The deterministic context compiler — assembles the model prompt from ordered
typed bundles, fits it to a token budget, and records provenance for replay.

| Spec | Deliverable |
| --- | --- |
| SPEC-041 | versioned compiler contract (ordered bundles → prompt + provenance + cacheable prefix) |
| SPEC-042 | stable constitution bundle (ALMA rules: Bangla, Boss-only, guardrails) |
| SPEC-043 | domain skill bundle |
| SPEC-044 | policy bundle |
| SPEC-045 | structured workflow-state bundle (dynamic) |
| SPEC-046 | relevant memory bundle (dynamic, truncated first) |
| SPEC-047 | exact tool-schema bundle |
| SPEC-048 | dynamic request suffix (always last) |
| SPEC-049 | token allocator (drops low-priority to fit; must-keeps protected; OVERFLOW fail-closed) |
| SPEC-050 | provenance + replay record (content hash; verifyReplay) |

## Integration checkpoint
| Check | Result |
| --- | --- |
| Full repository typecheck | **PASS** (tsc exit 0) |
| Full relevant test suite | **PASS** (190/190 across G01–G05, 41 files) |
| Database migration validation | **PASS** (no DB; nothing touched) |
| Forbidden-import + admission bypass | **PASS** |
| Security (secret scan) | **PASS** (clean) |
| Cost vs baseline | **PASS** (0 model calls; deterministic assembly) |
| Rollback from final group state | **PASS** (revert → base tree MATCH) |
| GROUP_CERTIFICATION.md | **PASS** |

## Scope discipline
186 files changed, **2209 insertions, 0 modifications, 0 deletions**; all within
`src/agent/context`, `src/agent/prompts` + `artifacts/`. Frozen Hermes + live
schema: 0 touched.

## Integrity note
SPEC-042's first attempt had a wrong test assertion (`/Sir/` matched the
"never Sir" rule text). The hardened helper flagged it; after that a guarded
committer was introduced that REFUSES to commit on a failing suite — the false-
PASS class is now structurally prevented for this group. Corrected + re-verified
(see `artifacts/SPEC-042/CORRECTION.md`).

## Verdict
**G05 PASS.** Context compiler complete, deterministic, replayable, green.
Production untouched. With G05 done, **G06 (Memory) and G16 (Model Fabric) are
now unblocked** and can run in parallel.
