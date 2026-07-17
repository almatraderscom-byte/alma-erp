# Roadmap 3 — Measured 99% autonomy, hard guardrails, and production reliability

Status: implementation roadmap; no production change has been made by this audit
Audit date: 2026-07-17 (Asia/Dhaka)
Audited source: local `origin/main` at `629abed6426ff6846905f661368d44f629717b93`
Dependency: Roadmap 1 continuity/LangGraph spine. Phases 51–53 are prerequisites for broad write capabilities in Roadmap 2.

## Mission

Make the agent complete almost all safe, authorized steps in the owner's personal and business work with minimal prompting, durable execution, hard policy enforcement, exact recovery, and independent proof.

“99% autonomy” must be split into two measurable numbers:

1. **Coverage:** what percentage of eligible task steps the agent is authorized and equipped to do.
2. **Reliability:** what percentage of those attempted eligible steps finish correctly and are independently verified.

It cannot honestly mean 99% of every imaginable human activity. Payments, contracts, account/security changes, destructive actions, sensitive communications, medical/legal decisions, platform authentication, and ambiguous high-impact choices retain human control. The professional target is **99% reliability for explicitly defined, low-risk/reversible task classes**, with zero unapproved high-impact effects.

## Claude Code execution contract

Give this file to Claude Code in a separate dedicated session. Claude must:

1. Read `AGENTS.md` and this complete file before acting.
2. Run read-only pre-flight. Compare the checkout with `origin/main` and the last owner-approved phase; do not assume the current branch is current.
3. Implement only the first incomplete phase in that session.
4. Use branches `agent-phase-51` … `agent-phase-58` with matching `pre-agent-phase-N` tags, each from the latest owner-approved base.
5. Stop if any allowed file has overlapping owner changes. Preserve all untracked files; no reset/clean/checkout-away.
6. State the exact phase allowlist before editing. If another file is needed, stop for owner scope approval.
7. Diagnose first for any bug. Fix only after owner approval.
8. Never touch `/api/agent/*` or its auth. New routes are only `/api/assistant/*` and call `requireAgentEnabled()` before all other work.
9. Keep ERP dependencies one-way, money whole-taka, BDT/AED rules, Asia/Dhaka time, additive migrations, and no secrets in git.
10. Test with fakes/sandboxes. Do not send real messages, publish, spend, change permissions, move money, delete, or deploy production during proof.
11. Run targeted/unit/integration/chaos tests plus typecheck/lint/build as applicable and a final scope diff.
12. Push only the phase branch for a Vercel preview; never merge or deploy production.
13. Exercise the phase in the owner's Chrome on the preview and save a screenshot plus test record under `docs/proofs/agent-phase-N/`. The owner enters any credentials. No screenshot = FAIL.
14. Report files, migrations, PASS/FAIL, preview URL, proof, risks, and rollback; then stop. Never continue to the next phase without owner approval.

## Current-state audit

### Existing safety and autonomy strengths

- `AGENT_ENABLED` is the master route kill switch.
- Tools have a central manifest/classification with read/stage/write, risk, approval, concurrency, idempotency, and proof metadata.
- AJV strict schema validation is centralized in `runRegisteredTool`; unknown input fields are rejected before handlers.
- Owner-turn mutation authorization, approval cards, ask cards, claim verification, workflow guards, site trust tiers, prompt-injection tripwire, browser final-submit restrictions, and Bangla/customer output gating exist.
- WorkflowRun has versioning, leases, legal next tools, append-only events, and links to cards/proof.
- Turn request/message idempotency and worker event replay exist.
- BullMQ/Redis worker queues, retries for many jobs, monitoring, notifications, plans, checkpoints, open tasks, memory, and owner-tunable controls already provide useful foundations.
- Autonomy defaults are cautious: master policy false; no category starts in auto; money cap defaults to zero; many capability flags default off.

### Critical gaps before 99% autonomy

