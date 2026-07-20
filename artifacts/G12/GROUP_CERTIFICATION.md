# G12 — GROUP CERTIFICATION

Group: G12 — Autonomy and Approval Governance
Branch: `aios/G12-autonomy` (base = integration-wave @ G11)

```
Group: G12
Specs: SPEC-111..SPEC-120
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS (deterministic governance — 0 model calls added)
Security regression: PASS
Rollback drill: PASS (per spec — revert → parent tree MATCH)
Unresolved critical risks: 0
Verdict: PASS
```

## What G12 built
The "may the agent act on its own, or must it ask Boss?" layer — sitting on top of
the G11 policy engine and fail-closed at every turn.

| Spec | Deliverable |
| --- | --- |
| SPEC-111 | Autonomy decision states — AUTONOMOUS / NEEDS_APPROVAL / DENIED; unclassified ⇒ ask |
| SPEC-112 | Fail-closed approval contract — only an explicit, in-window grant by an authorized human unlocks |
| SPEC-113 | Financial approval rules — over-ceiling / unknown-amount / payroll ⇒ approval (integer nano-USD) |
| SPEC-114 | External publishing rules — public/unknown audience ⇒ approval; internal draft ⇒ autonomous |
| SPEC-115 | HR & staff rules — hire/fire/salary/role ⇒ approval; only allowlisted routine staff actions autonomous |
| SPEC-116 | Data export rules — external/sensitive/unknown-scope/over-ceiling ⇒ approval |
| SPEC-117 | Separation-of-duties — approver must be a distinct human with an approver role |
| SPEC-118 | Expiry & revocation — single-use consumption + revoke-before-use, fail-closed |
| SPEC-119 | Evidence & audit — identity-correlated approval audit events, G01-stream projection |
| SPEC-120 | Adversarial certification — 21 fail-closed invariants, each driven through the wired stack |

## Integration checkpoint
| Check | Result |
| --- | --- |
| Zone typecheck (autonomy tsconfig incl. approvals/policy/identity/contracts) | **PASS** (tsc exit 0) |
| G12 zone tests | **PASS** (89 — autonomy + approvals) |
| Full test suite (on merged wave) | **PASS** (see wave integration below) |
| Database migration validation | **PASS** (no DB; deterministic, time injected) |
| Forbidden-import scan | **PASS** (no NEW violations; ERP→agent 0) |
| Authorization/admission bypass gates | **PASS** (no regression) |
| Security (secret scan + cross-tenant + self-approval) | **PASS** |
| Cost vs baseline | **PASS** (deterministic; 0 model calls added, INV-01) |
| Rollback (per spec) | **PASS** (git revert → parent tree MATCH, all 10) |
| GROUP_CERTIFICATION.md | **PASS** |

## Scope discipline
191 files changed, **3672 insertions, 0 modifications, 0 deletions**; all within
`src/agent/autonomy`, `src/agent/approvals` + `artifacts/`. Frozen Hermes
(`/api/agent/*`), live `prisma/schema.prisma`, ERP money code (`src/lib/money.ts`):
**0 touched**.

## Security posture (the important part for autonomy)
- **Ask, don't act (INV-05):** the safe default everywhere. Unclassified action,
  all-abstain rules, malformed input, unknown amount/audience/scope ⇒ NEEDS_APPROVAL.
  Policy-denied ⇒ DENIED (autonomy never overrides a policy deny).
- **Approval is hard to forge:** only an explicit `grant`, in-window, by a distinct
  authorized HUMAN in the same tenant (never the requester/agent, never without an
  approver role) unlocks. Missing/expired/revoked/consumed/replayed/cross-tenant ⇒ no.
- **Single-use:** a consumed grant cannot be replayed; a revoked grant cannot be used.
- **Money is integer nano-USD** (no floats/BDT) — a float amount fails closed.
- **Deterministic (INV-01):** no LLM/DB/network/clock in the decision path — time is
  injected, so every decision is replayable and audited.
- **Adversarial-certified (INV-10):** SPEC-120 drives 21 attacks through the composed
  stack; certification is executable, not prose.

## Verdict
**G12 PASS.** All 10 specs individually PASS with executable proof. Ready for the
tool gateway (G13 SPEC-126) to consult before any approval-gated side effect.
