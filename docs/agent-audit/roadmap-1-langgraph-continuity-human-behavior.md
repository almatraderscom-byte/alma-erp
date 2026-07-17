# Roadmap 1 — LangGraph, exact continuity, and human-grade behaviour

Status: implementation roadmap; no production change has been made by this audit
Audit date: 2026-07-17 (Asia/Dhaka)
Audited source: local `origin/main` at `629abed6426ff6846905f661368d44f629717b93`
Recommended order: complete this roadmap before Roadmap 2; Roadmap 3 safety phases 51–53 must be complete before broad autonomous writes are enabled.

## Mission

Turn the existing partial LangGraph adoption into the durable execution spine of the owner-facing agent, make every long conversation resume from the exact unfinished point after minutes or months, and make the agent feel consistent, warm, attentive, and human-like without changing the selected models.

“Human-like” means natural, context-aware, emotionally intelligent, and accountable. It must never claim to be a human or hide that it is an AI assistant.

## Claude Code execution contract

Give this file to Claude Code in a dedicated session. Claude must:

1. Read `AGENTS.md` and this entire file before acting.
2. Run read-only pre-flight checks first. Do not trust the current checkout: fetch and compare with `origin/main` and the latest owner-approved agent phase.
3. Implement only the first incomplete phase in one session. Never combine phases.
4. For Phase 31 create branch `agent-phase-31` and tag `pre-agent-phase-31`; later phases use `agent-phase-32` … `agent-phase-37` and matching tags. Each branch starts from the latest owner-approved base, not an unapproved sibling branch.
5. Stop if the worktree is dirty in any file that the phase will touch. Never delete or overwrite the owner's untracked files.
6. Before editing, print the phase's exact file allowlist. No file outside that list may be changed. If another file is required, stop and ask the owner to amend the phase scope.
7. Diagnose any discovered bug and show the root cause before changing code.
8. Preserve `/api/agent/*`, its authentication, and all existing ERP behaviour. New routes remain under `/api/assistant/*`; every agent route uses `requireAgentEnabled()`.
9. Use additive Prisma migrations only. Never put secrets in git.
10. Run targeted tests, full typecheck/lint/build as applicable, and `git diff --stat`/scope review.
11. Push only the phase branch for a Vercel preview. Never merge and never deploy production.
12. Exercise the complete phase in the owner's Chrome on the Vercel preview. If login is needed, open login and let the owner type credentials. Capture a visible screenshot under `docs/proofs/agent-phase-N/` and record preview URL, test steps, expected result, actual result, timestamp, and screenshot path.
13. A passing build is not completion proof. No live Chrome screenshot means the phase is FAIL/incomplete.
14. Report files, migrations, PASS/FAIL checklist, remaining risks, and decisions; then stop for owner approval. Do not start the next phase.

## Audit verdict

| Capability | Current evidence | Verdict |
|---|---|---|
| LangGraph foundation | Postgres checkpointer, interrupts, state history, BaseStore adapter, graph health, tests | Solid foundation |
| Owner-turn graph | `turn-graph-shadow.ts` records guard/tier decisions; `tools_snapshot` and `loop_plan` are no-op nodes while legacy code executes | Partial, not the execution engine |
| Routine graph | Nine deterministic read intents execute through `routine-turn-graph.ts` | Useful but narrow |
| Action interrupt | Real `interrupt()`/`Command(resume)` exists only for the `log_expense` pilot | Partial |
| Workflow/browser/SEO/duty/plan graphs | They mirror legacy transitions into checkpoints and fail open; legacy implementations remain canonical | Audit durability, not graph-native execution |
| Parallel specialist graphs | No LangGraph `Send`, specialist subgraphs, or graph cache policy found | Missing |
| Conversation memory | Full rows are stored; recent tail, rolling summary, semantic old-turn recall, memories, decisions, tasks, and cross-surface context exist | Broad but fragmented |
| Exact continuation | WorkflowRun, checkpoints, ask-card binding, deadline salvage, and a 6-hour resume brief exist | Partial; not universal |
| Behaviour consistency | Strong Bangla/personal prompts, listen mode, empathy routing, owner memory, and follow-up model stickiness exist | Prompt-heavy; weakly measured |
| Regression evaluation | Many unit tests and LangGraph routing goldens exist, but the general replay directory contains one fixture and no representative end-to-end continuity corpus | Major gap |

## Why the owner still feels “it forgot after 2–3 replies”

