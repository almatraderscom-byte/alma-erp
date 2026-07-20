# Dependency Debt — pre-existing ERP/shared → agent imports (G01 / SPEC-002)

Frozen baseline: `docs/architecture/forbidden-imports.baseline.json`
(**101** import violations across **44** files). These predate the AIOS
architecture freeze and live in production code that G01 must NOT modify. They
are tracked here so later groups (which own those runtime zones) can unwind them.

## Breakdown by zone

| From zone | Violations | Nature |
| --- | --- | --- |
| erp-api (`src/app/api/**`) | 32 | cron + twilio/whatsapp/webhook routes importing `@/agent/lib/*` |
| erp-app (`src/app/**`) | 18 | `portal/office/*` staff UI importing `@/agent/*` |
| shared-lib (`src/lib/**`) | 51 | `strategist-run`, `staff-forecast-run`, `tryon/*`, `winback-run`, etc. |

## Representative offenders

- `src/app/api/cron/growth-digest/route.ts → @/agent/lib/*`
- `src/app/portal/office/office-shell.tsx → @/agent/*`
- `src/lib/strategist-run.ts → @/agent/lib/{llm-text,playbook,agent-memory,...}`

## Remediation direction (not done here — out of G01 scope)

Later groups should invert these dependencies: move the shared surface the agent
needs into `src/lib` (or a neutral package), so the agent depends on libs and
ERP/libs never depend on the agent. Until then the ratchet prevents **new**
violations while leaving the known set untouched.
