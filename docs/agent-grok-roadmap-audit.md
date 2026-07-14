# Grok 4.20 Architecture Roadmap — Codebase Audit (2026-07-14)

**Audited by:** Claude (deep audit in-repo, commit `d94c199c`)
**Roadmap:** [agent-grok-architecture-roadmap.md](./agent-grok-architecture-roadmap.md) (authored from GPT 5.6 research, audit base `cb48cecb`)
**Verdict: the roadmap is substantially accurate.** Every root-cause finding was re-measured against the live code; most numbers matched exactly. Corrections and nuances below — read them before executing a phase.

## Claim-by-claim verification

| # | Roadmap claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Default owner head ships ~201 tool defs; `base` = 97; xAI 200-cap drops the tail (first-200 kept) | ✅ Exact | `base` = 97 measured; slim-router prod set = 190 + 14 kept-growth − 3 denylist = 201; cap at `run-owner-turn.ts:481-493` (`slice(0, 200)`, x-ai/* only) — its own comment says "the owner head carries 201" |
| 2 | 244 executable owner tools; 0 × `additionalProperties:false`; 183/695 params without description; 95 multi-group tools; 3 executable-but-ungrouped | ✅ Exact (one number off) | Measured: 244, 0, 183/695, 95, 3 (`run_creative_studio`, `check_studio_job`, `request_agent_action`). **Correction:** props-but-no-`required` = **86**, not 73 (roadmap likely counted only schemas missing the key entirely) |
| 2b | `executeTool()` passes model args straight to handlers, no central schema validation | ✅ Confirmed | `registry.ts:589-624` — `tool.handler({ ...input, ...serverContext })`, no Ajv/validation layer anywhere |
| 3 | Prompt contradiction: post pipeline "never delegate" vs marketing "delegate-by-default"; dozens of HARD RULE/NEVER patches | ✅ Confirmed | `system-prompt.ts:422` (post pipeline = head's own work, delegate forbidden, Boss 2026-07-13) vs `:478` (marketing incl. content substance = delegate-by-default, slim-router block, default ON). 28 hard-rule tokens counted |
| 4 | Router reads latest message, not the active job | ✅ Confirmed, with nuance | `selectToolGroupsSync()` takes message text only; no ask-card/approval/checkpoint/plan input anywhere. **Nuance:** in prod the dynamic per-turn selector is OFF by default (`AGENT_DYNAMIC_TOOLSET`, preview-only since 2026-07-08) — prod ships the FIXED 201-tool slim set every turn, so today's failure mode is "all tools + 200-cap truncation", not "wrong pack". The dynamic path (preview) has exactly the text-only routing problem described |
| 5 | No `parallel_tool_calls` / `tool_choice` control | ✅ Confirmed | Zero occurrences of either in `src/agent/lib/models/` |
| 6 | Telemetry can't explain wrong behavior; `verified` never set in normal execution | ✅ Confirmed | `tool-telemetry.ts` records only toolName/success/verified/errorClass/latency/conversation/business; `executeTool` never passes `verified` |
| 7 | Task state fragmented across AgentPlan/AgentPlanStep/AgentOpenTask/checkpoint/AgentPendingAction; no canonical record | ✅ Confirmed | All five exist (`schema.prisma`, `checkpoint.ts`, `open-task.ts`); no `WorkflowRun` model; `resumeNote` prose linking confirmed |
| 8 | Anthropic-style `cache_control` sent to Grok; full→no-reasoning→bare retry ladder; silent cross-model fallback | ✅ Confirmed | `adapters/openai.ts:25` (unconditional `cache_control` on system block), `:164-188` (retry ladder); `run-owner-turn.ts:1092-1113` — head crash before text ⇒ silent fallback to `CHEAP_HEAD_MODEL_ID` (default `or-deepseek-v4-flash`) |
| 9 | Skill packs: five fixed TS packs behind `start_skill_pack`, deterministic completion gates, no general platform | ✅ Confirmed | `skill-packs/packs.ts`: `research`, `seo`, `marketing`, `website`, `client_seo`; `skill-pack-tools.ts` |
| 10 | Existing marketing-head test failure (Phase 0 fix item) | ✅ Confirmed & FIXED in Phase 0 | `select-tools.marketing-head.test.ts` failed: `get_marketing_history` lived only in the `staff` group, marketing head carries `growth` not `staff` — the exact "group drift" the roadmap warns about. Fixed by adding it to `growth` |

## Corrections / decisions the roadmap must respect

1. **Head model wiring (context for "Grok 4.20 remains the head").** The env default is still `gemini-3.1-pro` (`head-router.ts:46`); Grok runs because the owner pins `or-grok-4.20` per conversation via `AgentConversation.modelId` (registry entry added 2026-07-12). CLAUDE.md still documents the Gemini-head decision — when the owner confirms Grok as the standing head, CLAUDE.md and/or `HEAVY_HEAD_MODEL_ID` should be updated together; until then treat "Grok head" as per-conversation, not global.
2. **`required`-less schemas = 86, not 73.** Direction identical, Phase 2 scope slightly larger.
3. **Prod vs preview routing differ today.** Phase 3 ("replace first-200 truncation with intent/state-selected packs") must account for BOTH paths: prod fixed-set and the preview dynamic selector, and must not resurrect the 2026-07-08 cost problem the fixed set was built to avoid (that motivation is dead anyway — Grok/Gemini/DeepSeek heads recorded zero Anthropic-style cache hits; Grok caching is automatic prefix-based).
4. **`cache_control` on OpenRouter is harmless but misleading** — OpenRouter forwards it only to Anthropic models; for Grok it's ignored. Removing it for Grok (Phase 3) is cleanup, not a behavior fix.
5. **Registry lists `or-grok-4.20` at 2M context** — matches OpenRouter's page; xAI's own card says 1M. Roadmap's advice (read live metadata, conservative budget) stands.
6. **Owner rules already in force that the roadmap must not regress:** Bangla-only owner output, "Boss" address (no "Sir"), approval cards for writes/spend, `bangla-output-gate.ts` for customer-facing quality, whole-taka money via `roundMoney`.

## Phase 0 status (this PR)

- ✅ Roadmap + this audit committed to `docs/`.
- ✅ Marketing-head test failure fixed (`get_marketing_history` → `growth` group). Agent suite green: 595/595.
- ✅ `AGENT-ARCH-001`: `src/agent/lib/agent-versions.ts` (prompt/toolManifest/router/workflow version stamps) + additive migration `20260714120000_agent_turn_versions` (`agent_turns.versions JSONB`) + stamped in `createTurn()`.
- ✅ `AGENT-EVAL-001` scaffolding: `src/agent/replay/replay-case.ts` (fixture format + validator + PII tripwires), first incident fixture `rc-0001-continue-must-not-restart-post` (the 2026-07-13 post-pipeline restart), format test in CI, `scripts/export-replay-cases.mjs` (anonymizing draft exporter → git-ignored `fixtures-drafts/`).
- ✅ Baseline tooling: `scripts/agent-baseline-report.mjs` (tool fail rate, p95 latency, per-tool hotspots, turn terminal states, cost/day). Run against prod DB and attach output to the Phase 1 PR.
- ⏳ Remaining Phase 0: export + review 100–200 real replay drafts into `fixtures/` (needs prod `DATABASE_URL`; run the exporter, review each for PII, fill `expected`). Behavior-instruction freeze is a process rule — in force from this commit: **every behavior fix must add/update a replay case first.**

## Recommended phase order (unchanged from roadmap)

Phase 0 (this PR) → 1 Observability → 2 Tool Contract V2 → 3 Grok request controller + router → 4 WorkflowRun → 5 Workflow templates → 6 Prompt compiler + one turn engine → 7 Canary discipline. One phase per session/PR, exit gates as written, plus the corrections above.