This is not mainly a model problem. It is a state-reconstruction problem.

1. `WorkflowRun` is canonical only for work that actually creates one. Ordinary discussion, research, partially announced work, some tool failures, and many untemplated tasks can have no durable active work record.
2. `resume-brief.ts` runs only after a six-hour gap. It reads up to three runs/cards/tasks and the last 160 characters of the assistant's previous message; it does not universally store the objective, last verified result, failed operation, blocker, exact next action, or completion criteria.
3. The recent message tail is folded after ten turns and keeps six turns by default. Its summary is a model-generated maximum of roughly ten bullets. That is useful memory, not an executable checkpoint.
4. Semantic message recall excludes the recent 30 messages and retrieves only four older messages. A short reply such as “করো”, “তারপর?”, “ওটাই”, or “যেখানে ছিলে” has little semantic signal and may retrieve nothing. Embedding and retrieval are intentionally fail-open.
5. Head “stickiness” keeps a short follow-up on the same model; it does not bind the follow-up to one exact task/step.
6. Deadline checkpointing is strongest for browser work. Provider errors, network loss, worker failure, an empty/partial answer, or a normal multi-turn promise are not all normalized into one resumable state machine.
7. Several stores compete to describe “what is active”: chat messages, rolling summary, open tasks, WorkflowRun, checkpoint, cards, plan state, browser state, and turn events. There is no deterministic focus resolver with a conflict rule.
8. Compaction keeps history for cost control, but summarization cannot be the source of truth for irreversible or exact work state.

The fix is a durable **Conversation Focus + Work Continuation spine**, backed by LangGraph checkpoints. Chat text and semantic memory support it; they never replace it.

## Target architecture

Every owner turn must resolve this state before a model is called:

```text
conversation identity + surface
  -> focus stack (active / parked / awaiting-owner)
  -> canonical WorkRun and last checkpoint
  -> last verified effect + artifacts
  -> failure/blocker + retry policy
  -> exact legal next actions
  -> owner message intent: continue / switch / answer / new task / personal listen
  -> LangGraph execution
  -> tool guard -> effect -> verification
  -> atomic checkpoint + focus update
  -> natural owner-facing reply
```

The head remains the only owner-facing narrator and memory writer. Specialist workers are stateless and receive self-contained briefs.

## Non-negotiable continuity scenarios

The final system must pass all of these:

- The owner replies after 2, 3, 10, 30, or 100 normal messages with a short continuation.
- The owner replies after 10 minutes, 7 hours, 3 days, 30 days, and 90 days.
- The previous turn stopped because of provider error, lost internet, browser disconnect, Vercel deadline, worker crash, rate limit, missing permission, waiting approval, waiting answer, or app close.
- The owner switches between web, native app, Telegram, and the same authenticated owner session.
- The previous work included tools, browser tabs, artifacts, a multi-step plan, or a staged side effect.
- The agent resumes the next uncompleted step; it never repeats an already verified side effect.
- A new unrelated request deliberately parks the old task instead of silently mixing them.
- A personal/emotional message enters listen mode and does not unexpectedly resume business work.
- “What were we doing?”, “continue”, and “why did it stop?” return evidence-backed state, not a guessed summary.
- If exact state is genuinely unrecoverable, the agent says what is known and asks one focused question; it never fabricates continuity.

## Phase 31 — Truth baseline and executable replay corpus

Goal: measure current behaviour before architecture changes.

Allowed files:

- `src/agent/replay/fixtures/*.json`
- `src/agent/replay/run-agent-replay.ts` (new)
- `src/agent/replay/replay-types.ts` (new)
- `src/agent/lib/__tests__/agent-replay.test.ts` (new)
- `src/agent/lib/__tests__/continuity-replay.test.ts` (new)
- `docs/agent-audit/phase-31-baseline.md` (new)
- `docs/proofs/agent-phase-31/*` (new)

Work:

- Inventory every head path, graph gate, state store, continuation path, compaction path, and surface handoff.
- Create a PII-scrubbed corpus of at least 150 representative owner turns: 50 continuity, 30 tool selection, 25 approval/ask-card, 20 personal/listen, 15 failure recovery, and 10 cross-surface cases.
- The runner must execute the real router/context/state decision code with fake external effects. Fixture-shape validation alone is not an eval.
- Record baseline: correct task binding, correct next step, wrong-task resume, repeated-effect risk, tool recall/precision, card binding, groundedness, Bangla/style, latency, token cost, and failure classification.
- Add trace IDs and behaviour artifact versions to every replay result.