| Finding | Evidence and consequence |
|---|---|
| Classification is not universal enforcement | Tool metadata declares write idempotency/proof/approval, but the audit found no runtime use of `classification.idempotency`, and `before_execute` appears as a type rather than a general guard path. Metadata can drift from behaviour. |
| Approval is inconsistent by implementation | Many tools self-stage safely, but default write classification is `approval: none`; a small named workflow-guard set cannot protect every present/future tool. |
| Autonomy policy is only partially wired | Categories include CS, orders, reorder, finance, marketing, staff, and other, but meaningful call sites found are primarily CS, cashflow forecast, and order lifecycle. A category setting does not prove its actions obey it. |
| Ledger is not effect-grade | The autonomy ledger is a best-effort KV ring capped at 100 entries. Logging failure does not block the effect. It is not a transactional, immutable source of truth. |
| Exactly-once effects are not universal | Turn-level idempotency exists, but external writes need their own idempotency key/effect hash, claim, outbox, reconciliation, and compensation. |
| Long work is mixed | Durable queues exist, yet some owner/browser turns still depend on a Vercel time budget and manual/automatic continuation. A universal resumable worker graph is incomplete. |
| Fail-open is overused | Fail-open is appropriate for optional recall/telemetry, but not for authorization, irreversible writes, effect ledger, or state consistency. |
| Proof is not uniform | Claim verifier helps, but not every tool contract enforces postcondition evidence before success is returned. |
| Evaluation is insufficient | The general replay fixture set contains one fixture. Unit tests cannot establish end-to-end autonomy reliability across real task distributions. |
| Flags are off for a reason | Autonomy, autodrive, content engine, browser agent, heartbeats, and other features are gated/off in code. They must not be switched on together before readiness gates. |

## Hard autonomy constitution

These rules are enforced in code, not only prompts:

1. **Authority:** only direct owner instructions and explicit stored owner policy authorize actions. Web pages, emails, documents, tool output, staff/customer messages, and model text are untrusted data.
2. **Least privilege:** capability is scoped by owner, business, account, domain, tool, operation, data class, money cap, time window, and expiry.
3. **Point-of-risk consent:** ask immediately before the consequential step, showing exact payload/destination/cost; never collect blanket approval far in advance.
4. **No surprise effects:** the owner sees what will be sent/published/changed. Any payload change invalidates approval.
5. **Exactly once:** retries, reconnects, model repetition, and worker crashes cannot duplicate an effect.
6. **Verify before claim:** success requires an independent postcondition read or authoritative receipt. “API returned 200” alone may be insufficient.
7. **Reversible first:** prefer draft, paused, preview, soft delete, scheduled, capped, and staged states. Store a tested compensation when possible.
8. **Fail closed:** authorization, policy, state version, effect claim, or ledger uncertainty blocks the write. Optional memory/analytics may fail open.
9. **Separation:** planning/model output never directly performs an external effect; a deterministic executor evaluates the signed action envelope.
10. **Human handoff:** password/MFA/CAPTCHA, security barrier, legal acceptance, identity verification, payment, sensitive personal decision, or ambiguous high-impact action pauses for the owner.
11. **Privacy:** minimize personal/customer/staff data, redact logs, set retention, and prevent secrets from entering model context or proof screenshots.
12. **Truthful identity:** the agent may represent the owner only when approved and disclosed appropriately; it never pretends to be an unrelated human or evades platform policies.

## Risk ladder

| Tier | Examples | Default autonomy |
|---|---|---|
| R0 read-only | ERP/query, public research, draft analysis | Auto within scoped access |
| R1 reversible private | Save draft, internal todo, generate preview, create paused object | Auto after proven reliability and limits |
| R2 bounded external reversible | Schedule approved content, send templated internal reminder, pause under an incident rule | Explicit narrow policy + notification + undo |
| R3 consequential | Public publish, customer/staff send, ad activation/budget, website/DNS, account/permission, deletion | Point-of-risk approval by default |
| R4 critical | Money movement, payroll, contract/legal acceptance, security/account recovery, high-value purchase | Owner executes or confirms every exact action; some remain owner-only |

## Phase 51 — Autonomy taxonomy, readiness map, and baseline evals

Goal: define the eligible universe and measure reality before enabling anything.

Allowed files:

- `src/agent/lib/autonomy-task-catalog.ts` (new)
- `src/agent/replay/fixtures/autonomy-*.json` (new)
- `src/agent/replay/run-autonomy-replay.ts` (new)
- `src/agent/lib/__tests__/autonomy-readiness.test.ts` (new)
- `docs/agent-audit/phase-51-autonomy-baseline.md` (new)
- `docs/proofs/agent-phase-51/*` (new)

