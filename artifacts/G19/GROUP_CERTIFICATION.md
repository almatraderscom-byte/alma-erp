# G19 — GROUP CERTIFICATION

Group: G19 — Verification, Security and Evaluation
Branch: `aios/G19-verification` (base = integration-wave @ G18)

```
Group: G19   Specs: SPEC-181..SPEC-190   Individual PASS: 10/10
Repository integration tests: PASS   Architecture scan: PASS
Cost regression: PASS (deterministic; 0 model calls)   Security regression: PASS
Rollback drill: PASS (per spec — parent tree MATCH)
Unresolved critical risks: 0   Verdict: PASS
```

## What G19 built
The layer that proves the agent is correct, honest and safe before anything ships.

| Spec | Deliverable |
| --- | --- |
| 181 | Deterministic postcondition verifier — checkable predicate, not "the model says so" |
| 182 | Evidence-backed claim verifier — uncited claims are hallucinations, blocked |
| 183 | User-response gate — postconditions + claims + secret-leak + banned-address ("Boss" only) |
| 184 | Golden-task dataset — stable ground truth |
| 185 | Routing evaluation — flags CRITICAL money tasks under-routed to cheap tiers |
| 186 | Tool-selection evaluation — precision (over-exposure) / recall (gaps) |
| 187 | Cost-per-success evaluation — cheap-but-failing is not cheap |
| 188 | Prompt-injection suite — pure-regex detector, adversarial corpus |
| 189 | Policy/permission bypass suite — red-teams the composed G11/G12 stack |
| 190 | Quality & security release gate — one ship/no-ship decision |

## Integration checkpoint
| Check | Result |
| --- | --- |
| Zone typecheck | **PASS** (tsc 0) |
| G19 zone tests | **PASS** |
| Full suite (merged wave) | **PASS** (see wave note) |
| Forbidden-import / admission / authz / gateway gates | **PASS** |
| Rollback (per spec) | **PASS** (revert → parent tree MATCH, all 10) |

## Scope discipline
All changes within `src/agent/verification`, `src/agent/evals`,
`tests/agent-security`, `artifacts/`. **0 modifications, 0 deletions** to existing
code. Hermes, live schema, ERP money code: **0 touched**.

## Security / correctness posture
- **Truth is checkable, not claimed:** postconditions are deterministic predicates;
  owner-facing claims must cite existing evidence or they are blocked.
- **The response gate is fail-closed:** unverified postcondition, unbacked claim,
  secret leak, or a banned form of address ("Sir"/"স্যার") blocks the message.
- **Security suites are executable + re-run at release:** prompt-injection detection
  is pure regex (a model-based detector would itself be injectable); the bypass
  suite drives the real G11/G12 modules; the release gate re-runs both — never
  trusts a cached pass.
- **A CRITICAL money task under-routed to a cheaper tier blocks release outright.**
- **Deterministic (INV-01), executable proof (INV-10):** no LLM judges success.

## Verdict
**G19 PASS.** Unblocks G20 (observability, release & optimization) — the final group.
