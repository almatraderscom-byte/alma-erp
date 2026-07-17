# Router-Worker Multi-Agent — Deep Diagnostic & Architecture Blueprint

> Scan of `src/agent/` + `src/app/api/assistant/`. **No code changed** — diagnostic + blueprint only.

---

## 0. Headline findings (read this first)

1. **You already have ~80% of a router-worker multi-agent system built.** A full model
   registry (4 providers), a tier-router, specialist sub-agents, provider adapters
   (Gemini/OpenAI/OpenRouter), and an owner-tunable routing config already exist and are
   **partially live**. This is not a greenfield build — it's a *completion + slimming* job.

2. **Three factual corrections to the request:**
   - **"Claude 3.5 Sonnet" is retired** (EOL Oct 2025) — it will 404. The system already
     uses **`claude-sonnet-4-6`** as the head/default. That is the correct "Head Router".
   - **"Gemini 2.5 Flash" is already wired** as a worker (`or-gemini-2.5-flash-lite` via
     OpenRouter). **Qwen 3.x / DeepSeek V4** are *not yet in the registry* but are a
     2-line add each (OpenRouter slugs) — verify exact slugs on openrouter.ai.
   - **Vercel AI SDK is NOT installed and you do not need it** — you already have an
     equivalent normalized adapter layer. Migrating to it would be a risky rewrite that
     could break your single biggest cost lever (native Claude prompt caching). Details in §4.

3. **Conflict with `CLAUDE.md` locked decisions — flag for your call.** `CLAUDE.md` says:
   *"Model: claude-sonnet-4-6 always… No Haiku routing"* under *"locked decisions — do not
   re-litigate."* The **code already contradicts this** (it has full multi-model routing).
   So either the doc is stale or the decision evolved. Your request is *aligned with the
   code*, not the doc. **Recommend: update `CLAUDE.md` to reflect the router-worker reality
   before proceeding**, so the "locked decision" and the codebase agree.

---

## 1. Existing Setup Discovery — what's built & how it operates

### The model layer (`src/agent/lib/models/`) — already substantial

| File | Role | Status |
|---|---|---|
| `registry.ts` | Model registry: 4 providers (anthropic/google/openai/openrouter), per-model cost, ctx window, caching flag | ✅ live |
| `routing-config.ts` | Owner-tunable allocation in `agent_kv_settings` (no redeploy): light/heavy/critical model ids, Opus cap/threshold | ✅ live |
| `tier-router.ts` | Maps task tiers → models. CRITICAL→Claude (hard-guarded), HEAVY/LIGHT→cheap. OpenRouter→Gemini→Claude fallback | ✅ live (for subagents) |
| `subagent.ts` | Runs a specialist worker on the routed model, scoped tools, returns a summary | ✅ live (when head delegates) |
| `specialist-roles.ts` | 5 worker roles (researcher/analyst/marketer/content/ops) → tool-group subsets + brief | ✅ live |
| `adapters/` (`google.ts`, `openai.ts`, `openrouter.ts`) + `adapter-turn.ts` | Normalized multi-provider tool-calling loop (the "Vercel-AI-SDK-equivalent") | ✅ live |
| `run-owner-turn.ts` | **The live chat entry.** Anthropic head → native `core.ts` (cached); non-Anthropic head → adapter path | ✅ live |
| `opus-gate.ts` | Sonnet→Opus escalation for high-risk/big-money decisions, daily-capped | ⚠️ **built but DORMANT — not called anywhere** |
| `neutral.ts` / `types.ts` | Provider-neutral message/tool format + converters | ✅ live |

### How it currently operates (the real flow)

```
POST /api/assistant/chat
   └─ runOwnerTurn(conversationId, { modelId })          [run-owner-turn.ts]
        ├─ model.provider === 'anthropic'  → runAgentTurn()      [core.ts — native Claude + prompt caching]
        └─ else                            → runAlternateProviderTurn()  [adapter path, NO caching]
              │
              └─ (either path) the HEAD model loads the FULL tool set for the turn
                    and may call `delegate_to_specialist(role, task)`        [orchestrator-tools.ts]
                          └─ runSubAgent(role, task)                          [subagent.ts]
                                ├─ resolveSubagentModel(role)                 [tier-router.ts]
                                │     critical→Claude · heavy/light→OpenRouter/Gemini
                                ├─ worker runs ≤4 iters, ≤2048 tok, SCOPED tools (role.toolGroups)
                                └─ returns a 3-6 line Bangla summary → head
```

**Three crucial truths about the current state:**

