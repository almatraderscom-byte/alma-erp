# SPEC-076 — Contract  (ownership-metadata.ts, contract v1.0.0)

## checkOwnership(m): OwnershipIssue[]
Resolves `m.ownership.zonePrefix` via G01 `resolveOwner`. Codes:
- UNOWNED_ZONE     — prefix matches no G01 zone (fail-closed)
- NOT_AGENT_ZONE   — zone owner ∉ {agent} (tools may not live in ERP)
- INTEGRATION_ONLY — zone is a shared choke point
- TEAM_MISMATCH    — manifest team ≠ zone CODEOWNERS team

## checkAllOwnership(set)
Adds a domain-spans-multiple-teams check.

## ownershipByDomain(set): DomainOwnership[]   (sorted; {domain,team,zonePrefix,toolCount})
## renderToolCodeowners(set): string            (proposal only)

## Boundary
`checkToolOwnership(raw): ComponentResult` — identity-enforced; any violation →
DENIED / POLICY_DENIED (fail-closed, INV-05); never throws.
