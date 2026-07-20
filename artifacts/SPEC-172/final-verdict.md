# SPEC-172 Final Verdict
**Verdict: PASS**

runSchemaConstrained / validateOutput: runs a specialist (SPEC-171) and validates its data against a caller zod schema — valid ⇒ COMPLETED with the typed value; off-schema ⇒ RETRYABLE carrying the exact violations (consumed by the repair loop, SPEC-179), never passed through unchecked; a runtime failure propagates unchanged. The head only ever receives conforming data (INV-05/INV-07).
vitest: 5 passed (zone suite green) ; typecheck rc=0 ; forbidden-import gate clean ; rollback drill MATCH ; deterministic (INV-01), fail-closed (INV-05). 10/10 proof artifacts.
