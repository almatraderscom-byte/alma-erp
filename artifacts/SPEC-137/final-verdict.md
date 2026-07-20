# SPEC-137 Final Verdict
**Verdict: PASS**

reconcile / reconcileWith (Reconciler seam): turns a provider probe finding into a safe decision — effect_present ⇒ CONFIRMED_DONE, effect_absent ⇒ CONFIRMED_NOT_DONE (safe retry), indeterminate ⇒ RECONCILE_AGAIN with backoff while budget remains else ESCALATE to a human (never guesses). A throwing probe is treated as indeterminate, never as done. This is the core INV-06 mechanism.
vitest: 7 passed (zone suite green) ; typecheck rc=0 ; forbidden-import gate clean ; rollback drill MATCH ; deterministic (INV-01), fail-closed (INV-05). 10/10 proof artifacts.
