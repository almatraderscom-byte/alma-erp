# SPEC-149 test results
- tsc: TSC_EXIT=0. vitest: Test Files 4 passed (4); Tests 35 passed (35) (8 new hard-stop cases).
- Cases: admit + integer accounting advance; cost-ceiling BUDGET_EXCEEDED (accounting unchanged on stop); spend exactly at ceiling allowed; step-limit STEP_LIMIT; float cost reject; negative cost reject; malformed budget reject; run driven to step exhaustion.
