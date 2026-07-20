# SPEC-143 test results
- tsc: TSC_EXIT=0. vitest: Test Files 3 passed (3); Tests 31 passed (31) (8 new concurrency cases).
- Cases: in-flight counting; admit with headroom; domain backpressure + retry hint; tenant backpressure; malformed limits; missing tenant; enqueue below ceiling; enqueue QUEUE_FULL + retry hint.