Exit gates:

- Corpus distribution and expected outcomes are owner-readable.
- Replays are deterministic enough for CI and contain no live secrets/customer data.
- Baseline failures are reported honestly; no threshold is weakened to make current code pass.
- Chrome proof shows a preview-only diagnostic page or existing trace UI running at least three named scenarios, including “2–3 replies later” and “three days later”.

## Phase 32 — Canonical Conversation Focus and Continuation spine

Goal: one durable source of truth for “where we are and what happens next”.

Allowed files:

- `prisma/schema.prisma`
- `prisma/migrations/<phase-32-add-conversation-focus>/migration.sql` (new)
- `src/agent/lib/conversation-focus.ts` (new)
- `src/agent/lib/continuity-resolver.ts` (new)
- `src/agent/lib/resume-brief.ts`
- `src/agent/lib/message-recall.ts`
- `src/agent/lib/tail-compact.ts`
- `src/agent/lib/workflow-run.ts`
- `src/agent/lib/models/run-owner-turn.ts`
- `src/agent/lib/core.ts`
- `src/agent/lib/__tests__/conversation-focus.test.ts` (new)
- `src/agent/lib/__tests__/continuity-resolver.test.ts` (new)
- `src/agent/lib/__tests__/resume-brief.test.ts`
- `src/agent/lib/__tests__/tail-compact.test.ts`
- `docs/proofs/agent-phase-32/*` (new)

Data contract:

- Add an additive focus record or equivalent fields with: conversation, task/work-run ID, status, priority, original goal, current step, verified completed steps, last successful tool/effect ID, last error class, blocker owner/system/external, exact next actions, completion criteria, artifact references, surface, version, lease, and updated timestamp.
- Support a small focus stack: one active focus plus parked and awaiting-owner focuses. No ambiguous “latest row wins”.
- Every state update uses optimistic concurrency and an append-only event.
- A focus is created for any non-trivial work, not only template workflows.

Resolver rules:

- Explicit owner task/reference wins.
- Answer to a bound ask/approval resumes that exact run.
- Short continuation resumes the active focus only when unambiguous.
- New clear task parks the prior focus.
- Personal listen mode suppresses work resumption without deleting focus.
- Failures keep the same focus with a classified blocker and safe retry plan.
- History/semantic recall may enrich the brief but cannot select or mutate a high-risk focus.

Exit gates:

- Correct task binding at least 99% on the Phase 31 continuity corpus; zero wrong high-risk bindings.
- Exact next step survives process restart and a 90-day simulated gap.
- Repeated verified side effect is zero in failure/retry tests.
- Tail compaction never deletes canonical focus state.
- Chrome proof: start a multi-step preview task, exchange at least three unrelated normal replies, close/reopen or simulate a gap, send “যেখানে ছিলে সেখান থেকে করো”, and show the next—not repeated—step.

## Phase 33 — Graph-native owner-turn execution in shadow

Goal: replace the no-op shadow with a real graph while legacy remains production executor.

Allowed files:

- `src/agent/lib/graph/owner-turn-graph.ts` (new)
- `src/agent/lib/graph/turn-graph-shadow.ts`
- `src/agent/lib/graph/graph-checkpointer.ts`
- `src/agent/lib/graph/graph-health.ts`
- `src/agent/lib/models/run-owner-turn.ts`
- `src/agent/lib/models/head-router.ts`
- `src/agent/lib/tool-telemetry.ts`
- `src/agent/lib/__tests__/owner-turn-graph.test.ts` (new)
- `src/agent/lib/graph/__tests__/replay-goldens.test.ts`
- `src/agent/lib/graph/__tests__/graph-health.test.ts`
- `docs/proofs/agent-phase-33/*` (new)

Required nodes:

- load identity/context/focus
- classify owner intent and focus transition
- policy and risk pre-check
- select bounded tool pack
- model plan/call
- universal tool pre-guard hook
- execute or stage action
- observe and self-verify
- repair/retry with hard loop caps
- update focus/checkpoint/artifacts
- style and owner reply
- persist trace/outcome

Requirements:

