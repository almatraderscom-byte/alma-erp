# SPEC-086 — Security proof
A capability can never claim ownership in ERP or a shared choke point
(NOT_AGENT_ZONE / INTEGRATION_ONLY are hard, fail-closed), nor advertise a runtime
surface its tools don't back. `queryRuntimeOwner` returns DENIED on any violation
and enforces identity. Secret scan: none. PASS.
