# SPEC-107 Contract — ABAC policy layer

## Public surface (`src/agent/policy/abac.ts`)
- `AbacLayer implements PolicyLayer` (`name:'abac'`, `version`) from `AbacRule[]`; immutable, depth-checked.
- `abacLayer(rules, version?)` builder.
- `resolveAttr(input, path)` — dotted-path resolver over {action, principal, resource, context, identity} + virtual `principal.roles`.
- `evalComparison(actual, op, expected)` — leaf comparators: eq/ne/lt/lte/gt/gte/in/nin/exists/contains.
- Types: `AbacRule { id, effect:'permit'|'deny', actions?, when:Condition }`, `Condition = AttrCondition | {all[]} | {any[]} | {not}`.
- `MAX_CONDITION_DEPTH = 8`. `ABAC_REASON_CODES`: RULE_PERMIT, RULE_DENY, NO_RULE_MATCH, MALFORMED_RULE.

## Behavior (fail-closed, INV-05)
- Applicable rules filtered by `actions` scope. Matching `deny` first → deny (with `rule:<id>`). Else matching `permit` → permit. Else abstain.
- lt/lte/gt/gte on non-numeric operands → no match (never silent true). DSL is data-only — no eval, no LLM.

## Failure / cost / security
- evaluate never throws; construction throws on malformed rule or over-deep tree (owner-authored, tested).
- Cost: 0 model calls (INV-01). Deterministic + bounded.

## Rollback
`git revert --no-edit <SPEC-107 commit>` — restores exact pre-spec tree.
