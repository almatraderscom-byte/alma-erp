# SPEC-149 cost before/after
This IS the browser cost control. Adds zero cost itself; it caps a run's spend at `costCeilingNanoUsd` and its actions at `maxSteps`. Before: unbounded per-run spend possible; After: spend strictly <= ceiling, steps strictly <= cap. Integer nano-USD accounting; no float drift. Outcome rate 35/35.