- **The "head model" is per-conversation, not a per-message router.** It's whatever
  `AgentConversation.modelId` is (default `claude-sonnet-4-6`). The head does **not** route
  — it does most work itself and *optionally* delegates.
- **The router-worker part is the sub-agent layer**, and it is **model-driven**: the head
  only delegates if Sonnet decides to call `delegate_to_specialist`. There is no forced or
  deterministic routing.
- **The head is heavy, not lightweight.** It loads the **full ~169-tool surface**
  (`OWNER_STABLE_GROUPS` in `select-tools.ts`) every turn. This is the *opposite* of the
  "lightweight Head Router" you want — and it's the main cost driver (§2).

> Net: the *engine* for router-worker exists. What's missing is (a) **slimming the head**
> into an actual router, (b) **wiring the dormant Opus gate**, (c) **adding Qwen/DeepSeek**,
> and (d) **broadening the 5 roles into full domain registries**.

---

## 2. Current Token / Cost Leakage — why a message is ~$0.15–0.20

Measured live this session (your screenshot): `⚡30.0k cache-write → $0.117` on a *single*
message with no tool call. Decoded: **the cost is the prompt prefix being written to cache**,
not the answer. Breakdown of the bloat, by file:

| Source | File | Cost impact |
|---|---|---|
| **Full ~169-tool surface sent every head turn** | `select-tools.ts` → `OWNER_STABLE_GROUPS` (all 14 groups) | ~30–50k tokens of tool JSON in the cached prefix. **The #1 bloat.** |
| **Large static system prompt** | `system-prompt.ts` (`SYSTEM_CORE` + all `*_RULE` blocks + role prompt) | ~big share of the 30k cold-write |
| **Re-send per tool iteration** | `core.ts` / `run-owner-turn.ts` `MAX_TOOL_ITERATIONS` loop | each round-trip re-sends the whole prefix (cache-read if warm, full price if cold) |
| **Reflexive/forced tool calls** | `system-prompt.ts` (salah "mandatory" lines) | *(fixed this session — was ~88% of cost per the reverted commit)* |
| **False-positive verify redos** | `claim-verifier.ts` | *(fixed this session — `করেছি`/`হয়ে গেছে` no longer trigger needless full-turn reruns)* |
| **Non-Claude head = zero caching** | `adapters/*` (`supportsCaching: false`) | if a Gemini/GPT model is the *head*, every turn re-sends full context at full price (no cache reads) |

**Why the router-worker design fixes this directly:** if the head becomes a *slim router*
(tiny prompt + ~10 tools instead of 169), the cached prefix drops from ~30k to a few k →
**cold write ~$0.01–0.02 instead of $0.11**, and warm reads become trivial. Execution tokens
move to cheap workers (GLM/Gemini/Qwen at ~$0.1–0.4/M vs Sonnet $3/M).

---

## 3. Conflict & Context-Loss Prevention — how state passes Head → Worker

### How history/memory is stored

- **Conversation history:** Prisma `AgentMessage` (rows per turn) — loaded fresh each turn
  by the head (`loadHistory` in `core.ts`, `dbRowsToNeutral` in the adapter path).
- **Long-term memory:** `AgentMemory` (pgvector embeddings). Retrieved two ways every head
  turn: **pinned facts** (`loadPinnedMemories`) + **semantic top-k** (`retrieveRelevantMemories`
  in `agent-memory.ts`, ≥0.45 similarity). Injected into the system prompt.
- **Rolling summary:** `AgentConversation.contextSummary` (compaction safety valve).

### How workers get context today (the key design fact)

In `subagent.ts`, a worker is started with **only a self-contained task string**:
```ts
messages = [{ role: 'user', content: args.task }]   // ← no chat history, no memory
```
The worker runs scoped tools, then returns a **summary** to the head. **The head keeps ALL
state; workers are stateless, task-scoped executors.**

