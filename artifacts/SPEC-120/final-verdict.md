# SPEC-120 Final Verdict
**Verdict: PASS**

runAutonomyFailClosedSuite / certifyAutonomyFailClosed: wires the WHOLE G12 stack (policy→autonomy engine w/ all 4 rules→approval contract→SoD→lifecycle) and drives 21 adversarial invariants (big/unknown/float money never autonomous, policy-denied never approved, self/agent/cross-tenant/no-role approver rejected, expired/revoked/consumed/replayed grants not usable, unclassified⇒approval), each computed by executing the stack (INV-10). A thrown error counts as a failure.
vitest: 3 passed (zone suite green) ; typecheck rc=0 ; forbidden-import gate clean ; rollback drill MATCH ; deterministic (INV-01), fail-closed (INV-05). 10/10 proof artifacts.
