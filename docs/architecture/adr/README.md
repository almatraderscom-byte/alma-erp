# Architecture Decision Records (G01 / SPEC-007)

One ADR per boundary-level decision. Filename `ADR-NNNN-kebab-title.md`, required
sections Status / Context / Decision / Consequences, status ∈ {Proposed, Accepted,
Superseded, Rejected}. Copy `TEMPLATE.md`. Reversing a frozen boundary requires a
new ADR that supersedes the old one. Lint: `node scripts/architecture/check-adr.mjs`.
Typed contract + validator: `src/agent/contracts/adr.ts`.
