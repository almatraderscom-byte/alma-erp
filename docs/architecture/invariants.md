# AIOS Architecture Invariants & Forbidden Dependencies (G01 / SPEC-002)

Source of truth: `src/agent/contracts/invariants.ts` (typed + unit-tested).
Executable gate: `scripts/architecture/check-forbidden-imports.mjs`.

## The ten invariants (frozen)

| ID | Invariant |
| --- | --- |
| INV-01 | No LLM call for deterministic validation, routing, permission, budget arithmetic or postcondition checking. |
| INV-02 | Every authoritative operation carries tenant, actor, agent, workflow, step and correlation identities. |
| INV-03 | Every model call is pre-authorized by the Cost Governor once it exists. |
| INV-04 | Every external side effect goes through the Tool Gateway once it exists. |
| INV-05 | Permissions and approvals fail closed. |
| INV-06 | Unknown external outcomes enter reconciliation; never blindly retried. |
| INV-07 | Full provider/tool payloads stay in evidence storage; models receive bounded views. |
| INV-08 | New behavior is feature-flagged and rollback-tested. |
| INV-09 | Existing public behavior remains compatible until migration evidence passes. |
| INV-10 | Completion requires executable proof, not an explanation. |

## Forbidden dependency rules (one-way)

```
erp-app     ─✗─> agent, agent-contracts
erp-api     ─✗─> agent, agent-contracts
shared-lib  ─✗─> agent, agent-contracts
agent       ─✓─> shared-lib        (allowed: agent may import ERP shared libs)
everything  ─✓─> shared-lib
```

This encodes the CLAUDE.md hard rule: *"agent may import ERP shared libs; ERP
code must NEVER import from `src/agent/`."*

## Enforcement (architecture ratchet)

`node scripts/architecture/check-forbidden-imports.mjs` walks `src/**`, resolves
`@/agent*` and `src/agent*` import specifiers, and reports forbidden
ERP/shared → agent imports.

The live repository **already** contains pre-existing violations of the target
rule (production code this group must not modify). Rather than fake a clean
state, the gate uses a frozen **baseline**
(`docs/architecture/forbidden-imports.baseline.json`, 101 known violations across
44 files). The gate:

- exits **0** when there are no *new* violations beyond the baseline;
- exits **1** and lists offenders on any *new* regression;
- `--update-baseline` re-freezes the current set (deliberate, reviewed action).

Verified behaviour: injecting one new `src/app → @/agent` import makes the gate
report `FAIL — 1 NEW forbidden import`; removing it returns to `PASS`.

The important CLAUDE.md invariant — **ERP app/api must never import the agent** —
is enforced as a hard boundary; the baseline debt is tracked in
`docs/architecture/dependency-debt.md` for later groups to unwind. The boundary
can only tighten, never regress.