- Stable `thread_id` and explicit namespaces; sync durability for state that may cause effects.
- Node outputs are typed and small; external calls are isolated and idempotent.
- Stream node/step events to the existing UI without breaking SSE replay.
- Run in shadow first: compare graph decision, selected focus, tools, and expected next state with legacy. Do not execute duplicate effects.
- No silent fail-open for state corruption: fail closed for writes and show a recoverable owner message.

Exit gates:

- At least 98% shadow agreement on low-risk corpus; all disagreements classified.
- 100% of graph traces show selected focus, tool decision, guard result, verification, and final state.
- Process restart between any two nodes resumes from checkpoint in tests.
- Chrome proof shows graph trace/state history for one read, one multi-tool task, and one recovered failure.

## Phase 34 — Universal interrupt, ask, approval, and resume bridge

Goal: expand the real `log_expense` interrupt pilot to every staged decision without weakening server-side authorization.

Allowed files:

- `src/agent/lib/graph/action-turn-graph.ts`
- `src/agent/lib/graph/action-bridge.ts` (new)
- `src/agent/lib/action-cards.ts`
- `src/agent/lib/ask-cards.ts` (new)
- `src/agent/lib/workflow-run.ts`
- `src/app/api/assistant/actions/[id]/approve/route.ts`
- `src/app/api/assistant/actions/[id]/reject/route.ts`
- `src/app/api/assistant/actions/[id]/revise/route.ts`
- `src/app/api/assistant/ask-cards/[id]/answer/route.ts`
- `src/agent/lib/graph/__tests__/action-turn-graph.test.ts`
- `src/agent/lib/__tests__/action-bridge.test.ts` (new)
- `docs/proofs/agent-phase-34/*` (new)

Work:

- One typed interrupt payload for ask, approve, reject, revise, cancel, and external handoff.
- Bind card → work run → graph thread → expected state version.
- Approval is authorization for the exact displayed effect only; changed amount/audience/content/domain requires a new confirmation.
- Expiry, reject, revision, double click, reconnect, stale version, and already-executed cases are idempotent.
- Resume continues the same run after the decision and never reinterprets the approved text as a new owner instruction.

Exit gates:

- Every staged action category has interrupt/resume contract tests.
- Duplicate approve produces one effect.
- Stale or mismatched card produces zero effects and a clear message.
- Chrome proof covers approve, revise, reject, and resume from a three-day simulated gap.

## Phase 35 — Specialist subgraphs, parallel reads, and durable long work

Goal: professional router-worker orchestration without losing head ownership or continuity.

Allowed files:

- `src/agent/lib/graph/specialist-subgraph.ts` (new)
- `src/agent/lib/graph/owner-turn-graph.ts`
- `src/agent/lib/models/subagent.ts`
- `src/agent/lib/models/specialist-roles.ts`
- `src/agent/lib/models/tier-router.ts`
- `src/agent/lib/models/routing-config.ts`
- `src/agent/lib/graph/memory-store.ts`
- `worker/src/agent-graph-run.mjs` (new)
- `worker/src/index.mjs`
- `src/agent/lib/__tests__/specialist-subgraph.test.ts` (new)
- `worker/src/__tests__/agent-graph-run.test.mjs` (new)
- `docs/proofs/agent-phase-35/*` (new)

Work:

- Use per-invocation specialist subgraphs. Workers receive a self-contained brief and return structured findings, evidence, uncertainty, artifacts, and proposed next step.
- Use LangGraph `Send` only for independent read/research branches. Writes stay sequential behind the safety kernel.
- Add cache policy only to pure, stable reads with explicit invalidation/version keys.
- Jobs over 30 seconds run on the VPS durable queue, with checkpoint/resume, heartbeat, cancellation, deadline, and deduplication.
- The head reconciles conflicts and produces the single owner-facing response.

Exit gates:

- Parallel branches cannot write memory or owner-facing effects.
- Worker crash/retry resumes without duplicated work.
- A failed specialist is visible and does not erase successful sibling evidence.
- Chrome proof shows a multi-specialist research task, trace fan-out/fan-in, and final grounded Bangla answer.

## Phase 36 — Human-grade interaction layer without changing models

Goal: consistent human-like behaviour as code and tests, not scattered prompt wishes.

Allowed files:

- `src/agent/lib/interaction-state.ts` (new)
- `src/agent/lib/interaction-policy.ts` (new)
- `src/agent/lib/response-planner.ts` (new)
- `src/agent/lib/system-prompt.ts`
- `src/agent/lib/personal-prompt.ts`
- `src/agent/lib/models/head-router.ts`
- `src/agent/lib/models/run-owner-turn.ts`
- `src/agent/lib/learning/apply-teaching.ts`
- `src/agent/lib/__tests__/interaction-policy.test.ts` (new)
- `src/agent/lib/__tests__/human-behaviour-replay.test.ts` (new)
- `docs/proofs/agent-phase-36/*` (new)

Add:

- Explicit mode: work, personal listen, coaching, decision support, crisis/safety, concise status, and teaching.
- Conversation state: current emotion/tone, owner preference, level of detail, unanswered question, commitment, uncertainty, correction, and repair.
- Response plan before wording: acknowledge → answer/action → evidence → next commitment, with sections omitted when unnecessary.
- Natural variation and anti-repetition without random personality drift.
- Remember owner corrections and preferred phrases; do not infer sensitive personal facts.
- Admit uncertainty, distinguish fact/inference/recommendation, and repair mistakes directly.
- Commitment ledger: if the agent says it will do something, the task/focus must exist or the wording must not promise action.
- One consistent owner-address contract aligned with `AGENTS.md`; remove contradictory prompt fragments.
- Non-deception: friendly AI assistant, never impersonates a human, staff member, or platform user.

Measure:

- Context carry-over, emotional appropriateness, unnecessary work pivot, repetition, verbosity, groundedness, correction acceptance, promise fulfillment, Bangla naturalness, and Islamic guardrails.
- Human review rubric plus deterministic contract checks; never use a model grader as the only safety gate.

Exit gates:

- No unrelated work pivot in 100 listen-mode cases.
- At least 95% behaviour-rubric pass and no critical guardrail failure.
- No announced future action without a durable commitment or immediate execution.
- Chrome proof includes work, emotional/listen, correction, and long-gap continuation conversations.

## Phase 37 — Canary, cutover, and legacy retirement

Goal: make LangGraph canonical only after measured safety and rollback readiness.

Allowed files:

- `src/agent/lib/graph/owner-turn-graph.ts`
- `src/agent/lib/graph/graph-health.ts`
- `src/agent/lib/models/run-owner-turn.ts`
- `src/app/api/assistant/internal/health/route.ts`
- `src/app/agent/page.tsx`
- `src/agent/components/monitor/GraphHealthPanel.tsx` (new)
- `.env.example`
- `docs/agent-audit/phase-37-cutover.md` (new)
- `docs/proofs/agent-phase-37/*` (new)

Rollout:

1. shadow only
2. internal synthetic traffic
3. owner preview read-only canary
4. 1% low-risk production turns
5. 10%, 25%, 50%, 100% low-risk
6. staged reversible writes only after Roadmap 3 safety gates
7. high-risk actions remain confirmed

Controls:

- Independent kill switches for graph, checkpoint, interrupts, specialists, continuity resolver, and human-behaviour layer, all behind `AGENT_ENABLED`.
- Automated rollback on wrong-focus, duplicate-effect, checkpoint failure, guard bypass, elevated error/latency/cost, or owner-reported regression.
- Keep legacy fallback until 30 days of stable measured traffic. Remove a legacy path only in a separate owner-approved phase.

Final exit gates:

- Correct continuation/task binding ≥99%; high-risk wrong binding 0.
- Restart-from-zero <1% on eligible tasks.
- Verified duplicate side effects 0.
- Tool selection ≥95% recall and ≥90% precision on the agreed corpus.
- Checkpoint recovery ≥99.5% for resumable failures.
- P95 latency and per-turn cost stay within owner-approved budgets.
- Browser proof covers a real preview task that spans a forced failure, app/session gap, and exact resume.

## What must not be claimed

- LangGraph alone does not create intelligence, autonomy, or human behaviour.
- A summary is not an executable checkpoint.
- A model saying “I remember” is not continuity proof.
- “99%” is not a marketing promise; it is a measured result per task class with an agreed evaluation set.
- Never turn on all current feature flags together. Every capability is canaried independently.

## Primary references

- [LangGraph overview and core benefits](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [LangGraph persistence, checkpoints, pending writes, and replay](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph human-in-the-loop interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [LangGraph subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)
- [LangGraph testing](https://docs.langchain.com/oss/javascript/langgraph/test)
- [OpenAI agent workflow evaluation: traces, graders, datasets, eval runs](https://developers.openai.com/api/docs/guides/agent-evals)
- [OpenAI Agents SDK guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
