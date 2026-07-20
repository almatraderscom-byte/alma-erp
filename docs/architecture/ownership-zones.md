# Repository Ownership Zones (G01 / SPEC-003)

Source of truth: `src/agent/contracts/ownership.ts` (tested). Gate:
`scripts/architecture/check-ownership.mjs`.

| Zone (prefix) | Owner | Team | Notes |
| --- | --- | --- | --- |
| `docs/architecture` | G01 | @alma/architecture | this group |
| `scripts/architecture` | G01 | @alma/architecture | this group |
| `src/agent/contracts` | G01 | @alma/architecture | this group |
| `artifacts` | G01 | @alma/architecture | proof |
| `prisma/schema.prisma` | integration | @alma/architecture | **choke point** |
| `package.json` / `package-lock.json` | integration | @alma/architecture | **choke point** |
| `.github` | integration | @alma/architecture | **choke point** |
| `src/app/api/assistant` | agent | @alma/agent | agent API |
| `src/app/agent` | agent | @alma/agent | agent UI |
| `src/agent` | agent | @alma/agent | agent code |
| `src/app/api/agent` | frozen-legacy | @alma/agent | **frozen — never touch** |
| `src/app` | erp | @alma/erp | ERP production |
| `src/lib` | erp | @alma/erp | shared libs |

## Enforcement
- `--emit-codeowners` renders the CODEOWNERS proposal.
- `--owner G01` fails if the branch diff touches any non-G01 (or choke-point) path.
- "No concurrent edits to the same ownership zone" (RUNNER) is enforceable by
  running the gate per group session.