**This is the correct pattern and it does NOT cause memory loss — *if the head writes a
complete task brief*.** The failure mode is a *thin* brief (worker lacks a fact the head
had). So context-loss prevention = **make the head pack the brief well**, not give workers
the whole history (which would re-bloat cost and is what we're avoiding).

**Recommended brief contract (head → worker):**
```
task = {
  goal:        "<one-line objective>",
  facts:       "<relevant pinned/memory snippets + snapshot numbers the worker needs>",
  constraints: "<halal/business rules, owner preferences>",
  return:      "<exact shape the head wants back>"
}
```
Workers should never call `save_memory` or owner-facing actions — only the head writes to
memory and confirms actions (preserves the single source of truth + the honesty guard).

> No "conflict" risk between Sonnet and Qwen because they never share live state — the head
> serializes a brief in, the worker serializes a summary out. The only cross-model hazard is
> **output style/quality** (cheap models in Bangla) — already handled by
> `bangla-output-gate.ts` for customer-facing worker output.

---

## 4. Vercel AI SDK — verification & recommendation

**Verified: it is NOT installed.** `package.json` has `@anthropic-ai/sdk@0.104.1`,
`@google/generative-ai@0.24.1`, and `openai@4.104.0` — but **no `ai` / `@ai-sdk/*` packages.**

What you have instead is a **hand-rolled equivalent**: `adapters/` + `neutral.ts` normalize
tool-calling across Anthropic/Google/OpenAI/OpenRouter behind one interface (`adapterFor`,
`streamTurn`, `runAdapterToolLoop`). This is exactly what Vercel AI SDK would give you.

**Recommendation: do NOT migrate to Vercel AI SDK.** Reasons:
- Your **biggest cost lever is native Anthropic prompt caching** (`cache_control`). The
  Anthropic SDK gives you direct control of breakpoints; AI SDK abstracts this and makes
  fine-grained cache placement harder. Losing caching control would *raise* cost.
- You already have a working, tested multi-provider adapter layer. Replacing it is a
  high-risk rewrite of the hottest code path for no new capability.
- The `claude-api` guidance for an Anthropic-primary system is the **official Anthropic SDK**
  (which you use) — not a third-party abstraction.

**Where you *could* selectively adopt AI-SDK-style ideas without the dependency:** none
needed — your adapter layer already covers normalized streaming + tool calls. Keep it.

---

## 5. Execution Plan (phased, build-on-what-exists — no rewrite)

### 5.1 Group the ~169 tools into modular registries

Tools are **already grouped** (`tool-groups.ts`, 14 groups). Map them to clean domain
registries for the router:

| Registry | Existing groups | Worker role |
|---|---|---|
| **Core ERP** | `erp`, `finance` | `analyst` (CRITICAL→Claude) |
| **HR / Staff Mgmt** | `staff` | `ops` (CRITICAL→Claude) |
| **Marketing & Growth** | `growth`, `website` | `marketer` (HEAVY→cheap) |
| **Content / Creative** | `content`, `vision` | `content` (HEAVY→cheap) |
| **Customer Service** | `cs` | *(new role: `cs`)* |
| **Research / Intel** | `growth`/`research` subset | `researcher` (HEAVY→cheap) |
| **System / Self** | `diag`, `cost` | *(new role: `system`, LIGHT)* |
| **Always-on (head)** | `base` minus heavy tools, `salah` | **head only** |

### 5.2 The target routing flow

```
Owner msg ──► HEAD = Claude Sonnet 4.6  (SLIM: base+salah+memory+ask+delegate ≈ 10 tools)
                │  small cached prefix → ~$0.01–0.02/msg
                │
                ├─ trivial Q (greeting/recall) ─► answer directly from injected context
                │
                ├─ domain task ─► delegate_to_specialist(role, brief)
                │        ├─ Core ERP / HR  → analyst/ops   → Claude (CRITICAL tier)
                │        ├─ Marketing/Content/Research → marketer/content/researcher
                │        │                                  → Qwen 3.x / Gemini Flash / GLM (cheap)
                │        └─ worker returns summary ─► head synthesizes & replies
                │
                └─ high-risk / ≥৳20k decision ─► Opus gate (wire it up) ─► Opus 4.8 (rare, capped)
```

### 5.3 Step-by-step (each step = one reviewable PR, behind a flag)

1. **Update `CLAUDE.md`** to record the router-worker decision (resolve the locked-decision
   conflict) — *governance first.*
2. **Add Qwen 3.x Max + DeepSeek V4** to `registry.ts` as OpenRouter entries (verify slugs);
   point `heavyModelId`/`lightModelId` at them via KV (no redeploy). *Low risk.*
3. **Slim the head's tool set** — give the head a `router` tool profile (base + salah + memory
   + ask + confirm + `delegate_to_specialist`), not all 14 groups. This is the **biggest cost
   win** and the core of "lightweight Head Router". *Behind a flag; A/B vs current.*
4. **Broaden roles** in `specialist-roles.ts`: add `cs` and `system` roles; ensure every
   domain registry maps to a role. *Additive.*
5. **Strengthen the task-brief contract** (§3) in `orchestrator-tools.ts` so the head always
   packs facts/constraints/return-shape → prevents worker context loss.
