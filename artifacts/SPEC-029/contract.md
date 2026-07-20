# SPEC-029 Contract — Attribution
`ATTRIBUTION_DIMENSIONS` (tenant/business/actor/agent/workflow/provider/model),
`eventAmount` (actual else estimated), `attributeBy(events, dim)` → sorted rows,
`attributeAll(events, dims?)`. Deterministic. Rollback: `git revert --no-edit <SPEC-029 commit>`.
