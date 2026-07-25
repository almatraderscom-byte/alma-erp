# Universal Server-Side Tool Selection

**One promise:** the head model decides *who thinks*, never *which tools exist*.
Ask the same question with Grok, Gemini, Qwen, DeepSeek or Claude as the head and
the server hands each of them the same relevant tool pack — plus `find_tool`, so
the whole 300+ registry is always exactly one hop away.

This is the shape the industry converged on (Anthropic's Tool Search Tool, Tool
RAG): ship a small relevant pack, search for the long tail at runtime. ~80% of it
already existed in this repo (state router ≤24 tools, `find_tool`, head diet);
this program joined the pieces into one pipeline and fixed the four real bugs
that made the tool set depend on the model.

## What was wrong

| # | Bug | Symptom the owner saw |
|---|-----|-----------------------|
| A | The system prompt was built from the **pre-filter** tool list while the model received the **post-filter/post-cap** list | Prompt taught a tool that was never shipped → the head called it → `unknown_tool` |
| B | The xAI 200-tool cap was a blind `slice(0, 200)` computed over the static list only | Silent truncation of whatever sat at the array tail; `find_tool` loads could push the request back over the cap |
| C | The Gemini adapter sanitised its schemas; the OpenAI/xAI/OpenRouter adapter passed ours through raw | "The same tool" behaved differently per provider |
| D | Nothing checked that an executed tool was one the model had actually been given | A hallucinated name reached the registry and came back as a bare failure the head reported as "this capability doesn't exist" |
| I | `CORE_PACK` had **no `find_tool`** | On a routed turn, anything outside the ≤24 pack was unreachable — the head could only say "tool নেই" |

Plus six places where the tool set diverged purely by model: the xAI cap,
`supportsTools:false`, the marketing tier bypassing the router with ~150 schemas,
the round budget existing only for Anthropic heads, explicit pins getting a
"delegate!" instruction with no delegate tool, and the sub-agents having neither
diet nor cap.

## What shipped

| Phase | Change | Files |
|-------|--------|-------|
| 0 | Route-span telemetry: `promptToolCount` / `shippedToolCount` / `promptToolMismatch` / `capTrimmed` / `membershipGate` / `universalPipeline`. Two CI guardrail suites. | `run-owner-turn.ts`, `tool-cap-invariants.test.ts`, `schema-portability.test.ts` |
| 1 | `find_tool` in `CORE_PACK`; `assemblePack` drains matched packs **round-robin** so the trim never starves the pack the message actually asked for. | `state-router.ts` |
| 2 | The whole filter → controls-gate → cap pipeline runs **before** the prompt; prompt and model read one list. | `run-owner-turn.ts` |
| 3 | Membership gate before `executeTool` — an unshipped name is refused with a `find_tool` redirect instead of a dead end. | `run-owner-turn.ts` |
| 4 | `narrowToolsToCap`: relevance-ordered trim (core + `find_tool` + intent packs survive), dynamic headroom, every trimmed name logged. | `head-tool-cap.ts` |
| 5 | `sanitizeSchemaPortable` on the OpenAI-compatible path — normalising, not lossy; deterministic key order for prefix-cache stability. | `adapters/portable-schema.ts`, `adapters/openai.ts` |
| 6 | Marketing head joins the router (packs pre-seeded, no delegation); delegation note only ships when `delegate_to_specialist` really does; round budget from registry `costTier`; honest note when a model can't use tools. | `state-router.ts`, `system-prompt.ts`, `registry.ts`, `run-owner-turn.ts` |
| 7 | Specialist sub-agents get a role pack + `find_tool`, capped at 40 (was 106–234 schemas), and can now load a schema mid-run after a `find_tool` hit. | `specialist-roles.ts`, `subagent.ts`, `adapter-turn.ts` |
| 8 | `core.ts` (native Claude loop) marked `@deprecated` — a second implementation that does not join this pipeline. No behaviour change. | `core.ts` |

## Expected saving

| State | Schemas | Tokens/round |
|---|---|---|
| Diet off (historical) | ~201 | 38–47k |
| Diet (most turns today) | ≤82 | ~17k |
| **Routed (target)** | **≤24** | **~5k** |

Routed turns cut the tool-schema cost ~70% against the diet; a marketing turn
~83% (≈150 schemas → ≤24). Specialist hops drop ~80% (measured: researcher
191 → 36, marketer 234 → 40, seo 200 → 29). Packs stay byte-stable per pack
combination, so prefix-cache hits are preserved.

## Rollout

Correctness fixes are **ON by default** (`AGENT_PROMPT_TOOL_TRUTH`,
`AGENT_RELEVANCE_CAP`, `find_tool` in core, round-robin packs). Everything that
changes *behaviour* is preview-on / production-off until the owner flips it:
`AGENT_OPENAI_SCHEMA_SANITIZE`, `AGENT_UNIVERSAL_TOOL_PIPELINE`,
`AGENT_SUBAGENT_TOOL_TRIM`. The membership gate enforces on preview and
**shadow-logs** in production. Every flag is documented in `.env.example`.

Deeper fallbacks that predate this work still apply: `AGENT_STATE_ROUTER`
(`off | shadow | canary:N | true`), `AGENT_HEAD_TOOL_DIET=false`,
`AGENT_HEAD_PARITY=off`.

## Monitoring

Query `agent_tool_events` where `phase='route'`:

- `detail.promptToolMismatch` → must be `null` (Bug A closed). Non-null means
  someone flipped `AGENT_PROMPT_TOOL_TRUTH=off`.
- `errorClass='membership_gate'` → hallucinated tool calls, per model. Read this
  before promoting the gate from `shadow` to `on` in production.
- `detail.capTrimmed` → should be ~empty; when it isn't, the names are listed.
- `detail.router='state'` share, including on marketing turns.

## Tests

- `tool-cap-invariants.test.ts` — every pack/diet name resolves; no combination
  exceeds 24; `find_tool` survives every trim; the relevance cap keeps the
  relevant tool and reports every drop.
- `schema-portability.test.ts` — registry schema strictness ratchets (the
  allowlists may only shrink); the sanitiser is idempotent, byte-stable, and
  changes no argument contract.
- `universal-pipeline.golden.test.ts` — **the headline guarantee**: the same
  query yields identical tool names on heavy / light / explicit; every tier ships
  ≤24 tools with `find_tool`; the ads question reaches `recommend_ad_actions` on
  every tier (the "ads tool nai" incident); marketing's divergence is the
  documented owner rule, and reverts when the flag is off.
- `universal-pipeline-flags.test.ts` — the rollout ladder, the sub-agent trim,
  and the delegation-note truth condition.