6. **Wire the dormant Opus gate**: call `decideCriticalModel()` on high-risk/big-money turns
   so escalation actually happens (capped). *Activates built code.*
7. **Keep the head on Claude (native caching)**; workers stay on the adapter path. Never put
   the *head* on a non-caching provider.
8. **Observability**: per-message, show head-model + each worker (role/model/cost) — extend
   the tool-count UI added this session. Confirms savings live.

### 5.4 Expected outcome

- **Head cost/msg: ~$0.11 → ~$0.01–0.02** (slim cached prefix).
- **Execution on workers at ~$0.1–0.4/M** instead of Sonnet $3/M.
- **Quality preserved** on CRITICAL paths (ERP/HR/finance stay on Claude, hard-guarded).
- **Owner-tunable** entirely from KV (which model per tier, Opus cap) — no redeploys.

---

## 6. Risks & honest caveats

- **Cheap-model quality in Bangla** (Qwen/DeepSeek): test customer-facing output; the
  `bangla-output-gate` helps but isn't a guarantee. Keep customer-facing → Claude initially.
- **Latency**: head→worker adds a hop. Fine for tasks, bad for trivial Qs — so the head must
  answer trivial things itself (don't over-route).
- **Slimming the head is the high-leverage but highest-care change** (it's the hot path). Do
  it behind a flag with side-by-side cost comparison before defaulting it on.
- **OpenRouter is a single point of failure** for workers — the existing
  `fallbackModelForTier` (→ native Gemini → Claude) must stay.

> Next step is yours: approve the plan (and the `CLAUDE.md` update), and I'll start at
> **Step 2** (add models — lowest risk) → **Step 3** (slim head — biggest win), one flagged
> PR at a time, each verified before the next.

---

## Appendix — Meta Ads MCP module (`src/agent/lib/meta-mcp/`, phases MA1–MA4)

The agent is an **MCP client** of Meta's official Ads MCP server
(`https://mcp.facebook.com/ads`). It reuses the repo's own MCP wire knowledge
(`src/app/api/assistant/mcp/route.ts` is an MCP *server*) in reverse.

- **`oauth.ts`** — OAuth 2.1: RFC 9728/8414 discovery (metadata URL is
  **path-aware**: `/.well-known/oauth-authorization-server/ads`), app-id client
  (dynamic registration is refused for third parties), PKCE, token refresh,
  scope tiers (`meta_mcp_scope_tier` read|write|financial), kill switch
  (`META_MCP_ENABLED` env + `meta_mcp_enabled` kv), budget cap
  (`meta_mcp_max_daily_budget`).
- **`client.ts`** — Streamable HTTP JSON-RPC: initialize → tools/list | tools/call,
  20s timeout, one bounded retry, one 401 refresh-replay, SSE-or-JSON parsing.
- **`bridge.ts`** — wraps each remote tool as a normal `AgentTool` (prefix
  `meta_`), so ALL existing discipline applies (contract validation, approval
  cards, claim-verifier, telemetry). 23 read tools registered (MA1);
  capability map covers all remote write tools too.
- **`insights-source.ts`** (MA2) — the marketing brain's single ad-insights
  entry point: **MCP-preferred, Graph-API fallback**, and it ALWAYS returns the
  source it actually used + a quote-ready label + degradedReason. Provenance
  travels with the data, so the head cannot misattribute a source.
- **`meta-ads-write-tools.ts`** (MA3) — 6 money-touching write tools, each
  triple-gated (kill switch + connection + write tier) and staged behind an
  owner approval card; `ads_activate_entity` is a separate before_execute 🔴
  card. Executed by `actions/[id]/approve/route.ts` (`meta_ads:*` branch).
- **`health.ts`** (MA4) — telemetry aggregation (call counts / success rate /
  last-success from `AgentToolEvent`) surfaced on the status route + growth
  card, plus a throttled owner ntfy on auth expiry.

**What stays on the Graph API (deliberately, per plan §7):** page posting,
Messenger/CS ingest, boost-post, custom audiences, CAPI, ad library. Insight and
catalog reads prefer MCP via `insights-source.ts` and fall back to Graph.

**Live status (2026-07):** Meta's MCP is per-account **rollout-gated**
(`is_ads_mcp_enabled: false` on the owner's accounts today), so MCP insights and
writes fall back to / wait on Graph. `fb-token-health` scope is therefore
**unchanged** — Graph still serves every ads path; revisit the scope only after
Meta enables the account and the MCP reads/writes prove out live.
