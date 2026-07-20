# SPEC-108 Contract — Relationship authorization layer

## Public surface (`src/agent/policy/relationship.ts`)
- `RelationshipLayer implements PolicyLayer` (`name:'relationship'`, `version`) from `RelationTuple[]` + `RelationRequirement[]`.
- `relationshipLayer(tuples, requirements, opts?)` builder; `principalRef(p)` (tenant-free `type:id`); `.relationsBetween(subject, object)`.
- `RelationTuple { subject, relation, object }` (`type:id` refs). `RelationRequirement { actions?, resourceType, permitRelations[], denyRelations? }`.
- `MAX_GROUP_HOPS = 1`. `REL_REASON_CODES`: RELATION_GRANTED, RELATION_DENY, NO_RELATION, NO_RESOURCE_ID.

## Behavior (fail-closed, INV-05)
- Effective relations = direct `(subject,rel,object)` ∪ one hop `(subject,member,group)+(group,rel,object)` (≤ maxGroupHops).
- Deny-relation held → deny. Else permit-relation held → permit (`rel:<name>`). Else abstain. No resource id → abstain.

## Failure / cost / security
- evaluate never throws; construction throws on invalid tuple/requirement (owner-authored, tested).
- Cost: 0 model calls (INV-01). Bounded traversal, deterministic.

## Rollback
`git revert --no-edit <SPEC-108 commit>` — restores exact pre-spec tree.
