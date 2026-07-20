# SPEC-041 Contract — Context compiler
`BUNDLE_ORDER` (constitution<skill<policy<workflow_state<memory<tool_schema<request_suffix), `ContextBundle {id,kind,content,cacheable,version?}`, `compile(bundles, estimator?)` -> `CompiledContext {text,totalTokens,cacheablePrefixTokens,provenance,contractVersion}`. Deterministic. Rollback: `git revert --no-edit <SPEC-041 commit>`.
