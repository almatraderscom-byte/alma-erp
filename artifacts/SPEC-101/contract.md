# SPEC-101 Contract — Human principal
`PrincipalKind`, `HumanPrincipal {kind:human, tenantId, actorId, roles}`, `humanPrincipal(identity, roles?)`, `humanPrincipalSchema`. Fail-closed on invalid; copies roles. Rollback: `git revert --no-edit <SPEC-101 commit>`.
