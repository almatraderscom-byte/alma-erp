# G18 — GROUP CERTIFICATION

Group: G18 — Specialist Agents and Known Workflows
Branch: `aios/G18-specialists` (base = integration-wave @ G14)

```
Group: G18   Specs: SPEC-171..SPEC-180   Individual PASS: 10/10
Repository integration tests: PASS   Architecture scan: PASS
Cost regression: PASS (deterministic; 0 model calls added — model call is a seam)
Security regression: PASS   Rollback drill: PASS (per spec — parent tree MATCH)
Unresolved critical risks: 0   Verdict: PASS
```

## What G18 built
Stateless specialist sub-agents + the library of known, planner-free business
workflows they run.

| Spec | Deliverable |
| --- | --- |
| 171 | Specialist runtime contract — stateless brief→result via an adapter seam, fail-closed |
| 172 | Schema-constrained output — off-schema ⇒ RETRYABLE, never passed through |
| 173 | Marketing workflow templates |
| 174 | Customer-support workflow templates |
| 175 | Finance & invoice templates — every money step reconcile-classified (INV-06) |
| 176 | ERP & office templates — writes compensated, reports read-only |
| 177 | Research templates — read-only |
| 178 | External-communication templates — every send approval-gated + reconcilable |
| 179 | Specialist retry & repair — bounded schema-repair, then fail-closed |
| 180 | Known-workflow no-planner certification — every template runs without the head |

## Integration checkpoint
| Check | Result |
| --- | --- |
| Zone typecheck | **PASS** (tsc 0) |
| G18 zone tests | **PASS** (49) |
| Full suite (merged wave) | **PASS** (see wave note) |
| Forbidden-import / admission / authz / gateway gates | **PASS** (no regression) |
| Cost vs baseline | **PASS** (deterministic; model call is a seam, INV-01) |
| Rollback (per spec) | **PASS** (revert → parent tree MATCH, all 10) |

## Scope discipline
All changes within `src/agent/specialists`, `src/agent/workflow-templates`,
`artifacts/`, plus one `.gitignore` hygiene line (transient sub-agent worktrees).
**0 modifications, 0 deletions** to existing code. Hermes, live schema, ERP money
code: **0 touched**.

## Security / correctness posture
- **Specialists are stateless & sandboxed:** brief in → result out; no memory
  writes, no side effects of their own; an adapter error is a typed FAILED_FINAL,
  never a throw.
- **Output is always shaped:** off-schema output is a RETRYABLE repair signal,
  never passed to the head unchecked (INV-05/INV-07); repair is bounded.
- **Known workflows are safe by construction:** money/publish/send steps are
  reconcile-classified (INV-06) and approval-gated (G12) at runtime; writes carry
  compensators (G14 saga); nothing runs a planner (SPEC-180 certifies it).
- **Boundary intact:** templates call the ERP only through gateway actions — no
  import of ERP code.
- **Deterministic (INV-01):** all logic pure; the only model/provider calls are
  behind seams.

## Verdict
**G18 PASS.** Unblocks G19 (verification/security/evaluation).
