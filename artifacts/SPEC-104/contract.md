# SPEC-104 Contract — Credential principal + union
`CredentialPrincipal {kind:credential, tenantId, credentialId, scopes}`, `Principal` union (all 4), `principalKey(p)` (tenant-scoped), `principalRoles(p)` (scopes for credentials). Fail-closed. Rollback: `git revert --no-edit <SPEC-104 commit>`.
