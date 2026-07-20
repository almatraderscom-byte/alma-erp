# SPEC-155 Unresolved Risks
1. `budgetsFor` (which budget scopes apply) is supplied by the caller/G17 wiring;
   the port enforces whatever set it is given (fail-closed on empty via governor).
2. Durable budget store is a G04 seam; tests use `InMemoryBudgetStore`.
No unresolved **critical** risks. Count: 0.
