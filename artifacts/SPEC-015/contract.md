# SPEC-015 Contract — Intent adapter
`IntentClass` (command/question/task/chitchat/unknown), `IntentAdapter` seam,
`deterministicIntentAdapter` (default, via=deterministic), `classifyIntent`,
`intentStage`. No unbounded model call. Rollback: `git revert --no-edit <SPEC-015 commit>`.
