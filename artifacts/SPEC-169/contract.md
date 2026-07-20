# SPEC-169 Contract — Head-model tool-loop prohibition
- `MAX_HEAD_TOOL_CALLS = 0` — the head plans, executes zero tools.
- `isHeadInvocation(role, tier)` — true for `role:'head'` OR the frontier tier (T4),
  so a frontier invocation is head-class regardless of label (frontier can never loop).
- `assertNoHeadToolLoop({role, tier, toolCalls})` → `ComponentResult`: head + toolCalls>0
  → `HEAD_TOOL_LOOP_FORBIDDEN`; negative/non-integer → `HEAD_TOOL_LOOP_MALFORMED`.
  Non-frontier workers may run tool loops freely. Deterministic, fail-closed.
