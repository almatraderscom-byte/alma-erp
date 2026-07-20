# SPEC-144 test results
- tsc: TSC_EXIT=0. vitest: Test Files 4 passed (4); Tests 41 passed (41) (10 new scheduling cases).
- Cases: comparator (priority/EDF/no-deadline); deterministic prioritized order; tenant-scope; isOverdue; overdueTasks; head+overdue surface; empty fail-closed; malformed nowMs; strict deny stale; strict allow fresh.
