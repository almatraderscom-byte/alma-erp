# SPEC-118 Final Verdict
**Verdict: PASS**

resolveUsable / isUsable / consumeApproval / revoke: a valid grant is usable only while live, un-revoked (revocation effective at/before now), and un-consumed; consumeApproval mints a single-use consumption record and a second attempt with it fails (no replay). Expiry/revocation/consumption all fail closed.
vitest: 10 passed (zone suite green) ; typecheck rc=0 ; forbidden-import gate clean ; rollback drill MATCH ; deterministic (INV-01), fail-closed (INV-05). 10/10 proof artifacts.