Work:

- Inventory every tool, route, cron, queue job, external connector, browser action, flag, policy call site, approval, idempotency method, proof method, undo, data sensitivity, and failure mode.
- Generate a capability/readiness matrix from code where possible; manually review every R2–R4 action.
- Classify personal and business task families by risk, reversibility, authority, required service/account, average duration, known blockers, and success evidence.
- Build at least 200 PII-scrubbed autonomy cases: normal, ambiguous, injected, stale state, duplicate, partial failure, provider outage, rate limit, permission loss, cross-account, high-impact, and owner-policy conflict.
- Establish separate metrics for task planning, action eligibility, correct tool, guard decision, effect correctness, postcondition proof, recovery, rollback, latency, cost, and owner interruption rate.

Exit gates:

- Every executable write tool has an owner-readable readiness row; unknown is not ready.
- All current “off” flags list prerequisites and rollback, not a proposed date.
- Baseline metrics are reported without changing thresholds to hide failures.
- Chrome proof shows a preview readiness dashboard with representative R0–R4 capabilities.

## Phase 52 — Universal policy and tool-guard kernel

Goal: one mandatory deterministic guard wraps every tool invocation and future tool.

Allowed files:

- `src/agent/tools/tool-contract.ts`
- `src/agent/tools/capability-classification.ts`
- `src/agent/tools/capability-manifest.ts`
- `src/agent/tools/registry.ts`
- `src/agent/lib/policy/action-policy.ts` (new)
- `src/agent/lib/policy/capability-token.ts` (new)
- `src/agent/lib/policy/data-classification.ts` (new)
- `src/agent/lib/policy/tool-guard.ts` (new)
- `src/agent/lib/turn-authorization.ts`
- `src/agent/lib/workflow-guards.ts`
- `src/agent/tools/__tests__/tool-guard-coverage.test.ts` (new)
- `src/agent/lib/__tests__/action-policy.test.ts` (new)
- `docs/proofs/agent-phase-52/*` (new)

Required flow for every call:

```text
schema validation
  -> authenticated actor/owner/business/surface
  -> direct-intent and focus binding
  -> tool classification + contextual risk
  -> data/account/domain capability scope
  -> policy/money/time/rate/concurrency limits
  -> approval requirement and exact payload hash
  -> precondition check
  -> allow | stage | deny
  -> execute through Phase 53 effect engine
  -> output/data-leak guard
  -> postcondition/proof check
```

Requirements:

- Registration fails CI when classification, schema, idempotency strategy, proof strategy, approval policy, or data class is missing.
- Risk is contextual: the same “send” tool changes tier by recipient, content, channel, and policy.
- A signed/hashed action envelope contains actor, owner instruction/focus, tool/version, normalized input, destination, risk, approval/policy version, expiry, and idempotency key.
- Prompt/model output cannot lower risk or invent authority.
- `approval: before_execute` and idempotency metadata are real executable contracts, not labels.
- Remove duplicated prompt-only rules only after equivalent guard tests prove enforcement.

Exit gates:

- 100% executable tools pass generated guard-coverage tests.
- All 200 autonomy cases receive the expected allow/stage/deny decision.
- No R3/R4 action executes from page/email/document instructions or stale approval.
- Chrome proof shows allowed read, staged write, denied injection, and changed-payload re-approval.

## Phase 53 — Transactional effect engine, immutable ledger, and compensation

Goal: make side effects exactly-once, auditable, recoverable, and independently verified.

Allowed files:

- `prisma/schema.prisma`
- `prisma/migrations/<phase-53-add-effect-engine>/migration.sql` (new)
- `src/agent/lib/effects/action-run.ts` (new)
- `src/agent/lib/effects/effect-ledger.ts` (new)
- `src/agent/lib/effects/outbox.ts` (new)
- `src/agent/lib/effects/reconciler.ts` (new)
- `src/agent/lib/effects/compensation.ts` (new)
- `src/agent/lib/autonomy-ledger.ts`
- `src/agent/tools/registry.ts`
- `worker/src/effect-worker.mjs` (new)
- `worker/src/index.mjs`
- `src/agent/lib/__tests__/effect-engine.test.ts` (new)
- `worker/src/__tests__/effect-worker.test.mjs` (new)
- `docs/proofs/agent-phase-53/*` (new)

