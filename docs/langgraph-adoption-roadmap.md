# LangGraph Adoption Roadmap — ALMA ERP Personal AI Agent

**Owner decision 2026-07-15:** adopt LangGraph.js end-to-end, phase by phase, using
EVERY applicable LangGraph capability — nothing skipped without a written reason.
This document is the master plan. One phase per session, exactly like the agent
phase prompts. Written after live verification of slice 1 (LG-0) on the Vercel
preview: routine lookups answered via the graph at Σ~333 tokens / ~$0.000 vs
Σ~50k tokens on the normal loop.

## Non-negotiable rules (apply to every phase)

1. **ERP stays untouched.** Graph code lives in `src/agent/lib/graph/`; one-way
   dependency (graph → ERP libs, never the reverse).
2. **Fail-open, always.** Every graph slice returns `handled=false` on any
   miss/failure and the proven loop answers. A graph bug must never kill chat.
3. **Approval cards stay the safety spine.** No mutating effect ever bypasses a
   pending-action card. Interrupt-based approvals (LG-3) REPLACE the plumbing,
   never the owner's tap.
4. **Rollout discipline** (state-router precedent): every slice ships behind
   `AGENT_LANGGRAPH_*` env — `true` force-on, `false` kill switch, default ON in
   preview / OFF in production until the owner canaries it.
5. **Observability first.** Every gate and every graph outcome logs one line
   (the 2026-07-15 debugging session rule: "why didn't it run" must be
   answerable from runtime logs).
6. **Verification per phase:** typecheck + `vitest src/agent` green + owner
   live-test on preview BEFORE merge; measurable before/after telemetry where
   the phase claims a win.

## Current state

