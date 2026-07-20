# SPEC-091 — Security proof
Retrieval is permission-scoped via the G09 resolver: an actor never retrieves tools
of a capability it is not permitted for (test: customer on finance → resolved
false). Fail-closed: an unresolved intent DENIES rather than falling back to the
full surface. `retrieveTools` enforces identity and never throws. Secret scan: none.
PASS.
