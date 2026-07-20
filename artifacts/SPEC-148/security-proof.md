# SPEC-148 security proof
- Wedge/DoS defense: unbounded replanning and non-progress loops are hard-stopped fail-closed (REPLAN_LIMIT / STALLED), preventing a browser task from spinning indefinitely (cost + resource exhaustion).
- Deterministic: no RNG in the stop decision — a loop is detected identically on replay.
- No secret surface (opaque signatures only).
