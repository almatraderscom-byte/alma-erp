# ADR-0001: Freeze the AIOS request path and governance boundaries

## Status
Accepted

## Context
The 200 AIOS specifications (G01–G20) all derive from one target request path:
Admission → Cost Governor → Context Compiler → Capability Broker → Policy/Approval
→ Durable Workflow → Secure Tool Gateway → Evidence Verification → Response Gate →
Audit+Cost+Evaluation. Without a frozen baseline, parallel group sessions could
each drift the boundaries, making later integration impossible. The live ERP is
production and the agent module is one-way dependent on it.

## Decision
Freeze the request path and the ten non-negotiable invariants as the canonical
architecture (see `docs/architecture/invariants.md`). Encode them as typed,
tested contracts under `src/agent/contracts` and executable gates under
`scripts/architecture`. Any future reversal of a frozen boundary REQUIRES a new
ADR that supersedes this one and a regenerated dependency plan.

## Consequences
- Later groups refine implementation details but may not reverse boundaries
  without an ADR — enforced socially by this process and technically by the
  freeze gate (SPEC-010).
- Pre-existing ERP→agent dependency debt is frozen in a baseline ratchet
  (SPEC-002) rather than fixed here, because G01 must not modify production code.
- The head model choice (Gemini 3.1 Pro) and tier routing remain owner-tunable
  per CLAUDE.md and are out of scope for this freeze.
