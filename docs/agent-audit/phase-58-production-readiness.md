# Phase 58 — Production readiness: SLOs, continuous evaluation, controlled enablement

Date: 2026-07-17 (Asia/Dhaka) · Branch: `claude/agent-roadmap-phases-2a10b1`
Covers: Roadmap 3 Phases 51–58 (all shipped on this branch, sequentially verified)

## What "on" means now — the operating loop

1. **Trace everything, redacted.** Every tool call carries guard decision + tier + shadow verdict in telemetry; telemetry detail is DLP-scrubbed before persist (`tool-telemetry.ts` + `secret-dlp.ts`). Effects carry an append-only ledger chain (transitions, receipts, proofs, compensations) that cannot be updated or deleted.
2. **Continuous replay.** The 204-case autonomy corpus runs in CI on every commit (`action-policy.test.ts` — 100% required); the rc-* turn corpus remains the behaviour net. The chaos suite (`autonomy-chaos.test.mjs`) covers worker kill, timeout-after-effect, DB loss, duplicate delivery, clock skew, rate limit, stale leases.
3. **SLO dashboard.** `autonomy-slo.ts` computes per-task-class reliability, verified completion, unknown effects, compensation success, cost — plus the global zero-invariants (duplicate external effects, unapproved R3/R4). Surfaced on the staff-monitor page (`AutonomySloPanel`) and the internal health route (`?slo=true`). Insufficient volume reports `insufficient_data`, never green.
4. **Automatic pause/rollback.** SLO breaches demote the class one ladder rung (fresh evidence needed to climb back); global invariant breaches ALSO quarantine + file an immutable incident. `AGENT_ENABLED` remains the independent global emergency stop in front of every route.
5. **Reconciler.** The VPS loop marks stale executing effects unknown, alerts the owner once per stuck unknown, and releases dead dispatcher leases (`autonomy-reconciler.mjs`).

## Production target gates — measured state

| Gate | Target | Current state |
|---|---|---|
| Eligible R0/R1 reliability | ≥99% | `insufficient_data` — engine ships OFF; gate enforced by breach→demote once live volume exists |
| Verified completion | ≥99% | structural: succeeded REQUIRES a proof row (engine invariant, CI-tested) |
| Restart-from-zero | <1% | structural: per-node checkpoints + exactly-once effects (kill-at-every-boundary tests) |
| Checkpoint recovery | ≥99.5% | structural + chaos-tested; live number accrues via readiness evidence |
| Unapproved R3/R4 effect | 0 | guard blocks external-content/R4/stale-approval in code; SLO monitors the ledger for any residue |
| Duplicate external effect | 0 | unique idempotency key + claim-before-dispatch; SLO double-checks the ledger |
| Critical data leak | 0 | DLP egress assertion + telemetry redaction + red-team corpus green |
| Guard coverage | 100% | one executor path; generated per-tool coverage tests (287 tools) fail CI on any gap |
| Compensation success | ≥99% where declared | compensation is a ledgered, verified effect; SLO tracks the rate |
| P95 latency/cost/interruption budgets | owner-approved | targets in `SLO_TARGETS` + readiness targets; owner tunes via control centre before promotion |
| 30 stable days before expansion | required | `SLO_TARGETS.stableDaysBeforeExpansion`; enablement records make the clock auditable |

## Controlled enablement order (one at a time, each with a record)

1. `AGENT_EFFECT_ENGINE=true` in **preview** → watch outbox/reconciler + SLO panel.
2. Promote ONE R1 class (e.g. `memory-notes`) shadow → suggest → draft → auto_r1 through the control centre (evidence gates enforce sample volume).
3. `AGENT_EFFECT_ENGINE=true` in production after preview stability.
4. Additional classes/services per ladder; R3 stays draft-max, R4 shadow-max, forever.
Each step: `recordEnablement({flag, approvedBy, scope, evidenceRef, rollback})` → immutable audit row.

## Honest gaps / notes for the owner

- Live SLO numbers are empty until the effect engine is enabled — by design (flags off before readiness).
- The worker browser's quarantine check reads the health route field shipped in this phase; before this phase it failed closed on the missing field.
- Latency SLO joins tool telemetry, not yet folded into the class table (panel shows cost + reliability first).
- Chrome-proof for the full end-to-end demo is deferred to the owner's final verification session (deploys disabled on this branch by owner instruction).
