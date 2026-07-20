# SPEC-123 — Unresolved risks
1. Cross-tenant compares an explicit resourceTenantId; tools that embed a target
   tenant inside free-form args would need that surfaced to resourceTenantId by the
   caller. Convention documented. Severity: low. Critical: 0.
