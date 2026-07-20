# Which Coding Agent to Use

## Recommended operating model

Use **Codex as the multi-agent command center and integration surface** when its built-in worktrees/cloud agents are available. Use **Claude Code for selected deep repository-analysis or complex refactor groups** where you prefer its terminal workflow, subagents and hooks. This is not a claim that one model is universally superior.

Official OpenAI material describes Codex as designed for multi-agent workflows with built-in worktrees and cloud environments. Official Anthropic material documents Claude Code subagents, hooks and parallel sessions with Git worktrees. Both are suitable; correctness here comes primarily from isolation, frozen contracts, tests and proof gates rather than the brand of the coding model.

## Suggested allocation

- Claude Code: G01, G05, G11, G14, G17, G19
- Codex: G02, G03, G04, G07, G08, G09, G10, G12, G13, G15, G16, G18, G20
- Wave integration: preferably a different agent/model from the one that implemented the largest group in that wave.

## Independent review rule

The implementing session must not be the only reviewer. For critical groups G04, G11, G13, G14, G17 and G19, run a second read-only review session before merge.

## Why one session should not execute all 200 specs

Long sessions accumulate stale assumptions, lose proof granularity and make rollback difficult. The Group Runner is intentionally limited to ten tightly related sequential specs. Groups are the unit of parallelism; specs are the unit of proof and commits.