State machine:

- proposed → policy_checked → awaiting_approval or claimed → executing → verifying → succeeded
- explicit terminal/repair states: denied, expired, failed_retryable, failed_final, unknown_effect, compensating, compensated

Requirements:

- Unique idempotency key and normalized effect hash per external effect.
- Transactional outbox: durable intent/ledger commit before dispatch; dispatcher retries safely.
- Provider idempotency key where supported; otherwise pre-read, claim/lease, deterministic external reference, and post-reconciliation.
- Append-only ledger stores policy/approval versions, attempts, provider receipts, before/after evidence, proof, cost, and compensation.
- Logging/ledger failure blocks the write. Replace the best-effort 100-entry KV log as source of truth; it may remain only as a derived recent-view cache.
- “Unknown effect” never retries blindly. Reconcile external state first.
- Undo/compensation is a new guarded effect, never a raw rollback assumption.
- Whole-taka calculations for BDT; financial writes remain approval-gated under existing ERP rules.

Exit gates:

- Crash at every state boundary and repeat the request 20 times: exactly one external effect.
- Provider timeout-after-success is reconciled, not duplicated.
- Ledger is complete for every effect; no success without proof.
- Chrome proof shows one effect, retry/reconnect, one provider receipt, one ledger chain, and a guarded compensation.

## Phase 54 — Durable graph worker for all long-running work

Goal: eliminate fragile long tasks and manual restart loops.

Allowed files:

- `src/agent/lib/graph/durable-task-graph.ts` (new)
- `src/agent/lib/turn-queue.ts`
- `src/agent/lib/turn-status.ts`
- `src/app/api/assistant/chat/route.ts`
- `src/app/api/assistant/turn/[id]/stream/route.ts`
- `worker/src/agent-task-runner.mjs` (new)
- `worker/src/index.mjs`
- `worker/src/__tests__/agent-task-runner.test.mjs` (new)
- `src/agent/lib/__tests__/durable-task-graph.test.ts` (new)
- `docs/proofs/agent-phase-54/*` (new)

Build:

- One graph-native queue contract for tasks expected over 30 seconds; Vercel enqueues/streams status, VPS executes.
- Durable checkpoint after each meaningful read/effect/verification; current focus from Roadmap 1 is updated atomically.
- Leases, heartbeat, cancellation, retry class, deadline, backoff/jitter, dependency waits, rate limits, dead-letter queue, replay, and reconciliation.
- Separate plan retry from effect retry; never replay an effect node without Phase 53 idempotency.
- Progress is owner-readable: goal, completed, current, blocker, next, ETA range, cost, proof.
- App/browser disconnect has no effect on server execution; reconnection replays persisted events exactly once.

Exit gates:

- Forced worker kill at every node resumes from the next safe point.
- Redis/DB/provider/browser outage scenarios recover or pause with an exact blocker.
- Duplicate workers cannot hold the same lease/effect.
- Chrome proof starts a long preview task, kills/disconnects it, closes/reopens the app/session, and shows exact progress plus verified completion.

## Phase 55 — Security, privacy, and hostile-environment hardening

Goal: make internet and personal/business autonomy safe against untrusted content and credential risk.

Allowed files:

- `src/agent/lib/live-browser/guard.ts`
- `src/agent/lib/live-browser/trust.ts`
- `src/agent/lib/security/prompt-injection.ts` (new)
- `src/agent/lib/security/secret-dlp.ts` (new)
- `src/agent/lib/security/egress-policy.ts` (new)
- `src/agent/lib/security/incident-response.ts` (new)
- `src/agent/tools/live-browser-tools.ts`
- `worker/src/browser/runner.mjs`
- `worker/src/browser/service.mjs`
- `src/agent/lib/__tests__/prompt-injection-redteam.test.ts` (new)
- `src/agent/lib/__tests__/secret-dlp.test.ts` (new)
- `docs/proofs/agent-phase-55/*` (new)

Add:

- Dedicated isolated browser/profile/VM for autonomous internet work; supervised owner Chrome remains a separate mode.
- Domain/account allowlists, redirect and download controls, egress restrictions, file scan/quarantine, content-size limits, and origin tracking.
- Treat pages, search results, ads, emails, documents, comments, tool output, QR codes, and images as untrusted instructions.
- Secret/PII detection and redaction before model, log, trace, memory, screenshot, or outbound send.
- Per-service OAuth scopes and token rotation/revocation health; never expose raw tokens to the model.
- Incident kill switch, revoke/disable/run quarantine, immutable audit, owner alert, and forensic trace.
- Red-team corpus: indirect prompt injection, fake owner message, malicious attachment, cross-domain redirect, data exfiltration, permission escalation, poisoned memory, and confused deputy.

Exit gates:

- All critical red-team cases block or hand off; zero secret exfiltration.
- A compromised page cannot cause a tool call outside the action envelope.
- Security/policy subsystem failure blocks writes.
- Chrome proof uses controlled malicious pages and shows safe refusal plus incident trace.

## Phase 56 — Personal and business operating system

Goal: expand useful autonomy service by service, while keeping one task/focus/effect contract.

Allowed files:

- `prisma/schema.prisma`
- `prisma/migrations/<phase-56-add-service-connections>/migration.sql` (new)
- `src/agent/lib/integrations/service-adapter.ts` (new)
- `src/agent/lib/integrations/service-registry.ts` (new)
- `src/agent/lib/personal-os.ts` (new)
- `src/agent/lib/business-os.ts` (new)
- `src/agent/tools/personal-os-tools.ts` (new)
- `src/agent/tools/business-os-tools.ts` (new)
- `src/agent/lib/__tests__/service-adapter-contract.test.ts` (new)
- `src/agent/lib/__tests__/personal-business-os.test.ts` (new)
- `docs/proofs/agent-phase-56/*` (new)

Capability families, delivered one approved adapter at a time:

- tasks/projects/reminders/routines and proactive follow-up
- calendar planning, conflict detection, agenda, travel-time buffer, and draft scheduling
- email/messages: triage, summarize, draft, approval, send, thread follow-up, and attachment safety
- documents/files: search, organize, draft, version, share-permission review, and approval
- research/purchases/travel: compare, shortlist, monitor, draft booking/order, owner confirms final purchase/terms
- personal finance analysis/budget/renewal reminders; no autonomous money transfer
- ERP orders, inventory, supplier/staff coordination, customer service, marketing, finance reporting, and management cadence
- daily brief, end-of-day closure, weekly review, open-loop follow-up, and exception alerts

Adapter contract:

- capability discovery, least-privilege scopes, health, read/stage/write map, risk class, idempotency, proof, undo, rate limit, data retention, and disconnect/revoke
- API first; controlled browser fallback when allowed
- no adapter is marked ready from OAuth success alone; pass sandbox and preview cases first

Exit gates:

- At least one personal and one business adapter complete the full plan → guard → effect → verify → resume flow.
- Cross-service tasks keep one focus and do not leak data/account scope.
- Owner can inspect, pause, revoke, and delete retained connection data.
- Chrome proof demonstrates a private draft/sandbox workflow only; no real send/purchase/public action.

## Phase 57 — Staged autonomy ladder and owner control centre

Goal: turn capabilities on gradually by evidence, not enthusiasm.

Allowed files:

- `src/agent/lib/autonomy-policy.ts`
- `src/agent/lib/autonomy-ledger.ts`
- `src/agent/lib/autonomy-readiness.ts` (new)
- `src/agent/lib/autonomy-rollout.ts` (new)
- `src/app/api/assistant/controls/route.ts`
- `src/agent/components/monitor/AgentControlCenter.tsx`
- `src/agent/components/monitor/index.tsx`
- `src/agent/components/AutonomyControlCenter.tsx` (new)
- `src/agent/lib/__tests__/autonomy-rollout.test.ts` (new)
- `docs/proofs/agent-phase-57/*` (new)

Per task class and exact scope, progress through:

1. off
2. shadow recommendation
3. suggest
4. private draft/stage
5. auto execute reversible R1
6. bounded R2 under owner policy
7. R3/R4 still point-of-risk confirmed/owner-only

Control dimensions:

- business/personal, service/account/domain, task/tool/action, recipients/destination, data class
- daily/weekly count, money cap, time window, confidence/evidence threshold, expiry
- notify before/after, quiet hours, approval level, rollback, kill switch
- canary percentage and automatic rollback thresholds

Readiness gate before each promotion:

- minimum sample size, target correctness/recovery/proof, zero critical guard failure, acceptable owner correction/interrupt rate, cost/latency budget, tested compensation, and owner approval
- any policy/implementation/version change resets or reduces readiness until replay/canary proves it again

Exit gates:

- No global “auto everything” switch.
- Policy UI shows plain Bangla examples of what will and will not happen.
- Revoking/pausing takes effect before the next tool execution.
- Chrome proof promotes one R1 capability through shadow → draft → bounded auto, then triggers automatic rollback on a forced failure.

## Phase 58 — Production SLOs, continuous evaluation, and controlled enablement

Goal: prove reliability over time and enable only what stays safe.

Allowed files:

- `src/agent/lib/autonomy-slo.ts` (new)
- `src/agent/lib/graph/graph-health.ts`
- `src/agent/lib/tool-telemetry.ts`
- `src/app/api/assistant/internal/health/route.ts`
- `src/app/agent/staff-monitor/page.tsx`
- `src/agent/components/monitor/AutonomySloPanel.tsx` (new)
- `.env.example`
- `worker/src/autonomy-reconciler.mjs` (new)
- `worker/src/__tests__/autonomy-chaos.test.mjs` (new)
- `docs/agent-audit/phase-58-production-readiness.md` (new)
- `docs/proofs/agent-phase-58/*` (new)

Operate:

- Trace every plan, handoff, tool guard, effect, checkpoint, verification, owner correction, compensation, cost, and outcome with redaction.
- Continuous replay plus nightly/weekly sampled trace grading; human review of failures and all critical classes.
- Chaos: provider timeout, timeout-after-effect, DB/Redis loss, worker kill, duplicate delivery, clock skew, stale approval, permission revoked, API version change, browser/UI change, rate limit, and injection.
- SLO dashboard by task class: coverage, success, verified completion, wrong action, duplicate effect, guard block, recovery time, rollback success, owner interventions, latency, cost.
- Automatic pause/rollback for threshold breach; independent global `AGENT_ENABLED` emergency stop.
- Enable currently off features one at a time after their own readiness gates. Record who approved, scope, time, evidence, and rollback.

Production target gates:

- Eligible R0/R1 task reliability ≥99% over an owner-approved statistically meaningful sample.
- Verified completion ≥99%; restart-from-zero <1%; checkpoint recovery ≥99.5%.
- Unapproved R3/R4 effect = 0; duplicate external effect = 0; critical data leak = 0.
- Guard coverage = 100% of executable tools and adapters.
- Compensation success ≥99% where compensation is declared supported.
- Every “done” claim has authoritative proof; unknown state is reported as unknown.
- P95 latency, cost, and owner-interruption budgets are explicitly approved.
- Thirty stable days are required before retiring a fallback or expanding scope materially.

Chrome proof must demonstrate a preview end-to-end task crossing at least two services, a forced worker/provider failure, exact session resume, a staged/approved effect, independent verification, and full ledger/SLO trace.

## Recommended implementation order across all three roadmaps

1. Roadmap 1 Phases 31–34: evaluation, exact continuity, graph execution, universal resume.
2. Roadmap 3 Phases 51–53: readiness, universal guards, exactly-once effect engine.
3. Roadmap 1 Phases 35–37: specialist durability, human behaviour, graph canary.
4. Roadmap 2 Phases 41–48: marketing/SEO/internet expertise on the safe execution spine.
5. Roadmap 3 Phases 54–58: durable all-task worker, security, service expansion, staged autonomy, production SLOs.

No phase should be enabled in production merely because a later phase exists on paper.

## Primary references

- [LangGraph persistence and durable execution](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph interrupts and resumable human decisions](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [OpenAI Agents SDK guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [OpenAI agent workflow evaluation](https://developers.openai.com/api/docs/guides/agent-evals)
- [OpenAI computer-use safety and point-of-risk confirmation](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Anthropic computer-use security guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
