# SPEC-147 test results
- tsc: TSC_EXIT=0. vitest: Test Files 2 passed (2); Tests 21 passed (21) (8 new observation-state cases).
- Cases: secret-label detection; redact+truncate; URL strip; value-drop + secret redact + no token leak; interactivity-priority cap; byte-ceiling OVERSIZE fail-closed; malformed caps; determinism (identical output).
- Note: one test expectation was corrected — a 50-char unbroken alphanumeric label is (correctly) flagged token-shaped by the impl; test now uses spaced natural text.