- **LG-0 (SHIPPED 2026-07-15, PR #377):** `routine-turn-graph.ts` —
  `detect_intent → run_tool → format_reply` StateGraph for 4 read-only intents
  (sales today, attendance, stock, pending orders). Preview-gated
  (`AGENT_LANGGRAPH_ROUTINE`). Deps: `@langchain/langgraph`, `@langchain/core`.

## LangGraph feature coverage matrix

Every LangGraph capability, where it lands, and why. "Nothing left out."

| LangGraph feature | Phase | ALMA use |
|---|---|---|
| `StateGraph` + `Annotation` state | LG-0 ✅, all | Typed turn state |
| Conditional edges | LG-0 ✅, LG-4 | Routing, correction loops |
| Node `retryPolicy` | LG-1 | Transient tool/provider retries |
| Node `cachePolicy` | LG-5 | Skip repeat sub-task work |
| `recursionLimit` | LG-0 ✅ | Loop runaway guard |
| Streaming (`streamMode`: updates/messages/custom) | LG-4 | Map graph events → existing `AgentEvent` SSE |
| Checkpointers (`langgraph-checkpoint-postgres`) | LG-2 | Durable turn threads on Supabase |
| Threads / `thread_id` | LG-2 | conversationId ↔ thread binding |
| Durability modes (sync/async/exit) | LG-2 | Serverless-safe persistence |
| `interrupt()` + `Command(resume)` | LG-3 | Approval cards, ask-cards |
| Time travel / `getStateHistory` / fork | LG-8 | Replay-debugging + owner "কী হয়েছিল" |
| Subgraphs | LG-5, LG-6 | Specialists + business pipelines |
| `Send` API (map-reduce fan-out) | LG-5 | Parallel workers (batch content, research) |
| `Store` / `BaseStore` (long-term memory) | LG-7 | Adapter over existing pgvector `agent_memories` |
| Functional API (`entrypoint`/`task`) | LG-6 note | Only for small linear jobs; Graph API is the default |
| LangSmith tracing | LG-8 (optional) | Own telemetry is primary; LangSmith only if gaps appear |
| LangGraph Platform (managed deploy) | LG-10 decision | Self-host on Vercel today; revisit criteria below |
| Prebuilt `createReactAgent` | **Skipped** | Our head loop already exceeds it (budgets, verifier, cards); wrapping it would regress owner-specific behaviour |
| Multi-agent "swarm" prebuilts | **Skipped for now** | Supervisor pattern via subgraphs (LG-5) covers the need with less magic |

## Phases

### LG-1 — Routine graph GA + intent expansion (small)
**Goal:** production ON; more fixed lookups run deterministic.
- Add intents from real usage (telemetry + owner list): today's expense summary,
  staff task status ("Eyafi ke ki task dise"), salah times today, pending
  approvals count, customer order status by order number (single slot-fill).
- Per-node `retryPolicy` on `run_tool` (transient `retryable` errors only).
- Telemetry: log a `phase:'route'` span extra `routineGraph: handled|miss` so
  the cost dashboard can show graph-handled share + saved tokens.
- **Gate to close the phase:** 1 week preview soak, then
  `AGENT_LANGGRAPH_ROUTINE=true` in production; owner sees before/after cost.

### LG-2 — Durable turn state: Postgres checkpointer (medium)
**Goal:** a turn that dies (deadline, crash, redeploy) RESUMES instead of
restarting — the checkpoint.ts/tail-salvage class gets a real engine.
- `@langchain/langgraph-checkpoint-postgres` on the existing Supabase DB
  (new additive tables via the project's migration system).
- `thread_id = conversationId` (+ turnId in config metadata).
- Durability mode chosen for serverless: persist BEFORE yielding effects.
- First consumer: the routine graph + LG-6 pilot workflow; the "continue"
  flow reads the thread's last checkpoint instead of a hand-written note.
- **Risk:** checkpoint table growth → TTL/cleanup job from day 1.

### LG-3 — Human-in-the-loop: approval cards as interrupts (medium/high value)
**Goal:** "graph pauses at the exact step → owner taps card → graph resumes at
that step" — replaces the pending-action ↔ turn re-entry plumbing gradually.
- `interrupt()` inside a `stage_action` node; the interrupt payload renders the
  EXISTING confirm-card UI (no UI change); approve/reject routes call
  `Command({ resume })`.
- Ask-cards use the same mechanism (question → interrupt → answer resumes).
- Bridge table: pendingActionId ↔ (thread_id, checkpoint_id).
- **Invariant:** card execute paths keep their server-side guards; interrupt is
  transport, not authorization.

### LG-4 — Head-turn orchestration as a graph (large, the core payoff)
**Goal:** the owner turn itself becomes an explicit graph, retiring the regex
patchwork one edge at a time:
`load_context → guard(deny/call/personal) → triage → select_tools → model_round
 → (tool_exec ⟲) → verify(claim-verifier node) → bangla_gate → persist`.
- Correction loop = conditional edge `verify → model_round` (max 2, counted in
  state) — replaces ADAPTER_ACT_NOW / zero-tool nudges with graph structure.
- Streaming: graph `custom` stream events mapped 1:1 onto today's `AgentEvent`
  union so web + iOS parity code does not change.
- Ship as `AGENT_LANGGRAPH_TURN` shadow mode first (graph decides, legacy
  executes, decisions logged) → canary % → on. Mirrors state-router rollout.
- **This phase absorbs LG-0/1 as the first nodes of the big graph.**

### LG-5 — Sub-agents as subgraphs + Send fan-out (medium)
**Goal:** `delegate_to_specialist` becomes a subgraph call; parallel work uses
`Send` map-reduce instead of sequential loops.
- Specialist subgraphs inherit checkpointing + interrupts automatically.
- `Send` fan-out for: multi-product content batches, multi-source research,
  order-issue scans. Reducer node merges results.
- Node `cachePolicy` on expensive pure steps (research fetch, SEO audit read).
- Tier-router stays the model picker; the subgraph is the execution shell.

### LG-6 — Business workflows as durable graphs (large, staged)
**Goal:** the template state machines in `workflow-run.ts` / playbooks become
checkpointed graphs with interrupts — one workflow at a time:
1. Content pipeline: draft → image → preview-card (interrupt) → post → verify.
2. Client SEO batch (just landed on main) — long multi-step batch = ideal
   checkpoint+resume pilot.
3. Order lifecycle scan; browser recipes (look→act loops with checkpoint every
   step, resume after deadline).
- Long runs execute on the VPS worker (or Vercel Workflows if adopted) with the
  SAME graph code — checkpointer makes the runtime location irrelevant.
- Functional API allowed here for small linear jobs where a graph is overkill.

### LG-7 — Long-term memory via Store adapter (small/medium)
**Goal:** graphs read/write memory through LangGraph's `BaseStore` interface,
backed by a thin adapter over the EXISTING pgvector `agent_memories` (no data
migration, no second memory system).
- Namespaces: (`business`|`personal`, businessId). Semantic search delegates to
  the existing embedding search.
- Head stays the only writer of owner-facing memory (project rule).

### LG-8 — Time travel, replay + evals (medium)
**Goal:** debugging and quality measurement become first-class.
- Owner-facing "এই টার্নে কী হয়েছিল" = `getStateHistory` rendered as steps.
- Replay suite: re-run recorded incident inputs against a forked checkpoint on
  every phase merge (CI) — regressions caught before the owner sees them.
- LangSmith: optional, only if self-telemetry proves insufficient; keep
  spend/telemetry sovereignty by default.

### LG-9 — All surfaces + scheduled duties on graphs (medium)
**Goal:** Telegram/voice turns and heartbeat/day-shift duties run the same
graphs (thread per surface-conversation); scheduled duties = cron-triggered
graph invocations with checkpoints, replacing bespoke duty state where it pays.

### LG-10 — Platform decision checkpoint (decision, not code)
Self-hosting on Vercel + Supabase + VPS remains the default (cost, data
locality, no new vendor). Revisit LangGraph Platform ONLY if we hit: (a)
checkpoint scale pain, (b) need for managed cron/queues beyond VPS, or (c)
multi-instance concurrency the current setup can't serve. Document the
decision either way at this phase.

## Sequence & effort

| Phase | Size | Depends on | Prod gate |
|---|---|---|---|
| LG-1 | S | LG-0 ✅ | 1-week preview soak |
| LG-2 | M | LG-1 | checkpoint tables + cleanup verified |
| LG-3 | M | LG-2 | one card type end-to-end on preview |
| LG-4 | L | LG-2 | shadow → canary → on |
| LG-5 | M | LG-4 | one specialist migrated |
| LG-6 | L (staged) | LG-2/3 | one workflow at a time |
| LG-7 | S/M | LG-2 | read-parity with existing memory |
| LG-8 | M | LG-2 | replay suite green in CI |
| LG-9 | M | LG-4/6 | one surface at a time |
| LG-10 | decision | LG-2+ | written decision |

## Market context (checked 2026-07-15)

- LangGraph.js is the graph engine; checkpointer backends ship separately
  (`langgraph-checkpoint-postgres` fits our Supabase directly).
- Interrupts + Command are the supported HITL primitive; subgraphs inherit
  checkpointing/HITL automatically — exactly the approval-card shape we need.
- Overlap watch: **Vercel Workflows** (GA 2026) also offers durable execution.
  Division of labour: LangGraph = agent/LLM orchestration (state, interrupts,
  model loops); Vercel Workflows/VPS queue = plain long-running compute. Do not
  build the same thing twice.
- **Vercel AI SDK** remains a possible future ADAPTER layer only (provider
  abstraction under graph nodes); not adopted while the current adapters work.
