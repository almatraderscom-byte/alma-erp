# SPEC-058 Contract — Memory privacy
`assertMemoryScope(identity, record)` (fail-closed via G05 guardResourceAccess), `filterAuthorized(identity, hits)`, `toModelView(record)` (text/tags/atMs only — no embedding/ids, INV-07). Rollback: `git revert --no-edit <SPEC-058 commit>`.
